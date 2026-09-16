// Small pure helpers shared by the tool handlers.
//
// These live here rather than in index.js because index.js connects the stdio
// transport at module scope — importing it (from a test, say) starts a server
// that never exits. Anything worth unit-testing has to sit outside it.

// True only for a path whose FINAL segment is exactly "SKILL.md".
//
// The obvious version of this check, `p.endsWith('SKILL.md')`, reads as
// correct and is not: it also accepts "MYSKILL.md" and "docs/NOT-SKILL.md".
// GitHub's `filename:SKILL.md` search qualifier tokenizes, so those really do
// come back in results. The follow-on damage is worse than the false positive
// — callers strip a trailing "/SKILL.md" to get the skill's directory, and on
// "MYSKILL.md" that slice cuts at the wrong offset and yields "M", which is
// then handed to pull_skill as a folder path.
export function isSkillManifestPath(p) {
  return typeof p === 'string' && (p === 'SKILL.md' || p.endsWith('/SKILL.md'));
}

// Page cursors for find_skills. Opaque on purpose: a caller that does
// arithmetic on a cursor is relying on a shape we may change, so it carries a
// prefix and a checksum-free tag rather than a bare integer.
const CURSOR_PREFIX = 'p';

export function encodeCursor(page) {
  return `${CURSOR_PREFIX}${page}`;
}

// Returns the 1-based page, or null if the cursor is malformed. Never throws:
// a bad cursor is user input, and the caller turns null into a clear message.
export function decodeCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return 1;
  if (typeof cursor !== 'string' || !cursor.startsWith(CURSOR_PREFIX)) return null;
  const n = Number(cursor.slice(CURSOR_PREFIX.length));
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

// Words too common in this corpus to say anything about relevance — every
// skill's description is about skills, using, and doing things.
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'the', 'for', 'from', 'with', 'into', 'to', 'of', 'in', 'on', 'or', 'by',
  'use', 'used', 'uses', 'using', 'when', 'this', 'that', 'it', 'is', 'are', 'be',
  'skill', 'skills', 'agent', 'user', 'asks', 'ask', 'want', 'wants', 'should', 'you', 'your',
]);

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

// How well one search result answers the query, from 0 to 1.
//
// GitHub's code search ranks by full-file relevance, which for a SKILL.md
// means the whole body — so a skill that merely mentions "changelog" in
// passing can outrank one whose entire job is changelogs. This re-ranks on
// the fields that actually identify a skill: its name, its description, and
// its folder path. Name and path are weighted above description because a
// skill named `changelog` in a folder named `changelog` is a far stronger
// signal than one of thirty words in a description.
//
// Deliberately used for ORDERING only, never to drop rows: a real match
// phrased in synonyms would score 0 here, and silently hiding it would be
// worse than showing it low in the list.
export function relevanceScore(queryTokens, { name, description, path } = {}) {
  if (!queryTokens.length) return 0;
  const nameTokens = new Set(tokenize(name));
  const pathTokens = new Set(tokenize(path));
  const descTokens = new Set(tokenize(description));
  let score = 0;
  for (const t of queryTokens) {
    if (nameTokens.has(t)) score += 1;
    else if (pathTokens.has(t)) score += 0.8;
    else if (descTokens.has(t)) score += 0.4;
  }
  return score / queryTokens.length;
}

// Runs `fn` over `list` with at most `limit` calls in flight, preserving input
// order in the result.
//
// Independent network reads should overlap: awaiting them one at a time just
// serialises round-trips (measured ~5x slower for a default-size page of
// find_skills results). An unbounded Promise.all would overlap them but open
// one socket per row, so the cap is the point.
export async function mapWithConcurrency(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(0, Math.min(limit, list.length)) }, async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
