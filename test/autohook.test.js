import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureHook, claudeConfigDir } from '../lib/autohook.js';
import { removeHook } from '../lib/hookconfig.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOOK = '/opt/mcp/hook/skill-update-hook.js';

function machine({ settings, claudeInstalled = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autohook-'));
  const configDir = path.join(home, '.claude');
  if (claudeInstalled) fs.mkdirSync(configDir);
  if (settings !== undefined) fs.writeFileSync(path.join(configDir, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
  return { home, configDir, libraryRoot: path.join(home, '.skill-library'), settingsPath: path.join(configDir, 'settings.json') };
}
const read = (m) => JSON.parse(fs.readFileSync(m.settingsPath, 'utf8'));

test('first run installs the hook, backs up the old settings and keeps the rest', () => {
  const m = machine({ settings: { model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } } });
  const logs = [];
  const r = ensureHook({ ...m, hookScript: HOOK, log: (l) => logs.push(l) });
  assert.equal(r.action, 'installed');
  const s = read(m);
  assert.equal(s.model, 'x');
  assert.ok(s.hooks.Stop, 'unrelated hooks untouched');
  assert.equal(s.hooks.PreToolUse[0].matcher, 'Skill');
  assert.equal(fs.readdirSync(m.configDir).filter((n) => n.startsWith('settings.json.bak-')).length, 1);
  assert.match(logs.join('\n'), /SKILL_LIB_AUTO_HOOK=0/, 'tells the user how to turn it off');
});

test('creates settings.json when Claude Code is installed but has none', () => {
  const m = machine();
  assert.equal(ensureHook({ ...m, hookScript: HOOK }).action, 'installed');
  assert.equal(read(m).hooks.PreToolUse.length, 1);
});

test('a machine without Claude Code is left completely alone', () => {
  const m = machine({ claudeInstalled: false });
  assert.equal(ensureHook({ ...m, hookScript: HOOK }).action, 'no-claude-code');
  assert.equal(fs.existsSync(m.configDir), false);
});

test('SKILL_LIB_AUTO_HOOK=0 (enabled: false) writes nothing at all', () => {
  const m = machine({ settings: { model: 'x' } });
  assert.equal(ensureHook({ ...m, hookScript: HOOK, enabled: false }).action, 'disabled');
  assert.deepEqual(read(m), { model: 'x' });
  assert.equal(fs.existsSync(m.libraryRoot), false);
});

test('later runs change nothing; a moved install only updates the path', () => {
  const m = machine();
  ensureHook({ ...m, hookScript: HOOK });
  const before = fs.readFileSync(m.settingsPath, 'utf8');
  assert.equal(ensureHook({ ...m, hookScript: HOOK }).action, 'up-to-date');
  assert.equal(fs.readFileSync(m.settingsPath, 'utf8'), before);

  assert.equal(ensureHook({ ...m, hookScript: '/moved/hook/skill-update-hook.js' }).action, 'path-updated');
  assert.equal(read(m).hooks.PreToolUse.length, 1);
  assert.match(read(m).hooks.PreToolUse[0].hooks[0].command, /moved/);
});

test('a user who removed the hook is never re-enrolled', () => {
  const m = machine();
  ensureHook({ ...m, hookScript: HOOK });
  fs.writeFileSync(m.settingsPath, JSON.stringify(removeHook(read(m)).settings));
  assert.equal(ensureHook({ ...m, hookScript: HOOK }).action, 'already-handled');
  assert.equal(read(m).hooks, undefined);
});

test('a settings file that is not valid JSON is left byte-identical', () => {
  const m = machine({ settings: '{ "model": ' });
  const logs = [];
  assert.equal(ensureHook({ ...m, hookScript: HOOK, log: (l) => logs.push(l) }).action, 'invalid-settings');
  assert.equal(fs.readFileSync(m.settingsPath, 'utf8'), '{ "model": ');
  assert.match(logs.join(''), /not valid JSON/);
});

test('settings with an unexpected hooks shape are skipped, not clobbered', () => {
  const m = machine({ settings: { hooks: [] } });
  assert.equal(ensureHook({ ...m, hookScript: HOOK }).action, 'error');
  assert.deepEqual(read(m), { hooks: [] });
});

test('CLAUDE_CONFIG_DIR is honoured', () => {
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/x/cfg' }, '/home/u'), path.resolve('/x/cfg'));
  assert.equal(claudeConfigDir({}, '/home/u'), path.join('/home/u', '.claude'));
});

// The real server, pointed at a throwaway home: proves the install happens on start-up
// through the actual entry point, and that the opt-out works there too.
function boot(home, extraEnv = {}) {
  const env = { ...process.env, USERPROFILE: home, HOME: home, SKILL_LIBRARY_PATH: path.join(home, '.skill-library'), ...extraEnv };
  delete env.CLAUDE_CONFIG_DIR;
  return spawnSync('node', ['index.js'], { cwd: ROOT, env, input: '', encoding: 'utf8', timeout: 20000 });
}

test('starting the real server installs the hook on a machine that has Claude Code', () => {
  const m = machine();
  const res = boot(m.home);
  assert.match(res.stderr, /installed the skill-update hook/);
  assert.equal(res.stdout, '', 'nothing on stdout: that stream belongs to the MCP protocol');
  assert.equal(read(m).hooks.PreToolUse[0].hooks[0].command.includes('skill-update-hook.js'), true);
});

test('starting the real server with SKILL_LIB_AUTO_HOOK=0 leaves settings untouched', () => {
  const m = machine({ settings: { model: 'x' } });
  boot(m.home, { SKILL_LIB_AUTO_HOOK: '0' });
  assert.deepEqual(read(m), { model: 'x' });
});

test('a custom library location is written into the hook command (the hook has no env of its own)', () => {
  const m = machine();
  assert.equal(ensureHook({ ...m, hookScript: HOOK, customLibrary: true }).action, 'installed');
  const cmd = read(m).hooks.PreToolUse[0].hooks[0].command;
  assert.ok(cmd.includes(`--library "${m.libraryRoot}"`), cmd);
  // and the default location adds nothing
  const d = machine();
  ensureHook({ ...d, hookScript: HOOK });
  assert.ok(!read(d).hooks.PreToolUse[0].hooks[0].command.includes('--library'));
});

test('changing the library location later updates the same hook entry', () => {
  const m = machine();
  ensureHook({ ...m, hookScript: HOOK });
  assert.equal(ensureHook({ ...m, hookScript: HOOK, customLibrary: true }).action, 'path-updated');
  assert.equal(read(m).hooks.PreToolUse.length, 1);
});
