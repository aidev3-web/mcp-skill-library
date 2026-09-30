import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPuller } from '../lib/pull.js';
import { gitBlobSha } from '../lib/updates.js';

const SKILL_MD = (name) => `---\nname: ${name}\ndescription: the ${name} skill\n---\nbody\n`;

// A fake repo: { "folder/file": content }. The tree carries real git blob shas.
function fakeRepo(files) {
  const tree = Object.entries(files).map(([p, c]) => ({ type: 'blob', path: p, sha: gitBlobSha(c) }));
  const blobs = new Map(Object.values(files).map((c) => [gitBlobSha(c), Buffer.from(c)]));
  return { tree, getBlobBytes: async (_o, _r, sha) => blobs.get(sha) };
}

function setup(files, { library } = {}) {
  const lib = library || fs.mkdtempSync(path.join(os.tmpdir(), 'pull-deps-'));
  const repo = fakeRepo(files);
  const events = [];
  const puller = createPuller({
    resolveSkillDir: (name) => (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ? path.join(lib, name) : null),
    badNameMessage: 'bad name',
    getBlobBytes: repo.getBlobBytes,
    getCommitsForPath: async () => [{ sha: 'abc123' }],
    onPulled: (n) => events.push(n),
  });
  return { lib, repo, puller, events };
}

const pull = async (t, path0, opts = {}) => {
  const entry = await t.puller.pullOneSkill(t.repo.tree, 'o', 'r', 'main', path0);
  const deps = entry.status === 'pulled' ? await t.puller.pullDependencies(t.repo.tree, 'o', 'r', 'main', entry, { includeOptional: true, ...opts }) : [];
  return { entry, deps };
};

const REPO = {
  'main/SKILL.md': SKILL_MD('main'),
  'main/dependencies.json': JSON.stringify({ requires: ['a', 'b'], optional: ['c'] }),
  'a/SKILL.md': SKILL_MD('a'),
  'a/dependencies.json': JSON.stringify({ requires: ['d'] }),
  'b/SKILL.md': SKILL_MD('b'),
  'c/SKILL.md': SKILL_MD('c'),
  'd/SKILL.md': SKILL_MD('d'),
  'd/assets/note.md': 'note',
};

test('pulls the skill and every dependency, transitively, each with its source record', async () => {
  const t = setup(REPO);
  const { entry, deps } = await pull(t, 'main');
  assert.equal(entry.status, 'pulled');
  assert.deepEqual(deps.map((d) => [d.name, d.status, d.optional, d.dependencyOf]).sort(), [
    ['a', 'pulled', false, 'main'],
    ['b', 'pulled', false, 'main'],
    ['c', 'pulled', true, 'main'],
    ['d', 'pulled', false, 'main'],
  ]);
  for (const n of ['main', 'a', 'b', 'c', 'd']) {
    assert.ok(fs.existsSync(path.join(t.lib, n, 'SKILL.md')), `${n} is in the library`);
    assert.ok(fs.existsSync(path.join(t.lib, n, '.source.json')), `${n} has a source record`);
  }
  assert.equal(fs.readFileSync(path.join(t.lib, 'd', 'assets', 'note.md'), 'utf8'), 'note');
  assert.ok(t.events.includes('d'), 'the update-check cache is told about every pulled skill');
});

test('includeOptional:false skips the optional ones and says so', async () => {
  const t = setup(REPO);
  const { deps } = await pull(t, 'main', { includeOptional: false });
  const c = deps.find((d) => d.name === 'c');
  assert.equal(c.status, 'skipped-optional');
  assert.equal(fs.existsSync(path.join(t.lib, 'c')), false);
  assert.ok(fs.existsSync(path.join(t.lib, 'a', 'SKILL.md')));
});

