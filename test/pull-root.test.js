import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPuller } from '../lib/pull.js';
import { gitBlobSha, readSource, remoteFilesFromTree } from '../lib/updates.js';

// A single-skill repo: SKILL.md sits at the repo root, next to README.md.
const FILES = {
  'SKILL.md': '---\nname: my-skill\ndescription: does a thing\n---\nbody\n',
  'README.md': 'readme',
  'kit/a.txt': 'a',
};

function setup() {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-root-'));
  const tree = Object.entries(FILES).map(([p, c]) => ({ type: 'blob', path: p, sha: gitBlobSha(c) }));
  const blobs = new Map(Object.values(FILES).map((c) => [gitBlobSha(c), Buffer.from(c)]));
  const puller = createPuller({
    resolveSkillDir: (name) => (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ? path.join(lib, name) : null),
    badNameMessage: 'bad name',
    getBlobBytes: async (_o, _r, sha) => blobs.get(sha),
    getCommitsForPath: async () => [{ sha: 'abc' }],
  });
  return { lib, tree, puller };
}

test('a skill at the repo root is pulled into a folder named after its frontmatter name', async () => {
  const t = setup();
  const entry = await t.puller.pullOneSkill(t.tree, 'o', 'claude-skill-my-skill', 'main', '');
  assert.equal(entry.status, 'pulled');
  assert.equal(entry.name, 'my-skill');
  const dir = path.join(t.lib, 'my-skill');
  assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(dir, 'kit', 'a.txt')));
});

test('the source record of a root skill is readable and tracks every file', async () => {
  const t = setup();
  await t.puller.pullOneSkill(t.tree, 'o', 'claude-skill-my-skill', 'main', '');
  const src = readSource(path.join(t.lib, 'my-skill'));
  assert.equal(src.path, '');
  assert.deepEqual(Object.keys(src.files).sort(), ['README.md', 'SKILL.md', 'kit/a.txt']);
  assert.deepEqual(remoteFilesFromTree(t.tree, src.path), src.files);
});

test('a path with no SKILL.md still errors', async () => {
  const t = setup();
  const entry = await t.puller.pullOneSkill(t.tree, 'o', 'r', 'main', 'nope');
  assert.equal(entry.status, 'error');
});
