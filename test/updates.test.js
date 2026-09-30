import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  textDiffSummary,
  describeUpdate,
  SOURCE_FILE,
  gitBlobSha,
  signatureOf,
  readSource,
  writeSource,
  remoteFilesFromTree,
  diffFiles,
  localModifications,
  checkForUpdate,
  performUpdate,
  recordDecline,
  syncAgentFiles,
} from '../lib/updates.js';
import { getCommitsForPath, __setGhRunner } from '../lib/github.js';

const SKILL_MD = (extra = '') => `---\nname: demo\ndescription: a demo skill\n---\nbody${extra}\n`;

function makeLibrary() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skilllib-updates-'));
}

// Builds a pulled skill folder plus the matching .source.json, like pull_skill does.
function makePulledSkill(lib, files) {
  const dir = path.join(lib, 'demo');
  const recorded = {};
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
    recorded[rel] = gitBlobSha(content);
  }
  writeSource(dir, { owner: 'o', repo: 'r', ref: 'main', path: 'demo', commit: 'c0', pulledAt: 'x', declinedSignature: null, files: recorded });
  return dir;
}

// A remote repo is just { "demo/SKILL.md": "content", ... }; the fake tree
// reports the same blob shas GitHub would.
function fakeRemote(files) {
  const tree = Object.entries(files).map(([p, content]) => ({ type: 'blob', path: p, sha: gitBlobSha(content) }));
  const blobs = new Map(Object.values(files).map((c) => [gitBlobSha(c), Buffer.from(c)]));
  return {
    loadTree: async () => ({ tree }),
    getCommits: async () => [{ sha: 'c1', message: 'improve demo', date: '2026-09-30' }],
    fetchBlob: async (_o, _r, sha) => blobs.get(sha),
  };
}

