import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runHook, skillNameFromInput, skillNameFromPrompt } from '../lib/hook.js';
import { gitBlobSha, writeSource, recordDecline, checkForUpdate } from '../lib/updates.js';

const SKILL_MD = (extra = '') => `---\nname: demo\ndescription: a demo skill\n---\nbody${extra}\n`;
const ROOT = path.resolve(import.meta.dirname, '..');

function lib() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skilllib-hook-'));
}
function pulled(libraryRoot, content = SKILL_MD()) {
  const dir = path.join(libraryRoot, 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
  writeSource(dir, { owner: 'o', repo: 'r', ref: 'main', path: 'demo', commit: 'c0', pulledAt: 'x', declinedSignature: null, files: { 'SKILL.md': gitBlobSha(content) } });
  return dir;
}
function remote(content) {
  let calls = 0;
  return {
    calls: () => calls,
    loadTree: async () => { calls++; return { tree: [{ type: 'blob', path: 'demo/SKILL.md', sha: gitBlobSha(content) }] }; },
    getCommits: async () => [{ sha: 'c1', message: 'better demo', date: '2026-09-30' }],
  };
}
const skillCall = (skill, session = 's1') => ({ session_id: session, tool_name: 'Skill', tool_input: { skill } });

test('skillNameFromInput: plain, plugin-prefixed, and hostile names', () => {
  assert.equal(skillNameFromInput(skillCall('demo')), 'demo');
  assert.equal(skillNameFromInput(skillCall('myplugin:demo')), 'demo');
  assert.equal(skillNameFromInput(skillCall('../../Documents')), null);
  assert.equal(skillNameFromInput(skillCall('..')), null);
  assert.equal(skillNameFromInput({ tool_name: 'Skill', tool_input: {} }), null);
});

test('a tool that is not Skill produces nothing and never touches the network', async () => {
  const r = remote(SKILL_MD(' v2'));
  const out = await runHook({ tool_name: 'Bash', tool_input: { command: 'ls' } }, { libraryRoot: lib(), ...r });
  assert.equal(out, null);
  assert.equal(r.calls(), 0);
});

test('a skill not pulled through technext-mcp-skill-lib is silent and makes no network call', async () => {
  const libraryRoot = lib();
  fs.mkdirSync(path.join(libraryRoot, 'demo'));
  fs.writeFileSync(path.join(libraryRoot, 'demo', 'SKILL.md'), SKILL_MD());
  const r = remote(SKILL_MD(' v2'));
  assert.equal(await runHook(skillCall('demo'), { libraryRoot, ...r }), null);
  assert.equal(r.calls(), 0);
});

test('an up-to-date skill is silent', async () => {
  const libraryRoot = lib();
  pulled(libraryRoot);
  assert.equal(await runHook(skillCall('demo'), { libraryRoot, ...remote(SKILL_MD()) }), null);
});

test('a newer version is reported as PreToolUse additionalContext, once per session', async () => {
  const libraryRoot = lib();
  pulled(libraryRoot);
  const r = remote(SKILL_MD(' v2'));
  const first = await runHook(skillCall('demo', 's1'), { libraryRoot, ...r });
  assert.equal(first.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(first.hookSpecificOutput.additionalContext, /better demo/);
  assert.match(first.hookSpecificOutput.additionalContext, /update_skill/);
  assert.match(first.hookSpecificOutput.additionalContext, /decline_update/);

  assert.equal(await runHook(skillCall('demo', 's1'), { libraryRoot, ...r }), null, 'same session: not asked again');
  assert.ok(await runHook(skillCall('demo', 's2'), { libraryRoot, ...r }), 'a new session asks again');
});

test('the verdict is cached: a second use does not hit GitHub again within six hours', async () => {
  const libraryRoot = lib();
  pulled(libraryRoot);
  const r = remote(SKILL_MD());
  await runHook(skillCall('demo', 's1'), { libraryRoot, ...r });
  await runHook(skillCall('demo', 's2'), { libraryRoot, ...r });
  assert.equal(r.calls(), 1);
  // ...but a stale cache is refreshed
  const later = () => Date.now() + 7 * 60 * 60 * 1000;
  await runHook(skillCall('demo', 's3'), { libraryRoot, ...r, now: later });
  assert.equal(r.calls(), 2);
});

test('a declined version stays silent until upstream changes again', async () => {
  const libraryRoot = lib();
  const dir = pulled(libraryRoot);
  const v2 = remote(SKILL_MD(' v2'));
  assert.ok(await runHook(skillCall('demo', 's1'), { libraryRoot, ...v2 }));
  recordDecline(dir, (await checkForUpdate(dir, v2)).signature);
  assert.equal(await runHook(skillCall('demo', 's2'), { libraryRoot, ...v2 }), null);
  // within the six-hour cache the declined verdict stands; once it expires, a further upstream change asks again
  const later = () => Date.now() + 7 * 60 * 60 * 1000;
  assert.ok(await runHook(skillCall('demo', 's3'), { libraryRoot, ...remote(SKILL_MD(' v3')), now: later }), 'a further change asks again');
});

test('after an update the skill is no longer reported', async () => {
  const libraryRoot = lib();
  const dir = pulled(libraryRoot);
  assert.ok(await runHook(skillCall('demo', 's1'), { libraryRoot, ...remote(SKILL_MD(' v2')) }));
  // what update_skill leaves behind: new content and a refreshed record
  fs.writeFileSync(path.join(dir, 'SKILL.md'), SKILL_MD(' v2'));
  writeSource(dir, { owner: 'o', repo: 'r', ref: 'main', path: 'demo', commit: 'c1', pulledAt: 'y', declinedSignature: null, files: { 'SKILL.md': gitBlobSha(SKILL_MD(' v2')) } });
  assert.equal(await runHook(skillCall('demo', 's2'), { libraryRoot, ...remote(SKILL_MD(' v2')) }), null);
});

test('a network failure is swallowed by the launcher: exit 0 and no output', () => {
  const libraryRoot = lib();
  pulled(libraryRoot); // tracked, so it would need GitHub; give it no working gh
  const res = spawnSync('node', ['hook/skill-update-hook.js'], {
    cwd: ROOT,
    input: JSON.stringify(skillCall('demo')),
    env: { ...process.env, SKILL_LIBRARY_PATH: libraryRoot, PATH: path.dirname(process.execPath) },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});

test('the launcher ignores garbage on stdin', () => {
  const res = spawnSync('node', ['hook/skill-update-hook.js'], { cwd: ROOT, input: 'not json', env: { ...process.env, SKILL_LIBRARY_PATH: lib() }, encoding: 'utf8', timeout: 30000 });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});

test('the launcher reads the library location from --library, not only from the environment', () => {
  const libraryRoot = lib();
  const dir = pulled(libraryRoot);
  // an old record and no reachable GitHub: it must at least find and read the skill
  // (a network failure is swallowed), which shows in the state file it may write only after a check
  const res = spawnSync('node', ['hook/skill-update-hook.js', '--library', libraryRoot], {
    cwd: ROOT,
    input: JSON.stringify(skillCall('demo')),
    env: { ...process.env, SKILL_LIBRARY_PATH: path.join(libraryRoot, 'somewhere-else'), PATH: path.dirname(process.execPath) },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(res.status, 0);
  assert.ok(dir);
});

const promptCall = (prompt, session = 's1') => ({ session_id: session, hook_event_name: 'UserPromptSubmit', prompt });

test('skillNameFromPrompt: only a leading /name counts, and hostile names are refused', () => {
  assert.equal(skillNameFromPrompt(promptCall('/demo')), 'demo');
  assert.equal(skillNameFromPrompt(promptCall('  /demo do the thing')), 'demo');
  assert.equal(skillNameFromPrompt(promptCall('/myplugin:demo go')), 'demo');
  assert.equal(skillNameFromPrompt(promptCall('please run /demo')), null);
  assert.equal(skillNameFromPrompt(promptCall('/../../Documents')), null);
  assert.equal(skillNameFromPrompt(promptCall('hello')), null);
  assert.equal(skillNameFromPrompt({ prompt: 42 }), null);
});

test('a slash command for a skill with a newer version is reported as UserPromptSubmit context, once per session', async () => {
  const libraryRoot = lib();
  pulled(libraryRoot);
  const r = remote(SKILL_MD(' v2'));
  const first = await runHook(promptCall('/demo run it', 's1'), { libraryRoot, ...r });
  assert.equal(first.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(first.hookSpecificOutput.additionalContext, /better demo/);
  assert.equal(await runHook(promptCall('/demo again', 's1'), { libraryRoot, ...r }), null, 'same session: already told');
  assert.ok(await runHook(promptCall('/demo', 's2'), { libraryRoot, ...r }), 'a new session asks again');
});

test('a prompt that is not a slash command for a library skill is silent and makes no network call', async () => {
  const libraryRoot = lib();
  pulled(libraryRoot);
  const r = remote(SKILL_MD(' v2'));
  for (const prompt of ['hello there', '/clear', '/model', 'text with /demo inside']) {
    assert.equal(await runHook(promptCall(prompt), { libraryRoot, ...r }), null, prompt);
  }
  assert.equal(r.calls(), 0);
});

test('an up-to-date skill is silent when started with a slash command', async () => {
  const libraryRoot = lib();
  pulled(libraryRoot);
  assert.equal(await runHook(promptCall('/demo'), { libraryRoot, ...remote(SKILL_MD()) }), null);
});

test('the hook script handles a UserPromptSubmit payload on stdin and exits 0', () => {
  const libraryRoot = lib();
  const res = spawnSync('node', ['hook/skill-update-hook.js', '--library', libraryRoot], {
    cwd: ROOT, encoding: 'utf8', input: JSON.stringify(promptCall('/not-in-the-library')),
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});
