const API = 'https://api.github.com';

async function ghFetch(path, token) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${path} -> ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
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