test('gitBlobSha matches git hash-object for a known string', () => {
  // `printf 'hello\n' | git hash-object --stdin`
  assert.equal(gitBlobSha('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('diffFiles reports added, changed and removed files', () => {
  const d = diffFiles({ a: '1', b: '2', c: '3' }, { a: '1', b: 'x', d: '4' });
  assert.deepEqual(d, { added: ['d'], changed: ['b'], removed: ['c'] });
});

test('remoteFilesFromTree keeps only blobs under the skill folder', () => {
  const tree = [
    { type: 'blob', path: 'demo/SKILL.md', sha: 'a' },
    { type: 'blob', path: 'demo/assets/x.md', sha: 'b' },
    { type: 'blob', path: 'demo2/SKILL.md', sha: 'c' },
    { type: 'tree', path: 'demo/assets', sha: 'd' },
  ];
  assert.deepEqual(remoteFilesFromTree(tree, 'demo'), { 'SKILL.md': 'a', 'assets/x.md': 'b' });
});

test('untracked skill (no .source.json) reports nothing to do', async () => {
  const lib = makeLibrary();
  fs.mkdirSync(path.join(lib, 'demo'));
  fs.writeFileSync(path.join(lib, 'demo', 'SKILL.md'), SKILL_MD());
  const noNetwork = { loadTree: async () => { throw new Error('must not be called'); }, getCommits: async () => { throw new Error('must not be called'); } };
  const r = await checkForUpdate(path.join(lib, 'demo'), noNetwork);
  assert.equal(r.status, 'untracked');
});

test('same content upstream -> up-to-date', async () => {
  const lib = makeLibrary();
  const dir = makePulledSkill(lib, { 'SKILL.md': SKILL_MD() });
  const r = await checkForUpdate(dir, fakeRemote({ 'demo/SKILL.md': SKILL_MD() }));
  assert.equal(r.status, 'up-to-date');
});

test('changed upstream -> update-available with the file list and commits', async () => {
  const lib = makeLibrary();
  const dir = makePulledSkill(lib, { 'SKILL.md': SKILL_MD() });
  const r = await checkForUpdate(dir, fakeRemote({ 'demo/SKILL.md': SKILL_MD(' v2'), 'demo/assets/new.md': 'n' }));
  assert.equal(r.status, 'update-available');
  assert.deepEqual(r.diff.changed, ['SKILL.md']);
  assert.deepEqual(r.diff.added, ['assets/new.md']);
  assert.equal(r.commits[0].message, 'improve demo');
  assert.deepEqual(r.conflicts, []);
});

test('skill folder gone upstream -> removed-upstream, never an update', async () => {
  const lib = makeLibrary();
  const dir = makePulledSkill(lib, { 'SKILL.md': SKILL_MD() });
  const r = await checkForUpdate(dir, fakeRemote({ 'other/SKILL.md': 'x' }));
  assert.equal(r.status, 'removed-upstream');
});

test('decline: silent for the declined state, asks again once upstream changes further', async () => {
  const lib = makeLibrary();
  const dir = makePulledSkill(lib, { 'SKILL.md': SKILL_MD() });
  const v2 = fakeRemote({ 'demo/SKILL.md': SKILL_MD(' v2') });
  const first = await checkForUpdate(dir, v2);
  assert.equal(first.status, 'update-available');

  assert.equal(recordDecline(dir, first.signature), true);
  assert.equal((await checkForUpdate(dir, v2)).status, 'declined');

  const v3 = fakeRemote({ 'demo/SKILL.md': SKILL_MD(' v3') });
  assert.equal((await checkForUpdate(dir, v3)).status, 'update-available');
});

test('update applies added/changed/removed files, keeps a backup, refreshes .source.json', async () => {
  const lib = makeLibrary();
  const dir = makePulledSkill(lib, { 'SKILL.md': SKILL_MD(), 'old.md': 'old' });
  const remote = fakeRemote({ 'demo/SKILL.md': SKILL_MD(' v2'), 'demo/assets/new.md': 'new' });
  const check = await checkForUpdate(dir, remote);
  const history = path.join(lib, '.history');

  const res = await performUpdate(dir, { check, fetchBlob: remote.fetchBlob, historyRoot: history });

  assert.equal(res.status, 'updated');
  assert.match(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), /v2/);
  assert.equal(fs.readFileSync(path.join(dir, 'assets', 'new.md'), 'utf8'), 'new');
  assert.equal(fs.existsSync(path.join(dir, 'old.md')), false);
  assert.ok(fs.existsSync(path.join(res.backup, 'old.md')), 'backup holds the previous version');
  const src = readSource(dir);
  assert.equal(src.files['SKILL.md'], gitBlobSha(SKILL_MD(' v2')));
  assert.equal(src.declinedSignature, null);
  assert.equal((await checkForUpdate(dir, remote)).status, 'up-to-date');
});

test('a file the user edited is never overwritten without force', async () => {
  const lib = makeLibrary();
  const dir = makePulledSkill(lib, { 'SKILL.md': SKILL_MD() });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), SKILL_MD(' my own edit'));
  const remote = fakeRemote({ 'demo/SKILL.md': SKILL_MD(' v2') });
  const check = await checkForUpdate(dir, remote);
  assert.deepEqual(check.conflicts, ['SKILL.md']);

  const blocked = await performUpdate(dir, { check, fetchBlob: remote.fetchBlob, historyRoot: path.join(lib, '.history') });
  assert.equal(blocked.status, 'conflict');
  assert.match(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), /my own edit/);

  const forced = await performUpdate(dir, { check, fetchBlob: remote.fetchBlob, historyRoot: path.join(lib, '.history'), force: true });
  assert.equal(forced.status, 'updated');
  assert.match(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), /v2/);
  assert.match(fs.readFileSync(path.join(forced.backup, 'SKILL.md'), 'utf8'), /my own edit/);
});

test('a local edit to a file upstream did not touch is not a conflict', async () => {
  const lib = makeLibrary();
  const dir = makePulledSkill(lib, { 'SKILL.md': SKILL_MD(), 'notes.md': 'a' });
  fs.writeFileSync(path.join(dir, 'notes.md'), 'edited locally');
  const remote = fakeRemote({ 'demo/SKILL.md': SKILL_MD(' v2'), 'demo/notes.md': 'a' });
  const check = await checkForUpdate(dir, remote);
  assert.deepEqual(check.conflicts, []);
  const res = await performUpdate(dir, { check, fetchBlob: remote.fetchBlob, historyRoot: path.join(lib, '.history') });
  assert.equal(res.status, 'updated');
  assert.equal(fs.readFileSync(path.join(dir, 'notes.md'), 'utf8'), 'edited locally');
});

