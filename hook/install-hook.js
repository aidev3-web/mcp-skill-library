#!/usr/bin/env node
// Turns on (or off) the optional skill-update hook for THIS user's Claude Code.
//
//   node hook/install-hook.js                 show what would change, write nothing
//   node hook/install-hook.js --apply         write it (a backup of settings.json is made first)
//   node hook/install-hook.js --remove        show what removing would change
//   node hook/install-hook.js --remove --apply
//   --settings <file>                         use another settings file (default ~/.claude/settings.json)
//   --library <dir>                           library location if it is not ~/.skill-library (SKILL_LIBRARY_PATH also works)
//
// Nothing is written without --apply, only this hook's own entry is added or
// removed, and a settings file that is not valid JSON is refused, never rewritten.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addHook, removeHook } from '../lib/hookconfig.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const valueOf = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);

const settingsPath = path.resolve(valueOf('--settings') || path.join(os.homedir(), '.claude', 'settings.json'));
const hookScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'skill-update-hook.js');
const libraryArg = valueOf('--library') ? path.resolve(valueOf('--library')) : process.env.SKILL_LIBRARY_PATH ? path.resolve(process.env.SKILL_LIBRARY_PATH) : undefined;
const apply = flag('--apply');
const remove = flag('--remove');

let settings = {};
let existed = false;
if (fs.existsSync(settingsPath)) {
  existed = true;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8') || '{}');
  } catch (err) {
    console.error(`Refusing to touch ${settingsPath}: it is not valid JSON (${err.message}). Fix it by hand first.`);
    process.exit(1);
  }
}

let result;
try {
  result = remove ? removeHook(settings) : addHook(settings, hookScript, libraryArg);
} catch (err) {
  console.error(`Refusing to change ${settingsPath}: ${err.message}`);
  process.exit(1);
}

const summary = remove
  ? result.removed ? `remove ${result.removed} skill-update hook entr${result.removed === 1 ? 'y' : 'ies'}` : 'nothing to remove'
  : { added: 'add the skill-update hook', updated: 'update the hook path to this install', unchanged: 'already installed, nothing to change' }[result.change];
const changes = remove ? result.removed > 0 : result.change !== 'unchanged';

console.log(`Settings file: ${settingsPath}${existed ? '' : ' (does not exist yet; would be created)'}`);
console.log(`Hook script  : ${hookScript}`);
console.log(`Result       : ${summary}`);
if (changes) console.log('\nResulting "hooks" section:\n' + JSON.stringify(result.settings.hooks ?? {}, null, 2));

if (!changes) process.exit(0);
if (!apply) {
  console.log('\nDry run only. Re-run with --apply to write it.');
  process.exit(0);
}
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
if (existed) {
  const backup = `${settingsPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(settingsPath, backup);
  console.log(`\nBackup written: ${backup}`);
}
fs.writeFileSync(settingsPath, JSON.stringify(result.settings, null, 2) + '\n');
console.log(remove ? 'Hook removed.' : 'Hook installed. It takes effect in your next Claude Code session.');
