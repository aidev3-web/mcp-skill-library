import { spawn } from 'node:child_process';

const GH_NOT_FOUND_MSG =
  'GitHub CLI ("gh") is not installed or not on PATH. Install it from https://cli.github.com/, ' +
  'then run "gh auth login" and try again.';

// Runs `gh <args>`, feeding `input` on stdin if given. Never throws for a
// non-zero exit — callers decide what a given exit code means (a 404 is a
// normal "not found" for tryGetBranchHead, not an error). Only a genuinely
// missing `gh` binary rejects, since every caller needs the same fix for that.
function spawnGh(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject); // ENOENT etc. translated centrally in runGh
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

// Swappable seam for tests (no `gh` binary or real network needed) — see
// __setGhRunner. Production code always goes through spawnGh.
let ghRunner = spawnGh;

// Test-only: replace how `gh` invocations are executed, or pass no argument
// to restore the real spawn-based runner. Not used by any production path.
export function __setGhRunner(fn) {
  ghRunner = fn || spawnGh;
}

// Translates a missing `gh` binary into one clear, actionable message no
// matter which runner produced the error (real spawn or a test double).
async function runGh(args, opts) {
  try {
    return await ghRunner(args, opts);
  } catch (err) {
    if (err && err.code === 'ENOENT') throw new Error(GH_NOT_FOUND_MSG);
    throw err;
  }
}

// Call once at the start of any tool that talks to GitHub. Cached for the
// life of the process so repeated calls don't re-shell-out to `gh` — this
// only needs to catch "gh missing" / "not logged in" once, at whichever
// moment the first real GitHub call would otherwise have failed confusingly.
let readyCheck = null;
export function ensureGhReady() {
  if (!readyCheck) {
    readyCheck = (async () => {
      const version = await runGh(['--version']);
      if (version.code !== 0) throw new Error(GH_NOT_FOUND_MSG);
      const status = await runGh(['auth', 'status']);
      if (status.code !== 0) {
        // A leftover GITHUB_TOKEN/GH_TOKEN env var (e.g. from this project's
        // old token-based setup) makes `gh` use that instead of a real
        // `gh auth login` session, even when one exists — confirmed on a real
        // machine that still had the old env var set. This is `gh`'s own
        // documented precedence, not a bug in this server, but it's the most
        // likely reason `gh auth status` fails on a machine that used to run
        // this project's previous, token-based version.
        if (/using token \((GITHUB_TOKEN|GH_TOKEN)\)/i.test(status.stderr) && (process.env.GITHUB_TOKEN || process.env.GH_TOKEN)) {
          throw new Error(
            'GitHub CLI sees a GITHUB_TOKEN (or GH_TOKEN) environment variable and is trying to use that instead of ' +
              'your "gh auth login" session — and that token is invalid/expired. If this machine used to run an ' +
              'older, token-based version of this server, remove that leftover env var (unset it, or delete it from ' +
              'this MCP server\'s config if it\'s set there) and try again.',
          );
        }
        throw new Error(
          'GitHub CLI is installed but not logged in. Run "gh auth login" (browser or token flow) and try again.',
        );
      }
    })().catch((err) => {
      readyCheck = null; // let a retry re-check rather than caching a stale failure
      throw err;
    });
  }
  return readyCheck;
}

async function ghApi(path, { method = 'GET', body } = {}) {
  const args = ['api', path, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'];
  if (method !== 'GET') args.push('-X', method);
  if (body !== undefined) args.push('--input', '-');
  const { code, stdout, stderr } = await runGh(args, {
    input: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (code !== 0) {
    const statusMatch = stderr.match(/HTTP (\d{3})/);
    const httpStatus = statusMatch ? Number(statusMatch[1]) : null;
    const detail = (stderr || stdout || '').trim().slice(0, 300);
    let message = `gh api ${method} ${path} failed: ${detail}`;
    if (httpStatus === 404) {
      message = `GitHub API ${method} ${path} -> 404: ${detail}`;
    } else if (httpStatus === 403 && method !== 'GET') {
      message =
        `GitHub API ${method} ${path} -> 403: ${detail} ` +
        `(this write needs Contents: Write on this repo, or you may not be a collaborator on it — ask an admin to add you)`;
    } else if (httpStatus === 403) {
      message = `GitHub API ${method} ${path} -> 403: ${detail} (you may not be a collaborator on this repo — ask an admin to add you)`;
    }
    const err = new Error(message);
    err.httpStatus = httpStatus;
    throw err;
  }
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

export async function getDefaultBranch(owner, repo) {
  const data = await ghApi(`/repos/${owner}/${repo}`);
  return data.default_branch;
}

// One call returns the FULL recursive tree (all paths in the repo at that ref).
export async function getRecursiveTree(owner, repo, ref) {
  const data = await ghApi(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  return { sha: data.sha, tree: data.tree, truncated: Boolean(data.truncated) };
}

export async function getBlobText(owner, repo, sha) {
  const data = await ghApi(`/repos/${owner}/${repo}/git/blobs/${sha}`);
  return Buffer.from(data.content, data.encoding || 'base64').toString('utf8');
}

export async function getAuthenticatedUser() {
  const data = await ghApi('/user');
  return { login: data.login, name: data.name ?? null, email: data.email ?? null };
}

export async function getBranchHead(owner, repo, branch) {
  const data = await ghApi(`/repos/${owner}/${repo}/git/ref/${encodeURIComponent('heads/' + branch)}`);
  return data.object.sha;
}

// Returns null instead of throwing when the branch simply doesn't exist yet
// (404) — any other error (not a collaborator, rate limit, repo not found)
// still throws.
export async function tryGetBranchHead(owner, repo, branch) {
  try {
    return await getBranchHead(owner, repo, branch);
  } catch (err) {
    if (err.httpStatus === 404) return null;
    throw err;
  }
}

export async function createBranch(owner, repo, branch, fromSha) {
  await ghApi(`/repos/${owner}/${repo}/git/refs`, {
    method: 'POST',
    body: { ref: `refs/heads/${branch}`, sha: fromSha },
  });
}

export async function createBlob(owner, repo, base64Content) {
  const data = await ghApi(`/repos/${owner}/${repo}/git/blobs`, {
    method: 'POST',
    body: { content: base64Content, encoding: 'base64' },
  });
  return data.sha;
}

export async function createTree(owner, repo, baseTreeSha, entries) {
  const data = await ghApi(`/repos/${owner}/${repo}/git/trees`, {
    method: 'POST',
    body: { base_tree: baseTreeSha, tree: entries },
  });
  return data.sha;
}

export async function createCommit(owner, repo, message, treeSha, parentSha) {
  const data = await ghApi(`/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    body: { message, tree: treeSha, parents: [parentSha] },
  });
  return data.sha;
}

export async function updateRef(owner, repo, branch, newCommitSha) {
  // force:false — GitHub itself rejects a non-fast-forward move, a second
  // line of defense on top of index.js's own pre-write head-sha re-check.
  await ghApi(`/repos/${owner}/${repo}/git/refs/${encodeURIComponent('heads/' + branch)}`, {
    method: 'PATCH',
    body: { sha: newCommitSha, force: false },
  });
}