test('dryRun changes nothing on disk', async () => {
  const lib = makeLibrary();
  const dir = makePulledSkill(lib, { 'SKILL.md': SKILL_MD() });
  const remote = fakeRemote({ 'demo/SKILL.md': SKILL_MD(' v2') });
  const check = await checkForUpdate(dir, remote);
  const res = await performUpdate(dir, { check, fetchBlob: remote.fetchBlob, historyRoot: path.join(lib, '.history'), dryRun: true });
  assert.equal(res.status, 'dry-run');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), /v2/);
  assert.equal(fs.existsSync(path.join(lib, '.history')), false);
});

test('an upstream state that fails validation is refused and leaves the skill untouched', async () => {
  const lib = makeLibrary();
  const dir = makePulledSkill(lib, { 'SKILL.md': SKILL_MD() });
  const remote = fakeRemote({ 'demo/SKILL.md': 'no frontmatter at all\n' });
  const check = await checkForUpdate(dir, remote);
  const res = await performUpdate(dir, { check, fetchBlob: remote.fetchBlob, historyRoot: path.join(lib, '.history') });
  assert.equal(res.status, 'invalid');
  assert.equal(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), SKILL_MD());
  assert.equal(fs.readdirSync(lib).some((n) => n.startsWith('.update-')), false, 'no staging folder left behind');
});

test('a remote path that escapes the skill folder is refused', async () => {
  const lib = makeLibrary();
  const dir = makePulledSkill(lib, { 'SKILL.md': SKILL_MD() });
  const remote = fakeRemote({ 'demo/SKILL.md': SKILL_MD(), 'demo/../evil.txt': 'x' });
  const check = await checkForUpdate(dir, remote);
  const res = await performUpdate(dir, { check, fetchBlob: remote.fetchBlob, historyRoot: path.join(lib, '.history') });
  assert.equal(res.status, 'error');
  assert.equal(fs.existsSync(path.join(lib, 'evil.txt')), false);
});

test('a network failure while fetching a file leaves the skill untouched', async () => {
  const lib = makeLibrary();
  const dir = makePulledSkill(lib, { 'SKILL.md': SKILL_MD() });
  const remote = fakeRemote({ 'demo/SKILL.md': SKILL_MD(' v2') });
  const check = await checkForUpdate(dir, remote);
  await assert.rejects(() =>
    performUpdate(dir, { check, fetchBlob: async () => { throw new Error('offline'); }, historyRoot: path.join(lib, '.history') }),
  );
  assert.equal(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), SKILL_MD());
});

test('localModifications flags edited and deleted files only', () => {
  const lib = makeLibrary();
  const dir = makePulledSkill(lib, { 'SKILL.md': SKILL_MD(), 'a.md': 'a', 'b.md': 'b' });
  fs.writeFileSync(path.join(dir, 'a.md'), 'changed');
  fs.rmSync(path.join(dir, 'b.md'));
  assert.deepEqual(localModifications(dir, readSource(dir).files), ['a.md', 'b.md']);
});

