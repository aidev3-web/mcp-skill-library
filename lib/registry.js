// skills.sh — the indexed registry of the open agent-skill ecosystem, used as
// find_skills' primary search.
//
// Why not GitHub code search: that endpoint matches WORDS IN FILE TEXT. A skill
// whose whole purpose is preventing an agent from over-engineering, but which
// calls that "scope creep", is unreachable by a query phrased the other way.
// This registry answers the same query semantically and returns an install
// count, which is the only quality signal available before actually reading a
// skill.
//
// Auth note: skills.sh documents /api/v1/* as requiring a Vercel OIDC token,
// and those endpoints do answer 401. The /api/search endpoint used here is
// public and needs no credential of any kind — which is what makes it usable
// from this project, whose hard rule is "gh CLI only, never tokens or keys".
//
// Stability note: /api/search is NOT in skills.sh's published API docs, so it
// can change shape or disappear without notice. Every caller must treat a
// failure here as ordinary and recoverable, never as a crash.

// Overridable so a test can point at a closed port (to exercise the failure
// path without touching the real network) and so an operator can redirect to a
// mirror if skills.sh ever moves. Read at call time, not at import time, so
// setting it after startup still takes effect.
const DEFAULT_SEARCH_URL = 'https://skills.sh/api/search';
const searchUrl = () => process.env.SKILLS_REGISTRY_URL || DEFAULT_SEARCH_URL;
const DEFAULT_TIMEOUT_MS = 8000;

// Swappable seam for tests, mirroring lib/github.js's __setGhRunner — no
// network needed to exercise the parsing and error paths.
let fetchImpl = (...args) => globalThis.fetch(...args);

export function __setFetch(fn) {
  fetchImpl = fn || ((...args) => globalThis.fetch(...args));
}

export class RegistryError extends Error {
  constructor(message, { status = null, cause = null } = {}) {
    super(message);
    this.name = 'RegistryError';
    this.status = status;
    this.cause = cause;
  }
}

/**
 * Searches skills.sh.
 *
 * Returns { searchType, items: [{ skillId, name, source, installs }] }.
 * `searchType` is the registry's own word for how it interpreted the query:
 * "semantic" for multi-word queries, "fuzzy" for a single word. It is passed
 * through rather than hidden, because it changes how a caller should read the
 * results — a fuzzy single-word match is much closer to plain keyword search.
 */
export async function searchRegistry(query, { limit = 20, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const q = String(query || '').trim();
  // The registry itself requires 2+ characters; failing here keeps the error
  // specific instead of surfacing a bare 400 from a remote service.
  if (q.length < 2) {
    throw new RegistryError('Query must be at least 2 characters long.');
  }

  const url = `${searchUrl()}?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(limit)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    // Abort, DNS failure, offline — all indistinguishable to a caller, and all
    // mean the same thing: fall back to something else or tell the user.
    const aborted = err?.name === 'AbortError';
    throw new RegistryError(
      aborted ? `skills.sh did not respond within ${timeoutMs}ms.` : `Could not reach skills.sh: ${String(err?.message || err)}`,
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new RegistryError(`skills.sh search returned HTTP ${res.status}.`, { status: res.status });
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    // A 200 carrying an HTML error page is exactly what this undocumented
    // endpoint would return if it were retired, so say so plainly.
    throw new RegistryError('skills.sh returned a non-JSON response (the endpoint may have changed).', { cause: err });
  }

  const raw = Array.isArray(data?.skills) ? data.skills : [];
  const items = [];
  for (const s of raw) {
    // `source` is "owner/repo"; anything else cannot be resolved to a repo and
    // is dropped rather than passed on as a half-usable row.
    const source = typeof s?.source === 'string' ? s.source : '';
    const [owner, repo] = source.split('/');
    const skillId = s?.skillId || s?.name;
    if (!owner || !repo || source.split('/').length !== 2 || !skillId) continue;
    items.push({
      skillId: String(skillId),
      name: String(s.name ?? skillId),
      source,
      owner,
      repo,
      installs: Number.isFinite(s?.installs) ? s.installs : 0,
    });
  }

  return { searchType: typeof data?.searchType === 'string' ? data.searchType : 'unknown', items };
}
