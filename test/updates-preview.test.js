import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { textDiffSummary, describeUpdate, checkForUpdate, gitBlobSha, writeSource } from '../lib/updates.js';

const SKILL_MD = (extra = '') => `---\nname: demo\ndescription: a demo skill\n---\nbody${extra}\n`;

function pulledDemo(content = SKILL_MD()) {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'skilllib-preview-'));
  const dir = path.join(lib, 'demo');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
  writeSource(dir, { owner: 'o', repo: 'r', ref: 'main', path: 'demo', commit: 'c0', pulledAt: 'x', declinedSignature: null, files: { 'SKILL.md': gitBlobSha(content) } });
  return dir;
}

function remote(files) {
  const tree = Object.entries(files).map(([p, c]) => ({ type: 'blob', path: p, sha: gitBlobSha(c) }));
  const blobs = new Map(Object.values(files).map((c) => [gitBlobSha(c), Buffer.from(c)]));
  return {
    loadTree: async () => ({ tree }),
    getCommits: async () => [{ sha: 'c1', message: 'improve demo', date: '2026-09-30' }],
    fetchBlob: async (_o, _r, sha) => blobs.get(sha),
  };
}

test('textDiffSummary lists the lines added and removed, capped and trimmed', () => {
  const d = textDiffSummary('keep\nold rule\nsame\n', 'keep\nnew rule\nsame\nextra\n');
  assert.deepEqual(d.added, ['new rule', 'extra']);
  assert.deepEqual(d.removed, ['old rule']);

  const many = textDiffSummary('', Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'), 3);
  assert.equal(many.added.length, 3);
  assert.equal(many.addedTotal, 20);

  assert.equal(textDiffSummary('x'.repeat(300), '').removed[0].length, 160);
});

test('the update report carries what changed in the file, not just its name', async () => {
  const dir = pulledDemo();
  const r = remote({ 'demo/SKILL.md': SKILL_MD('\nnew naming rule: use scope') });
  const check = await checkForUpdate(dir, r);
  assert.equal(check.previews.length, 1);
  assert.equal(check.previews[0].file, 'SKILL.md');
  assert.ok(check.previews[0].added.some((l) => l.includes('new naming rule')));
  const text = describeUpdate('demo', check);
  assert.match(text, /What changed in SKILL\.md/);
  assert.match(text, /\+ .*new naming rule/);
});

test('previews skip binary files and survive a failing fetch', async () => {
  const dir = pulledDemo();
  const r = remote({ 'demo/SKILL.md': SKILL_MD(' v2') });

  const broken = await checkForUpdate(dir, { ...r, fetchBlob: async () => { throw new Error('offline'); } });
  assert.equal(broken.status, 'update-available');
  assert.deepEqual(broken.previews, []);

  const binary = await checkForUpdate(dir, { ...r, fetchBlob: async () => Buffer.from([1, 0, 2, 3]) });
  assert.deepEqual(binary.previews, []);
});

test('without a fetchBlob dependency the check still works and has no previews', async () => {
  const dir = pulledDemo();
  const { fetchBlob, ...noBlob } = remote({ 'demo/SKILL.md': SKILL_MD(' v2') });
  const check = await checkForUpdate(dir, noBlob);
  assert.equal(check.status, 'update-available');
  assert.deepEqual(check.previews, []);
});
