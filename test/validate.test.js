import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateSkillFolder } from '../lib/validate.js';

function makeSkillDir(folderName, skillMdContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillbridge-validate-'));
  const skillDir = path.join(dir, folderName);
  fs.mkdirSync(skillDir, { recursive: true });
  if (skillMdContent !== null) {
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMdContent);
  }
  return skillDir;
}

test('missing SKILL.md -> invalid, reports the missing file', () => {
  const dir = makeSkillDir('foo', null);
  const result = validateSkillFolder(dir);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.includes('No SKILL.md found')));
});

test('extra frontmatter key -> invalid, warns about the specific key', () => {
  const dir = makeSkillDir('foo', '---\nname: foo\ndescription: does a thing\nlicense: MIT\n---\n');
  const result = validateSkillFolder(dir);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.includes('license')));
});

test('name does not match folder name -> invalid', () => {
  const dir = makeSkillDir('foo', '---\nname: bar\ndescription: does a thing\n---\n');
  const result = validateSkillFolder(dir);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.includes('does not match folder name')));
});

test('empty description -> invalid', () => {
  const dir = makeSkillDir('foo', '---\nname: foo\ndescription:\n---\n');
  const result = validateSkillFolder(dir);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.toLowerCase().includes('description')));
});

test('fully valid skill -> valid, no issues', () => {
  const dir = makeSkillDir('foo', '---\nname: foo\ndescription: does a thing\n---\n');
  const result = validateSkillFolder(dir);
  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
  assert.equal(result.name, 'foo');
  assert.equal(result.description, 'does a thing');
});