test('agent files: copied when missing, replaced when unedited, kept when the user edited them', () => {
  const lib = makeLibrary();
  const dir = path.join(lib, 'demo');
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents', 'a.md'), 'new-a');
  fs.writeFileSync(path.join(dir, 'agents', 'b.md'), 'new-b');
  fs.writeFileSync(path.join(dir, 'agents', 'c.md'), 'same-c');
  const host = path.join(lib, 'host-agents');
  fs.mkdirSync(host);
  fs.writeFileSync(path.join(host, 'a.md'), 'old-a'); // unedited copy of the previous version
  fs.writeFileSync(path.join(host, 'b.md'), 'user edit'); // the user's own change
  fs.writeFileSync(path.join(host, 'c.md'), 'same-c');

  const old = { 'agents/a.md': gitBlobSha('old-a'), 'agents/b.md': gitBlobSha('old-b') };
  const res = Object.fromEntries(syncAgentFiles(dir, [host], { oldHashes: old }).map((r) => [r.file, r.status]));

  assert.deepEqual(res, { 'a.md': 'updated', 'b.md': 'skipped-edited', 'c.md': 'up-to-date' });
  assert.equal(fs.readFileSync(path.join(host, 'a.md'), 'utf8'), 'new-a');
  assert.equal(fs.readFileSync(path.join(host, 'b.md'), 'utf8'), 'user edit');

  const forced = syncAgentFiles(dir, [host], { oldHashes: old, force: true });
  assert.equal(forced.find((r) => r.file === 'b.md').status, 'overwritten');
  assert.equal(fs.readFileSync(path.join(host, 'b.md'), 'utf8'), 'new-b');
});

test('agent sync dry run and a skill without agents/ do nothing', () => {
  const lib = makeLibrary();
  const dir = path.join(lib, 'demo');
  fs.mkdirSync(dir);
  assert.deepEqual(syncAgentFiles(dir, [path.join(lib, 'h')]), []);
  fs.mkdirSync(path.join(dir, 'agents'));
  fs.writeFileSync(path.join(dir, 'agents', 'a.md'), 'x');
  const r = syncAgentFiles(dir, [path.join(lib, 'h')], { dryRun: true });
  assert.equal(r[0].status, 'copied');
  assert.equal(fs.existsSync(path.join(lib, 'h')), false);
});

test('signatureOf is order independent and changes with content', () => {
  assert.equal(signatureOf({ a: '1', b: '2' }), signatureOf({ b: '2', a: '1' }));
  assert.notEqual(signatureOf({ a: '1' }), signatureOf({ a: '2' }));
});

test('getCommitsForPath keeps the first line of each message', async () => {
  __setGhRunner(async () => ({
    code: 0,
    stderr: '',
    stdout: JSON.stringify([{ sha: 's1', commit: { message: 'fix: thing\n\nlong body', committer: { date: 'd1' } } }]),
  }));
  try {
    assert.deepEqual(await getCommitsForPath('o', 'r', 'main', 'demo'), [{ sha: 's1', message: 'fix: thing', date: 'd1' }]);
  } finally {
    __setGhRunner();
  }
});

test('SOURCE_FILE is not counted as a user file', () => {
  const lib = makeLibrary();
  const dir = makePulledSkill(lib, { 'SKILL.md': SKILL_MD() });
  assert.ok(fs.existsSync(path.join(dir, SOURCE_FILE)));
  assert.deepEqual(localModifications(dir, readSource(dir).files), []);
});

test('dryRun still lists the plan when local edits would block a real run', async () => {
  const lib = makeLibrary();
  const dir = makePulledSkill(lib, { 'SKILL.md': SKILL_MD() });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), SKILL_MD(' mine'));
  const remote = fakeRemote({ 'demo/SKILL.md': SKILL_MD(' v2') });
  const check = await checkForUpdate(dir, remote);
  const res = await performUpdate(dir, { check, fetchBlob: remote.fetchBlob, historyRoot: path.join(lib, '.history'), dryRun: true });
  assert.equal(res.status, 'dry-run');
  assert.deepEqual(res.conflicts, ['SKILL.md']);
  assert.deepEqual(res.plan.changed, ['SKILL.md']);
});

test('ignoreDeclined makes a declined state visible again (user changed their mind)', async () => {
  const lib = makeLibrary();
  const dir = makePulledSkill(lib, { 'SKILL.md': SKILL_MD() });
  const remote = fakeRemote({ 'demo/SKILL.md': SKILL_MD(' v2') });
  recordDecline(dir, (await checkForUpdate(dir, remote)).signature);
  assert.equal((await checkForUpdate(dir, remote)).status, 'declined');
  assert.equal((await checkForUpdate(dir, { ...remote, ignoreDeclined: true })).status, 'update-available');
});