test('a dependency already in the library is left untouched, but its own dependencies are still followed', async () => {
  const t = setup(REPO);
  fs.mkdirSync(path.join(t.lib, 'a'));
  fs.writeFileSync(path.join(t.lib, 'a', 'SKILL.md'), SKILL_MD('a'));
  fs.writeFileSync(path.join(t.lib, 'a', 'dependencies.json'), JSON.stringify({ requires: ['d'] }));
  fs.writeFileSync(path.join(t.lib, 'a', 'MY-NOTES.md'), 'mine');
  const { deps } = await pull(t, 'main');
  assert.equal(deps.find((d) => d.name === 'a').status, 'already-present');
  assert.equal(fs.readFileSync(path.join(t.lib, 'a', 'MY-NOTES.md'), 'utf8'), 'mine', 'no overwrite');
  assert.equal(deps.find((d) => d.name === 'd').status, 'pulled', "a's dependency still arrived");
});

test('a dependency that is not in the repo is reported as an error and the rest still installs', async () => {
  const t = setup({ ...REPO, 'main/dependencies.json': JSON.stringify({ requires: ['a', 'ghost'] }) });
  const { deps } = await pull(t, 'main');
  const ghost = deps.find((d) => d.name === 'ghost');
  assert.equal(ghost.status, 'error');
  assert.match(ghost.warnings.join(' '), /No SKILL\.md/);
  assert.equal(deps.find((d) => d.name === 'a').status, 'pulled');
});

test('a dependency cycle terminates', async () => {
  const t = setup({
    'x/SKILL.md': SKILL_MD('x'),
    'x/dependencies.json': JSON.stringify({ requires: ['y'] }),
    'y/SKILL.md': SKILL_MD('y'),
    'y/dependencies.json': JSON.stringify({ requires: ['x', 'y'] }),
  });
  const { deps } = await pull(t, 'x');
  assert.deepEqual(deps.map((d) => d.name), ['y']);
});

test('dependencies are siblings of a nested skill, not of the repo root', async () => {
  const t = setup({
    'team/main/SKILL.md': SKILL_MD('main'),
    'team/main/dependencies.json': JSON.stringify({ requires: ['helper'] }),
    'team/helper/SKILL.md': SKILL_MD('helper'),
    'helper/SKILL.md': SKILL_MD('wrong-one'),
  });
  const { deps } = await pull(t, 'team/main');
  assert.equal(deps[0].status, 'pulled');
  assert.match(fs.readFileSync(path.join(t.lib, 'helper', 'SKILL.md'), 'utf8'), /name: helper/);
});

test('hostile names in dependencies.json never reach the filesystem', async () => {
  const t = setup({
    'main/SKILL.md': SKILL_MD('main'),
    'main/dependencies.json': JSON.stringify({ requires: ['../evil', 'a/b', '..'] }),
    'evil/SKILL.md': SKILL_MD('evil'),
  });
  const { entry, deps } = await pull(t, 'main');
  assert.deepEqual(deps, []);
  assert.match(entry.warnings.join(' '), /not a plain skill folder name/);
  assert.equal(fs.existsSync(path.join(t.lib, 'evil')), false);
  assert.equal(fs.existsSync(path.join(path.dirname(t.lib), 'evil')), false);
});

test('a broken dependencies.json is a warning, not a failed install', async () => {
  const t = setup({ 'main/SKILL.md': SKILL_MD('main'), 'main/dependencies.json': '{not json' });
  const { entry, deps } = await pull(t, 'main');
  assert.equal(entry.status, 'pulled');
  assert.deepEqual(deps, []);
  assert.match(entry.warnings.join(' '), /not valid JSON/);
});

test('a skill without dependencies.json behaves exactly as before', async () => {
  const t = setup({ 'solo/SKILL.md': SKILL_MD('solo') });
  const { entry, deps } = await pull(t, 'solo');
  assert.equal(entry.status, 'pulled');
  assert.deepEqual(deps, []);
});

test('path traversal in the skill folder itself is still refused before anything is written', async () => {
  const t = setup({ 'bad/SKILL.md': SKILL_MD('bad'), 'bad/../../escape.txt': 'x' });
  const entry = await t.puller.pullOneSkill(t.repo.tree, 'o', 'r', 'main', 'bad');
  assert.equal(entry.status, 'error');
  assert.match(entry.warnings.join(' '), /path traversal/);
  assert.equal(fs.existsSync(path.join(t.lib, 'bad', 'SKILL.md')), false, 'nothing written for the refused skill');
});
