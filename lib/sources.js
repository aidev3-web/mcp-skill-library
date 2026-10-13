// Turns the entries of sources.json / sources.local.json into concrete repos.
//
// An entry is either one repo — { owner, repo } — or a whole org (or user)
// filtered by name — { owner, orgMatch }. orgMatch is a case-insensitive
// substring tested against each repo name, so { owner: "TechNextSG",
// orgMatch: "skill" } picks up every repo in that org with "skill" in its
// name, including ones created after this file was written.
//
// Explicit { owner, repo } entries always win over an org expansion that lands
// on the same repo (they may carry a pinned ref), and they are also the
// fallback when GitHub cannot list the org: the failure is reported as a
// warning and the explicit entries still work.

const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // owner -> { at, repos }

export function isOrgSource(s) {
  return Boolean(s?.owner && !s.repo && typeof s.orgMatch === 'string' && s.orgMatch.trim());
}

export function __clearOrgCache() {
  cache.clear();
}

async function reposOf(owner, listRepos) {
  const hit = cache.get(owner);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.repos;
  const repos = await listRepos(owner);
  cache.set(owner, { at: Date.now(), repos });
  return repos;
}

// sources: raw entries. listRepos(owner) -> [{ name, archived }].
// Returns { sources: [{ owner, repo, ... }], warnings: [string] }.
export async function expandSources(sources, listRepos) {
  const out = [];
  const warnings = [];
  const seen = new Set();
  const add = (s) => {
    const key = `${s.owner}/${s.repo}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  for (const s of sources) if (s?.owner && s?.repo) add(s);
  for (const s of sources) {
    if (!isOrgSource(s)) continue;
    const needle = s.orgMatch.trim().toLowerCase();
    try {
      for (const r of await reposOf(s.owner, listRepos)) {
        if (r.archived || !r.name.toLowerCase().includes(needle)) continue;
        add({ owner: s.owner, repo: r.name, note: s.note });
      }
    } catch (err) {
      warnings.push(`Could not list repos of ${s.owner} (orgMatch "${s.orgMatch}"): ${String(err?.message || err)}`);
    }
  }
  return { sources: out, warnings };
}
