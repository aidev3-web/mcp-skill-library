import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { addHook, removeHook, buildCommand } from '../lib/hookconfig.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = '/opt/mcp/hook/skill-update-hook.js';
const OTHER = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] };

test('adds the hook to empty settings', () => {
  const { settings, change } = addHook({}, SCRIPT);
  assert.equal(change, 'added');
  assert.deepEqual(settings.hooks.PreToolUse, [{ matcher: 'Skill', hooks: [{ type: 'command', command: buildCommand(SCRIPT), timeout: 15 }] }]);
});

test('keeps every other setting and hook the user already has', () => {
  const before = { model: 'x', hooks: { PreToolUse: [OTHER], Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } };
  const { settings } = addHook(before, SCRIPT);
  assert.equal(settings.model, 'x');
  assert.deepEqual(settings.hooks.Stop, before.hooks.Stop);
  assert.deepEqual(settings.hooks.PreToolUse[0], OTHER);
  assert.equal(settings.hooks.PreToolUse.length, 2);
});

test('is idempotent, and a moved install updates the path instead of adding a second hook', () => {
  const once = addHook({}, SCRIPT).settings;
  assert.equal(addHook(once, SCRIPT).change, 'unchanged');
  const moved = addHook(once, '/new/place/hook/skill-update-hook.js');
  assert.equal(moved.change, 'updated');
  assert.equal(moved.settings.hooks.PreToolUse.length, 1);
  assert.match(moved.settings.hooks.PreToolUse[0].hooks[0].command, /new\/place/);
});

test('does not mutate its input', () => {
  const input = { hooks: { PreToolUse: [OTHER] } };
  const snapshot = JSON.stringify(input);
  addHook(input, SCRIPT);
  removeHook(input);
  assert.equal(JSON.stringify(input), snapshot);
});

test('refuses settings whose hooks shape it cannot safely extend', () => {
  assert.throws(() => addHook({ hooks: [] }, SCRIPT), /not an object/);
  assert.throws(() => addHook({ hooks: { PreToolUse: {} } }, SCRIPT), /not an array/);
  assert.throws(() => addHook(null, SCRIPT), /JSON object/);
});

test('remove takes out only this hook and tidies up what it emptied', () => {
  const both = addHook({ hooks: { PreToolUse: [OTHER] } }, SCRIPT).settings;
  const r = removeHook(both);
  assert.equal(r.removed, 1);
  assert.deepEqual(r.settings.hooks.PreToolUse, [OTHER]);

  const alone = removeHook(addHook({}, SCRIPT).settings);
  assert.equal(alone.removed, 1);
  assert.equal(alone.settings.hooks, undefined);

  assert.equal(removeHook({ hooks: { PreToolUse: [OTHER] } }).removed, 0);
});

function run(args, settingsPath) {
  return spawnSync('node', ['hook/install-hook.js', '--settings', settingsPath, ...args], { cwd: ROOT, encoding: 'utf8' });
}

test('installer: dry run by default writes nothing; --apply writes with a backup; --remove reverses it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hookcfg-'));
  const file = path.join(dir, 'settings.json');
  const original = JSON.stringify({ model: 'x', hooks: { PreToolUse: [OTHER] } }, null, 2);
  fs.writeFileSync(file, original);

  const dry = run([], file);
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /Dry run only/);
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'dry run leaves the file byte-identical');

  const applied = run(['--apply'], file);
  assert.equal(applied.status, 0);
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('settings.json.bak-')).length, 1, 'a backup exists');
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.model, 'x');
  assert.equal(after.hooks.PreToolUse.length, 2);
  assert.match(after.hooks.PreToolUse[1].hooks[0].command, /skill-update-hook\.js/);

  assert.match(run(['--apply'], file).stdout, /already installed/);

  const removed = run(['--remove', '--apply'], file);
  assert.equal(removed.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PreToolUse, [OTHER]);
});

test('installer: a settings file that is not valid JSON is refused and left alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hookcfg-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{ "model": ');
  const res = run(['--apply'], file);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "model": ');
});

test('installer: creates the settings file when there is none (only with --apply)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hookcfg-'));
  const file = path.join(dir, 'sub', 'settings.json');
  assert.equal(run([], file).status, 0);
  assert.equal(fs.existsSync(file), false);
  assert.equal(run(['--apply'], file).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PreToolUse.length, 1);
});
