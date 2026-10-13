import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runSetupHook } from '../lib/setuphook.js';
import { addSetupHook, removeSetupHook, addHook } from '../lib/hookconfig.js';
import { ensureSetupHook } from '../lib/autohook.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const env = () => ({ libraryRoot: tmp('setup-lib-'), home: tmp('setup-home-') });
const start = (cwd, extra = {}) => ({ hook_event_name: 'SessionStart', source: 'startup', cwd, session_id: 's', ...extra });

test('an empty project gets a reminder naming recommend_setup and the folder', () => {
  const e = env();
  const cwd = tmp('proj-');
  const out = runSetupHook(start(cwd), e);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /recommend_setup/);
  assert.match(out.hookSpecificOutput.additionalContext, /empty/);
  assert.ok(out.hookSpecificOutput.additionalContext.includes(cwd));
});

test('a project with code but no CLAUDE.md mentions what was detected', () => {
  const cwd = tmp('proj-');
  fs.writeFileSync(path.join(cwd, 'requirements.txt'), 'streamlit\n');
  assert.match(runSetupHook(start(cwd), env()).hookSpecificOutput.additionalContext, /lang:python/);
});

test('says nothing when CLAUDE.md exists', () => {
  const cwd = tmp('proj-');
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# x');
  assert.equal(runSetupHook(start(cwd), env()), null);
});

test('reminds only once per project', () => {
  const e = env();
  const cwd = tmp('proj-');
  assert.ok(runSetupHook(start(cwd), e));
  assert.equal(runSetupHook(start(cwd), e), null);
  assert.ok(runSetupHook(start(tmp('proj-')), e), 'a different project still gets one');
});

test('only a fresh start counts, not resume/clear/compact or other events', () => {
  const cwd = tmp('proj-');
  for (const source of ['resume', 'clear', 'compact']) assert.equal(runSetupHook(start(cwd, { source }), env()), null);
  assert.equal(runSetupHook(start(cwd, { hook_event_name: 'UserPromptSubmit' }), env()), null);
});

test('never fires in the home directory, a drive root, a missing folder or no cwd', () => {
  const e = env();
  assert.equal(runSetupHook(start(e.home), e), null);
  assert.equal(runSetupHook(start(path.parse(process.cwd()).root), e), null);
  assert.equal(runSetupHook(start(path.join(e.home, 'nope')), e), null);
  assert.equal(runSetupHook({ hook_event_name: 'SessionStart', source: 'startup' }, e), null);
  assert.equal(runSetupHook(start(''), e), null, 'an empty cwd must not fall back to the process directory');
});

test('never writes into the project folder', () => {
  const cwd = tmp('proj-');
  runSetupHook(start(cwd), env());
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('the hook script prints the JSON for a fresh project and nothing for a known one', () => {
  const lib = tmp('setup-lib-');
  const cwd = tmp('proj-');
  const script = path.resolve(import.meta.dirname, '..', 'hook', 'project-setup-hook.js');
  const run = () => spawnSync(process.execPath, [script, '--library', lib], { input: JSON.stringify(start(cwd)), encoding: 'utf8' });
  const first = run();
  assert.equal(first.status, 0);
  assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /recommend_setup/);
  assert.equal(run().stdout, '');
  assert.equal(spawnSync(process.execPath, [script, '--library', lib], { input: 'not json', encoding: 'utf8' }).status, 0);
});

test('addSetupHook adds a SessionStart/startup entry, is idempotent, and follows a moved install', () => {
  const a = addSetupHook({ model: 'x', hooks: { Stop: [] } }, '/old/project-setup-hook.js');
  assert.equal(a.change, 'added');
  assert.equal(a.settings.model, 'x');
  assert.equal(a.settings.hooks.SessionStart[0].matcher, 'startup');
  assert.equal(addSetupHook(a.settings, '/old/project-setup-hook.js').change, 'unchanged');
  const moved = addSetupHook(a.settings, '/new/project-setup-hook.js');
  assert.equal(moved.change, 'updated');
  assert.equal(moved.settings.hooks.SessionStart.length, 1);
});

test('removeSetupHook removes only our entry and leaves the skill-update hook and others alone', () => {
  let s = addHook({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }, '/p/skill-update-hook.js').settings;
  s = addSetupHook(s, '/p/project-setup-hook.js').settings;
  const { settings, removed } = removeSetupHook(s);
  assert.equal(removed, 1);
  assert.equal(settings.hooks.SessionStart.length, 1);
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, 'echo mine');
  assert.ok(settings.hooks.PreToolUse, 'skill-update hook untouched');
});

function machine(settings) {
  const home = tmp('setup-machine-');
  const configDir = path.join(home, '.claude');
  fs.mkdirSync(configDir);
  if (settings !== undefined) fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(settings));
  return { configDir, libraryRoot: path.join(home, '.skill-library'), settingsPath: path.join(configDir, 'settings.json') };
}
const HOOK = '/opt/mcp/hook/project-setup-hook.js';

test('ensureSetupHook installs once, backs up, and respects a later removal', () => {
  const m = machine({ model: 'x' });
  assert.equal(ensureSetupHook({ ...m, hookScript: HOOK }).action, 'installed');
  const s = JSON.parse(fs.readFileSync(m.settingsPath, 'utf8'));
  assert.equal(s.model, 'x');
  assert.equal(s.hooks.SessionStart.length, 1);
  assert.equal(fs.readdirSync(m.configDir).filter((n) => n.startsWith('settings.json.bak-')).length, 1);
  assert.equal(ensureSetupHook({ ...m, hookScript: HOOK }).action, 'up-to-date');
  fs.writeFileSync(m.settingsPath, JSON.stringify(removeSetupHook(s).settings));
  assert.equal(ensureSetupHook({ ...m, hookScript: HOOK }).action, 'already-handled');
  assert.equal(JSON.parse(fs.readFileSync(m.settingsPath, 'utf8')).hooks, undefined);
});

test('ensureSetupHook does nothing when disabled, without Claude Code, or with invalid settings', () => {
  const m = machine({});
  assert.equal(ensureSetupHook({ ...m, hookScript: HOOK, enabled: false }).action, 'disabled');
  assert.equal(ensureSetupHook({ configDir: path.join(tmp('x-'), '.claude'), libraryRoot: m.libraryRoot, hookScript: HOOK }).action, 'no-claude-code');
  fs.writeFileSync(m.settingsPath, '{ nope');
  assert.equal(ensureSetupHook({ ...m, hookScript: HOOK }).action, 'invalid-settings');
  assert.equal(fs.readFileSync(m.settingsPath, 'utf8'), '{ nope');
});
