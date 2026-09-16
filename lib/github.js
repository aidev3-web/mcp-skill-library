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

// Call once at the start of any tool that talks to GitHub. Cached so repeated
// calls don't re-shell-out to `gh` — but only for READY_TTL_MS, because `gh
// auth logout` (or a token expiring) mid-session would otherwise leave this
// reporting "ready" for the life of the process.
const READY_TTL_MS = 5 * 60 * 1000;
let readyCheck = null;
let readyCheckedAt = 0;
export function ensureGhReady() {
  if (readyCheck && Date.now() - readyCheckedAt > READY_TTL_MS) readyCheck = null;
  if (!readyCheck) {
    readyCheckedAt = Date.now();
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

// GitHub's own charset for an owner or repo name. Every API path below is
// built by string interpolation, so anything outside this set (a slash, a
// "..", a query separator) could reshape the request path — validate once,
// here, rather than trusting each caller.
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

function repoPath(owner, repo) {
  if (!NAME_RE.test(String(owner)) || !NAME_RE.test(String(repo))) {
    throw new Error(
      `Invalid GitHub owner/repo "${owner}/${repo}" — only letters, digits, ".", "_" and "-" are allowed in each part.`,
    );
  }
  return `/repos/${owner}/${repo}`;
}

export async function getDefaultBranch(owner, repo) {
  const data = await ghApi(repoPath(owner, repo));
  return data.default_branch;
}

// One call returns the FULL recursive tree (all paths in the repo at that ref).
export async function getRecursiveTree(owner, repo, ref) {
  const data = await ghApi(`${repoPath(owner, repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  return { sha: data.sha, tree: data.tree, truncated: Boolean(data.truncated) };
}

// Raw bytes, never decoded — a skill folder can legitimately hold images,
// PDFs or fonts, and round-tripping those through a utf8 string replaces
// every non-UTF8 byte with U+FFFD (silently corrupting the file on pull).
export async function getBlobBytes(owner, repo, sha) {
  const data = await ghApi(`${repoPath(owner, repo)}/git/blobs/${sha}`);
  return Buffer.from(data.content, data.encoding || 'base64');
}

// Text convenience wrapper for the callers that genuinely want a string
// (frontmatter parsing, .meta.json) — never use this to write a file.
export async function getBlobText(owner, repo, sha) {
  return (await getBlobBytes(owner, repo, sha)).toString('utf8');
}

// GitHub's code search — unlike getRecursiveTree, this reaches across every
// public repo on GitHub, not just one you name. Same "gh" auth as everything
// else here (no separate API key). GitHub applies a much tighter rate limit
// to this endpoint (10 req/min for an authenticated user) than the REST API
// used elsewhere in this file — callers should not poll it in a loop.
export async function searchCode(query, { perPage = 20, page = 1 } = {}) {
  // filename: qualifier narrows the search server-side to Agent Skill
  // manifests before the free-text query is applied, so a broad query
  // ("automate deploys") doesn't have to scan every file on GitHub.
  const q = `filename:SKILL.md ${query}`;
  const data = await ghApi(`/search/code?q=${encodeURIComponent(q)}&per_page=${perPage}&page=${page}`);
  return { totalCount: data.total_count ?? 0, items: data.items ?? [] };
}

// GitHub caps code search at 1000 retrievable results no matter how large
// total_count looks, so asking for a page past that is a guaranteed 422.
export const CODE_SEARCH_MAX_RESULTS = 1000;

// Reads the current quota for one resource bucket. Per GitHub's docs this
// endpoint does not itself consume any quota, which is what makes it safe to
// call from an error handler — the point is to turn "403" into "wait 43s".
// Returns null rather than throwing: this only ever decorates an error
// message, and a failure here must not replace the real error with its own.
export async function getRateLimitStatus(resource = 'code_search') {
  try {
    const data = await ghApi('/rate_limit');
    const r = data?.resources?.[resource];
    if (!r) return null;
    const secondsUntilReset = Math.max(0, Math.round(r.reset - Date.now() / 1000));
    return { limit: r.limit, remaining: r.remaining, reset: r.reset, secondsUntilReset };
  } catch {
    return null;
  }
}

// True for the errors that mean "you are going too fast", as opposed to the
// other things GitHub also answers 403 for (private repo, missing scope).
export function isRateLimitError(err) {
  if (err?.httpStatus !== 403 && err?.httpStatus !== 429) return false;
  return /rate limit|secondary rate|abuse detection|too many requests/i.test(String(err?.message || ''));
}

export async function getAuthenticatedUser() {
  const data = await ghApi('/user');
  return { login: data.login, name: data.name ?? null, email: data.email ?? null };
}

export async function getBranchHead(owner, repo, branch) {
  const data = await ghApi(`${repoPath(owner, repo)}/git/ref/${encodeURIComponent('heads/' + branch)}`);
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
  await ghApi(`${repoPath(owner, repo)}/git/refs`, {
    method: 'POST',
    body: { ref: `refs/heads/${branch}`, sha: fromSha },
  });
}

// ---------------------------------------------------------------------------
// Fork + pull-request flow.
//
// The shared skill library is a PUBLIC repo that the people pushing to it are
// deliberately NOT collaborators on — read-only to everyone but the admins.
// So a push can never write to the upstream repo at all (not even to a feature
// branch: creating a ref is a write). The only route in is the standard GitHub
// outside-contributor flow: fork the repo under your own account, push the
// branch there, and open a pull request from your fork back to upstream.
//
// Everything below therefore splits cleanly in two: upstream calls are always
// reads, fork calls are the only writes.
// ---------------------------------------------------------------------------

// Returns the authenticated user's fork of owner/repo, or null if they don't
// have one yet. Also returns a repo that merely SHARES the name but is not a
// fork of this upstream (mismatch !== null) — pushing into that would silently
// scribble into an unrelated project, so the caller has to refuse rather than
// guess.
export async function getFork(forkOwner, upstreamOwner, upstreamRepo) {
  let data;
  try {
    data = await ghApi(repoPath(forkOwner, upstreamRepo));
  } catch (err) {
    if (err.httpStatus === 404) return null;
    throw err;
  }
  const upstreamFullName = `${upstreamOwner}/${upstreamRepo}`.toLowerCase();
  const parentFullName = data.parent?.full_name?.toLowerCase() ?? null;
  if (!data.fork || parentFullName !== upstreamFullName) {
    return { mismatch: data.full_name, fullName: data.full_name, defaultBranch: data.default_branch };
  }
  return { mismatch: null, fullName: data.full_name, defaultBranch: data.default_branch };
}

// GitHub creates a fork ASYNCHRONOUSLY — the POST returns 202 with the repo
// stub before the repo is actually usable, and a write against it in that
// window fails with a confusing 404. So poll until the fork answers a plain
// read, and give up with a clear message rather than hanging forever.
export async function createFork(upstreamOwner, upstreamRepo, { attempts = 10, delayMs = 3000 } = {}) {
  const created = await ghApi(`${repoPath(upstreamOwner, upstreamRepo)}/forks`, { method: 'POST', body: {} });
  const forkOwner = created.owner.login;
  for (let i = 0; i < attempts; i++) {
    try {
      const data = await ghApi(repoPath(forkOwner, upstreamRepo));
      return { fullName: data.full_name, owner: forkOwner, defaultBranch: data.default_branch };
    } catch (err) {
      if (err.httpStatus !== 404) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(
    `Forked ${upstreamOwner}/${upstreamRepo} but the fork was still not readable after ` +
      `${attempts} tries (~${Math.round((attempts * delayMs) / 1000)}s). GitHub is probably still creating it — ` +
      `wait a moment and run the same push again.`,
  );
}

// An open PR from this exact fork branch, or null. `head` is GitHub's
// "<fork owner>:<branch>" cross-repo form, which is what makes this a
// per-skill lookup rather than a scan of every open PR.
export async function findOpenPull(upstreamOwner, upstreamRepo, forkOwner, branch) {
  const head = `${forkOwner}:${branch}`;
  const data = await ghApi(
    `${repoPath(upstreamOwner, upstreamRepo)}/pulls?state=open&head=${encodeURIComponent(head)}&per_page=1`,
  );
  const pr = Array.isArray(data) ? data[0] : null;
  return pr ? { number: pr.number, url: pr.html_url, title: pr.title } : null;
}

export async function createPull(upstreamOwner, upstreamRepo, { title, head, base, body }) {
  const data = await ghApi(`${repoPath(upstreamOwner, upstreamRepo)}/pulls`, {
    method: 'POST',
    body: { title, head, base, body, maintainer_can_modify: true },
  });
  return { number: data.number, url: data.html_url };
}

export async function createBlob(owner, repo, base64Content) {
  const data = await ghApi(`${repoPath(owner, repo)}/git/blobs`, {
    method: 'POST',
    body: { content: base64Content, encoding: 'base64' },
  });
  return data.sha;
}

export async function createTree(owner, repo, baseTreeSha, entries) {
  const data = await ghApi(`${repoPath(owner, repo)}/git/trees`, {
    method: 'POST',
    body: { base_tree: baseTreeSha, tree: entries },
  });
  return data.sha;
}

export async function createCommit(owner, repo, message, treeSha, parentSha) {
  const data = await ghApi(`${repoPath(owner, repo)}/git/commits`, {
    method: 'POST',
    body: { message, tree: treeSha, parents: [parentSha] },
  });
  return data.sha;
}

export async function updateRef(owner, repo, branch, newCommitSha) {
  // force:false — GitHub itself rejects a non-fast-forward move, a second
  // line of defense on top of index.js's own pre-write head-sha re-check.
  await ghApi(`${repoPath(owner, repo)}/git/refs/${encodeURIComponent('heads/' + branch)}`, {
    method: 'PATCH',
    body: { sha: newCommitSha, force: false },
  });
}
