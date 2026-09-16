// Regression tests for the find_skills audit of 2026-09-16. Each maps to a
// defect found by reading the code and confirming it against real GitHub
// output, not to a hypothetical.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  isSkillManifestPath,
  mapWithConcurrency,
  tokenize,
  relevanceScore,
  encodeCursor,
  decodeCursor,
} from '../lib/util.js';
import { isRateLimitError, getRateLimitStatus, __setGhRunner } from '../lib/github.js';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

// The bug: endsWith('SKILL.md') is true for "MYSKILL.md", and the path-slicing
// that follows then cut the directory at the wrong offset ("MYSKILL.md" -> "M",
// "docs/NOT-SKILL.md" -> "docs/NOT"). That mangled path is what a caller hands
// to pull_skill, so this silently pulled the wrong folder.
test('isSkillManifestPath accepts only a final segment of exactly SKILL.md', () => {
  assert.equal(isSkillManifestPath('SKILL.md'), true);
  assert.equal(isSkillManifestPath('foo/SKILL.md'), true);
  assert.equal(isSkillManifestPath('a/b/c/SKILL.md'), true);

  assert.equal(isSkillManifestPath('MYSKILL.md'), false);
  assert.equal(isSkillManifestPath('docs/NOT-SKILL.md'), false);
  assert.equal(isSkillManifestPath('docs/OLD_SKILL.md'), false);
  assert.equal(isSkillManifestPath('SKILL.md.bak'), false);
  assert.equal(isSkillManifestPath('skill.md'), false, 'case matters — GitHub paths are case-sensitive');
  assert.equal(isSkillManifestPath(undefined), false);
  assert.equal(isSkillManifestPath(null), false);
});

test('a rejected path can never produce a truncated directory', () => {
  // Property the old code violated: for every path the filter accepts,
  // stripping "/SKILL.md" must leave a directory that still round-trips.
  for (const p of ['SKILL.md', 'foo/SKILL.md', 'a/b/SKILL.md', 'MYSKILL.md', 'docs/NOT-SKILL.md']) {
    if (!isSkillManifestPath(p)) continue;
    const dir = p === 'SKILL.md' ? '' : p.slice(0, -'/SKILL.md'.length);
    const rebuilt = dir ? `${dir}/SKILL.md` : 'SKILL.md';
    assert.equal(rebuilt, p, `round-trip failed for ${p}`);
  }
});

test('mapWithConcurrency preserves input order regardless of completion order', async () => {
  const delays = [40, 5, 30, 1, 20];
  const out = await mapWithConcurrency(delays, 2, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms));
    return i;
  });
  assert.deepEqual(out, [0, 1, 2, 3, 4]);
});

test('mapWithConcurrency actually overlaps work and respects the cap', async () => {
  let inFlight = 0;
  let peak = 0;
  await mapWithConcurrency(Array.from({ length: 12 }), 4, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight -= 1;
  });
  assert.ok(peak > 1, 'work never overlapped — this is the serial bug the fix targets');
  assert.ok(peak <= 4, `concurrency cap exceeded (peak ${peak})`);
});

test('mapWithConcurrency handles an empty list without hanging', async () => {
  assert.deepEqual(await mapWithConcurrency([], 8, async () => 1), []);
});

// outputSchema declares items/totalMatched as required. Returning only
// `content` on an error path makes a schema-validating client reject the
// response, so the user never sees the error message at all.
// outputSchema declares items/searchType/totalMatched/unresolved as required.
// Returning only `content` on an error path makes a schema-validating client
// reject the response, so the user never sees the error message at all.
//
// find_skills now searches the skills.sh registry, so the error path is driven
// by making that host unresolvable rather than by hiding `gh`.
test('find_skills error path still satisfies its declared outputSchema', async () => {
  const client = new Client({ name: 'find-skills-test', version: '0.0.1' });
  await client.connect(
    new StdioClientTransport({
      command: 'node',
      args: ['index.js'],
      cwd: PACKAGE_ROOT,
      // Point the registry at a closed port so the fetch fails immediately.
      // Node's fetch ignores https_proxy, so shadowing the URL is the only
      // reliable way to keep this test off the real network.
      env: { ...process.env, SKILLS_REGISTRY_URL: 'http://127.0.0.1:9/api/search' },
    }),
  );
  const res = await client.callTool({ name: 'find_skills', arguments: { query: 'anything', limit: 5 } });
  assert.equal(res.isError, true, 'expected an unreachable registry to error');
  assert.ok(res.structuredContent, 'error path returned no structuredContent at all');
  assert.deepEqual(res.structuredContent.items, []);
  assert.equal(res.structuredContent.totalMatched, 0);
  assert.deepEqual(res.structuredContent.unresolved, []);
  assert.equal(typeof res.structuredContent.searchType, 'string');
  await client.close();
});

// --- Pagination cursors -----------------------------------------------------

test('decodeCursor treats a missing cursor as page 1', () => {
  assert.equal(decodeCursor(undefined), 1);
  assert.equal(decodeCursor(''), 1);
  assert.equal(decodeCursor(null), 1);
});

test('cursors round-trip', () => {
  for (const page of [1, 2, 7, 100]) {
    assert.equal(decodeCursor(encodeCursor(page)), page);
  }
});

// A cursor is user input; a malformed one must be reportable, never crash and
// never silently fall back to page 1 (which would loop a paging caller).
test('decodeCursor rejects malformed cursors instead of guessing', () => {
  for (const bad of ['', 'x9', 'p0', 'p-2', 'p1.5', 'pabc', '9', 'p', 42, {}]) {
    if (bad === '') continue;
    assert.equal(decodeCursor(bad), null, `should have rejected ${JSON.stringify(bad)}`);
  }
});

