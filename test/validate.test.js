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

// name + description are the MINIMUM a skill must carry, not the maximum.
// Enforcing the two-key rule as an error made this validator stricter than the
// ecosystem it validates — real, widely installed skills carry allowed-tools,
// license, metadata, model. Extra keys are now a warning.
test('extra frontmatter key -> still VALID, reported as a warning not an issue', () => {
  const dir = makeSkillDir('foo', '---\nname: foo\ndescription: does a thing\nlicense: MIT\n---\n');
  const result = validateSkillFolder(dir);
  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
  assert.ok(result.warnings.some((w) => w.includes('license')));
});

// The warning has a job beyond naming the key: SKILL-LIB's CI has NOT been
// relaxed, so it must say a PR can still be refused there. Losing that line
// would turn a known divergence into a surprise at PR time.
test('the extra-key warning names the CI that still rejects those keys', () => {
  const dir = makeSkillDir('foo', '---\nname: foo\ndescription: does a thing\nmodel: sonnet\n---\n');
  const result = validateSkillFolder(dir);
  const warning = result.warnings.find((w) => w.includes('model'));
  assert.ok(warning, 'expected a warning naming the extra key');
  assert.match(warning, /CI/);
  assert.match(warning, /PACKAGING\.md/);
});

// The shape that blocked benchmarking a real published agent profile
// (VoltAgent's business-analyst): tools + model in the frontmatter.
test('an agent-profile frontmatter (tools + model) validates with one warning', () => {
  const dir = makeSkillDir(
    'business-analyst',
    '---\nname: business-analyst\ndescription: Use when analyzing business processes\ntools: Read, Write, Edit\nmodel: sonnet\n---\n',
  );
  const result = validateSkillFolder(dir);
  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
  assert.equal(result.warnings.length, 1, 'one warning listing both keys, not one per key');
  assert.match(result.warnings[0], /tools/);
  assert.match(result.warnings[0], /model/);
});

// Relaxing extra keys must not relax the two that are actually required.
test('extra keys do not excuse a missing name', () => {
  const dir = makeSkillDir('foo', '---\ndescription: does a thing\nlicense: MIT\n---\n');
  const result = validateSkillFolder(dir);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.includes('name')));
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
  assert.deepEqual(result.warnings, [], 'a plain two-key skill must produce no warnings at all');
  assert.equal(result.name, 'foo');
  assert.equal(result.description, 'does a thing');
});
