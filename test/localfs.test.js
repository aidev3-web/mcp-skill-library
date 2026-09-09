import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { walkSkillFiles } from '../lib/localfs.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skillbridge-localfs-'));
}

test('excludes only the root .meta.json, keeps a nested one with the same name', () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: foo\ndescription: x\n---\n');
  fs.writeFileSync(path.join(dir, '.meta.json'), '{"uploadedBy":"x"}');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', '.meta.json'), '{"nested":"real data"}');

  const files = walkSkillFiles(dir);
  const relPaths = files.map((f) => f.relativePath).sort();

  assert.deepEqual(relPaths, ['SKILL.md', 'assets/.meta.json']);
});

test('.git directories are excluded', () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: foo\ndescription: x\n---\n');
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main');

  const files = walkSkillFiles(dir);
  const relPaths = files.map((f) => f.relativePath);

  assert.deepEqual(relPaths, ['SKILL.md']);
});

test('symlinks are skipped, not walked or listed', (t) => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: foo\ndescription: x\n---\n');
  const targetDir = makeTempDir();
  fs.writeFileSync(path.join(targetDir, 'other.txt'), 'not part of this skill');

  try {
    fs.symlinkSync(targetDir, path.join(dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    t.skip(`symlink creation not permitted in this environment: ${err.message}`);
    return;
  }

  const files = walkSkillFiles(dir);
  const relPaths = files.map((f) => f.relativePath);

  assert.deepEqual(relPaths, ['SKILL.md']);
  assert.ok(!relPaths.some((p) => p.startsWith('linked')));
});