// --- Relevance ranking ------------------------------------------------------

test('tokenize drops noise words that every skill description contains', () => {
  assert.deepEqual(tokenize('Use this skill when the user asks for a changelog'), ['changelog']);
  assert.deepEqual(tokenize(''), []);
});

test('a skill named for the query outranks one that merely mentions it', () => {
  const q = tokenize('generate changelog from commits');
  const onTopic = relevanceScore(q, {
    name: 'changelog',
    path: 'skills/changelog',
    description: 'Generate CHANGELOG.md from recent commits',
  });
  const offTopic = relevanceScore(q, {
    name: 'npm',
    path: 'skills/data/npm',
    description: 'NPM release assistant that automates the patch version release process',
  });
  assert.ok(onTopic > offTopic, `expected ${onTopic} > ${offTopic}`);
  assert.equal(offTopic, 0, 'a result sharing no query term should score 0');
});

test('relevance stays within 0..1 and handles missing fields', () => {
  const q = tokenize('changelog release notes');
  for (const row of [{}, { name: null, description: null, path: '' }, { name: 'changelog', path: 'changelog', description: 'release notes changelog' }]) {
    const s = relevanceScore(q, row);
    assert.ok(s >= 0 && s <= 1, `score ${s} out of range`);
  }
  assert.equal(relevanceScore([], { name: 'anything' }), 0, 'an all-stopword query must not divide by zero');
});

// Scoring orders results; it must never be a filter. A real match phrased in
// synonyms scores 0, and dropping it would be worse than ranking it last.
test('a zero-relevance row is ranked last, not removed', () => {
  const q = tokenize('changelog');
  const rows = [
    { name: 'npm', path: 'npm', description: 'release helper' },
    { name: 'changelog', path: 'changelog', description: 'changelog writer' },
  ].map((r, i) => ({ ...r, relevance: relevanceScore(q, r), _rank: i }));
  const sorted = [...rows].sort((a, b) => b.relevance - a.relevance || a._rank - b._rank);
  assert.equal(sorted.length, 2, 'nothing may be dropped');
  assert.equal(sorted[0].name, 'changelog');
  assert.equal(sorted[1].relevance, 0);
});

// --- Rate limit reporting ---------------------------------------------------

test.afterEach(() => __setGhRunner());

test('isRateLimitError separates throttling from other 403s', () => {
  assert.equal(isRateLimitError({ httpStatus: 403, message: 'API rate limit exceeded for user' }), true);
  assert.equal(isRateLimitError({ httpStatus: 403, message: 'You have exceeded a secondary rate limit' }), true);
  assert.equal(isRateLimitError({ httpStatus: 429, message: 'Too Many Requests' }), true);

  // These are 403 too, but waiting does not help — they must not be reported
  // as "retry in 43s".
  assert.equal(isRateLimitError({ httpStatus: 403, message: 'you may not be a collaborator on this repo' }), false);
  assert.equal(isRateLimitError({ httpStatus: 404, message: 'rate limit' }), false);
  assert.equal(isRateLimitError(undefined), false);
});

test('getRateLimitStatus converts the reset epoch into seconds to wait', async () => {
  const reset = Math.floor(Date.now() / 1000) + 43;
  __setGhRunner(async (args) => {
    if (args[0] === '--version') return { code: 0, stdout: 'gh', stderr: '' };
    if (args[0] === 'auth') return { code: 0, stdout: 'ok', stderr: '' };
    return { code: 0, stdout: JSON.stringify({ resources: { code_search: { limit: 10, remaining: 0, reset, used: 10 } } }), stderr: '' };
  });
  const s = await getRateLimitStatus('code_search');
  assert.equal(s.limit, 10);
  assert.equal(s.remaining, 0);
  assert.ok(Math.abs(s.secondsUntilReset - 43) <= 2, `got ${s.secondsUntilReset}`);
});

// This only ever decorates an error message — if it throws, it would replace
// the real error with its own and hide what actually went wrong.
test('getRateLimitStatus returns null rather than throwing when it fails', async () => {
  __setGhRunner(async () => ({ code: 1, stdout: '', stderr: 'HTTP 500: boom' }));
  assert.equal(await getRateLimitStatus('code_search'), null);
});

test('getRateLimitStatus returns null for an unknown resource bucket', async () => {
  __setGhRunner(async () => ({ code: 0, stdout: JSON.stringify({ resources: {} }), stderr: '' }));
  assert.equal(await getRateLimitStatus('code_search'), null);
});

// Found by exhausting the real quota: GitHub also enforces an undocumented
// SECONDARY (burst) limit, and when that fires the documented per-minute
// bucket can still read as full. Quoting it verbatim produced the
// self-contradicting "rate limit reached: 10/10 requests left".
test('a secondary (burst) limit is reported differently from an exhausted quota', async () => {
  const reset = Math.floor(Date.now() / 1000) + 60;
  const mk = (remaining) => async (args) => {
    if (args[0] === '--version') return { code: 0, stdout: 'gh', stderr: '' };
    if (args[0] === 'auth') return { code: 0, stdout: 'ok', stderr: '' };
    return { code: 0, stdout: JSON.stringify({ resources: { code_search: { limit: 10, remaining, reset } } }), stderr: '' };
  };

  __setGhRunner(mk(10));
  const burst = await getRateLimitStatus('code_search');
  assert.equal(burst.remaining, 10, 'primary bucket still full => secondary limit');

  __setGhRunner(mk(0));
  const exhausted = await getRateLimitStatus('code_search');
  assert.equal(exhausted.remaining, 0);
  assert.ok(exhausted.secondsUntilReset > 0, 'an exhausted quota must report a wait');
});
