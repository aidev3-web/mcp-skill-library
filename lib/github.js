const API = 'https://api.github.com';

async function ghFetch(path, token, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
      const resetAt = new Date(Number(res.headers.get('x-ratelimit-reset')) * 1000).toISOString();
      throw new Error(`GitHub API rate limit exceeded for ${method} ${path}; resets at ${resetAt}.`);
    }
    if (res.status === 403 && method !== 'GET') {
      throw new Error(
        `GitHub API ${method} ${path} -> 403 ${res.statusText}: ${bodyText.slice(0, 300)} ` +
          `(this write call needs a token with Contents: Read and Write on this repo — ` +
          `Contents: Read alone, sufficient for pull-only use, is not enough here)`,
      );
    }
    throw new Error(`GitHub API ${method} ${path} -> ${res.status} ${res.statusText}: ${bodyText.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function getDefaultBranch(owner, repo, token) {
  const data = await ghFetch(`/repos/${owner}/${repo}`, token);
  return data.default_branch;
}

// One call returns the FULL recursive tree (all paths in the repo at that ref).
export async function getRecursiveTree(owner, repo, ref, token) {
  const data = await ghFetch(
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    token,
  );
  return { sha: data.sha, tree: data.tree, truncated: Boolean(data.truncated) };
}

export async function getBlobText(owner, repo, sha, token) {
  const data = await ghFetch(`/repos/${owner}/${repo}/git/blobs/${sha}`, token);
  return Buffer.from(data.content, data.encoding || 'base64').toString('utf8');
}

export async function getAuthenticatedUser(token) {
  const data = await ghFetch('/user', token);
  return { login: data.login, name: data.name ?? null, email: data.email ?? null };
}

export async function getBranchHead(owner, repo, branch, token) {
  const data = await ghFetch(`/repos/${owner}/${repo}/git/ref/${encodeURIComponent('heads/' + branch)}`, token);
  return data.object.sha;
}

// Returns null instead of throwing when the branch simply doesn't exist yet
// (404) — any other error (auth, rate limit, repo not found) still throws.
export async function tryGetBranchHead(owner, repo, branch, token) {
  try {
    return await getBranchHead(owner, repo, branch, token);
  } catch (err) {
    if (String(err?.message || '').includes(' -> 404 ')) return null;
    throw err;
  }
}

export async function createBranch(owner, repo, branch, fromSha, token) {
  await ghFetch(`/repos/${owner}/${repo}/git/refs`, token, {
    method: 'POST',
    body: { ref: `refs/heads/${branch}`, sha: fromSha },
  });
}

export async function createBlob(owner, repo, base64Content, token) {
  const data = await ghFetch(`/repos/${owner}/${repo}/git/blobs`, token, {
    method: 'POST',
    body: { content: base64Content, encoding: 'base64' },
  });
  return data.sha;
}

export async function createTree(owner, repo, baseTreeSha, entries, token) {
  const data = await ghFetch(`/repos/${owner}/${repo}/git/trees`, token, {
    method: 'POST',
    body: { base_tree: baseTreeSha, tree: entries },
  });
  return data.sha;
}

export async function createCommit(owner, repo, message, treeSha, parentSha, token) {
  const data = await ghFetch(`/repos/${owner}/${repo}/git/commits`, token, {
    method: 'POST',
    body: { message, tree: treeSha, parents: [parentSha] },
  });
  return data.sha;
}

export async function updateRef(owner, repo, branch, newCommitSha, token) {
  // force:false — GitHub itself rejects a non-fast-forward move, a second
  // line of defense on top of index.js's own pre-write head-sha re-check.
  await ghFetch(`/repos/${owner}/${repo}/git/refs/${encodeURIComponent('heads/' + branch)}`, token, {
    method: 'PATCH',
    body: { sha: newCommitSha, force: false },
  });
}
