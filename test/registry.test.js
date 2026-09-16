// Tests for lib/registry.js — the skills.sh search that find_skills now runs on.
//
// The endpoint it calls (/api/search) is public but UNDOCUMENTED: skills.sh
// publishes /api/v1/* and those require a Vercel OIDC token. So the thing most
// worth pinning down here is not the happy path but every way that endpoint
// can go wrong — retired, moved behind auth, answering HTML, timing out —
// because each must surface as a clear message, never as a crash.
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchRegistry, RegistryError, __setFetch } from '../lib/registry.js';

function fakeFetch(handler) {
  const calls = [];
  __setFetch(async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts, calls.length);
  });
  return calls;
}

const ok = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

test.afterEach(() => __setFetch());

test('parses a normal search response into owner/repo rows', async () => {
  fakeFetch(async () =>
    ok({
      searchType: 'semantic',
      skills: [
        { id: 'a/b/scope-creep-detector', skillId: 'scope-creep-detector', name: 'scope-creep-detector', installs: 413, source: 'a/b' },
        { id: 'c/d/scope-creep-defense', skillId: 'scope-creep-defense', name: 'scope-creep-defense', installs: 22, source: 'c/d' },
      ],
    }),
  );
  const { searchType, items } = await searchRegistry('prevent over-engineering');
  assert.equal(searchType, 'semantic');
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    skillId: 'scope-creep-detector',
    name: 'scope-creep-detector',
    source: 'a/b',
    owner: 'a',
    repo: 'b',
    installs: 413,
  });
});

test('sends the query and limit as encoded parameters', async () => {
  const calls = fakeFetch(async () => ok({ searchType: 'semantic', skills: [] }));
  await searchRegistry('keep it minimal & small', { limit: 7 });
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('q'), 'keep it minimal & small');
  assert.equal(url.searchParams.get('limit'), '7');
});

// searchType is not cosmetic: "fuzzy" means the registry matched names only,
// which is much weaker than the semantic matching a caller is expecting.
test('passes the registry searchType through instead of assuming semantic', async () => {
  fakeFetch(async () => ok({ searchType: 'fuzzy', skills: [] }));
  assert.equal((await searchRegistry('changelog')).searchType, 'fuzzy');

  fakeFetch(async () => ok({ skills: [] }));
  assert.equal((await searchRegistry('changelog')).searchType, 'unknown', 'a missing searchType must not be reported as semantic');
});

test('drops rows whose source is not a usable owner/repo', async () => {
  fakeFetch(async () =>
    ok({
      searchType: 'semantic',
      skills: [
        { skillId: 'good', name: 'good', source: 'a/b', installs: 1 },
        { skillId: 'no-source', name: 'no-source', installs: 1 },
        { skillId: 'too-deep', name: 'too-deep', source: 'a/b/c', installs: 1 },
        { skillId: 'empty', name: 'empty', source: '', installs: 1 },
        { name: 'no-id', source: 'a/b', installs: 1 },
      ],
    }),
  );
  const { items } = await searchRegistry('anything');
  assert.deepEqual(items.map((i) => i.skillId), ['good', 'no-id'], 'only rows that resolve to one repo survive');
});

test('a missing install count becomes 0 rather than NaN or undefined', async () => {
  fakeFetch(async () => ok({ searchType: 'semantic', skills: [{ skillId: 'x', name: 'x', source: 'a/b' }] }));
  assert.equal((await searchRegistry('anything')).items[0].installs, 0);
});

test('rejects a query shorter than the registry accepts, without a network call', async () => {
  const calls = fakeFetch(async () => ok({ skills: [] }));
  await assert.rejects(() => searchRegistry('a'), RegistryError);
  await assert.rejects(() => searchRegistry('   '), RegistryError);
  assert.equal(calls.length, 0, 'should not have called out for a query it knows is invalid');
});

// If skills.sh ever puts /api/search behind the same auth as /api/v1/*, this
// is what the user would hit — it has to name the status, not throw raw.
test('surfaces an HTTP error status as a RegistryError', async () => {
  fakeFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }));
  await assert.rejects(() => searchRegistry('anything'), (err) => {
    assert.ok(err instanceof RegistryError);
    assert.equal(err.status, 401);
    assert.match(err.message, /HTTP 401/);
    return true;
  });
});

// A retired endpoint on a Next.js site answers 200 with an HTML page, so a
// JSON parse failure is the likeliest real-world symptom of it going away.
test('an HTML response is reported as the endpoint having changed', async () => {
  fakeFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected token <');
    },
  }));
  await assert.rejects(() => searchRegistry('anything'), /non-JSON response .*endpoint may have changed/);
});

test('a network failure is reported as unreachable, not as a crash', async () => {
  fakeFetch(async () => {
    throw Object.assign(new Error('getaddrinfo ENOTFOUND skills.sh'), { code: 'ENOTFOUND' });
  });
  await assert.rejects(() => searchRegistry('anything'), /Could not reach skills\.sh/);
});

test('a hung request aborts and names the timeout', async () => {
  fakeFetch(async (_url, opts) => {
    // Never resolves on its own — only the caller's AbortSignal ends it.
    return new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  });
  await assert.rejects(() => searchRegistry('anything', { timeoutMs: 40 }), /did not respond within 40ms/);
});

test('a response with no skills array yields an empty list, not a throw', async () => {
  fakeFetch(async () => ok({ searchType: 'semantic' }));
  assert.deepEqual((await searchRegistry('anything')).items, []);
});
