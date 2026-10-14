import test from 'node:test';
import assert from 'node:assert/strict';
import { expandSources, isOrgSource, __clearOrgCache } from '../lib/sources.js';

const repos = [
  { name: 'claude-skill-a', archived: false },
  { name: 'technext-claude-skills', archived: false },
  { name: 'old-skill', archived: true },
  { name: 'website', archived: false },
];

test.beforeEach(() => __clearOrgCache());

test('orgMatch picks repos by substring, skipping archived and non-matches', async () => {
  const { sources, warnings } = await expandSources([{ owner: 'Org', orgMatch: 'SKILL' }], async () => repos);
  assert.deepEqual(sources.map((s) => s.repo), ['claude-skill-a', 'technext-claude-skills']);
  assert.deepEqual(warnings, []);
});

test('explicit repo wins over an org expansion of the same repo', async () => {
  const { sources } = await expandSources(
    [{ owner: 'Org', orgMatch: 'skill' }, { owner: 'org', repo: 'claude-skill-a', ref: 'v1' }],
    async () => repos,
  );
  assert.equal(sources.filter((s) => s.repo === 'claude-skill-a').length, 1);
  assert.equal(sources.find((s) => s.repo === 'claude-skill-a').ref, 'v1');
});

test('listing failure becomes a warning and explicit entries still work', async () => {
  const { sources, warnings } = await expandSources(
    [{ owner: 'Org', orgMatch: 'skill' }, { owner: 'Org', repo: 'fallback' }],
    async () => { throw new Error('boom'); },
  );
  assert.deepEqual(sources.map((s) => s.repo), ['fallback']);
  assert.match(warnings[0], /boom/);
});

test('org listing is cached per owner', async () => {
  let calls = 0;
  const list = async () => { calls++; return repos; };
  await expandSources([{ owner: 'Org', orgMatch: 'skill' }], list);
  await expandSources([{ owner: 'Org', orgMatch: 'claude' }], list);
  assert.equal(calls, 1);
});

test('isOrgSource needs owner + orgMatch and no repo', () => {
  assert.equal(isOrgSource({ owner: 'o', orgMatch: 'x' }), true);
  assert.equal(isOrgSource({ owner: 'o', orgMatch: '  ' }), false);
  assert.equal(isOrgSource({ owner: 'o', repo: 'r', orgMatch: 'x' }), false);
});
