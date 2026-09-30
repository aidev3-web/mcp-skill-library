import fs from 'node:fs';
import path from 'node:path';
import { addHook } from './hookconfig.js';

// Installing this MCP server also installs the skill-update hook, once, for the
// person whose machine it runs on. Because that edits a file the user owns, it is
// built to be predictable:
//   - only ever adds this hook's own entry (see hookconfig.js); everything else in
//     settings.json is left exactly as it was, and a backup is written first;
//   - opt out with SKILL_LIB_AUTO_HOOK=0, or `node hook/install-hook.js --remove --apply`;
//   - a person who removes the hook is never re-enrolled: the first run is recorded
//     in the state file, and after that the hook is only kept pointing at the
//     current install, never re-added;
//   - a settings file that is not valid JSON, or a machine without Claude Code, is
//     left alone;
//   - nothing here may throw into the server's startup.

const STATE_FILE = '.hook-state.json';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function claudeConfigDir(env = process.env, home) {
  return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, '.claude');
}

// Returns { action } where action is one of:
//   'disabled' | 'no-claude-code' | 'installed' | 'path-updated' | 'up-to-date' |
//   'already-handled' | 'invalid-settings' | 'error'
export function ensureHook({ configDir, hookScript, libraryRoot, customLibrary = false, enabled = true, log = () => {}, now = () => new Date() }) {
  try {
    if (!enabled) return { action: 'disabled' };
    if (!fs.existsSync(configDir)) return { action: 'no-claude-code' }; // Claude Code was never run here

    const settingsPath = path.join(configDir, 'settings.json');
    let settings = {};
    const existed = fs.existsSync(settingsPath);
    if (existed) {
      try {
        settings = readJson(settingsPath);
      } catch (err) {
        log(`settings file ${settingsPath} is not valid JSON, so the skill-update hook was not installed (${err.message})`);
        return { action: 'invalid-settings' };
      }
    }

    const statePath = path.join(libraryRoot, STATE_FILE);
    let state = {};
    try {
      state = readJson(statePath);
    } catch {
      // no state yet: first run on this machine
    }

    const { settings: next, change } = addHook(settings, hookScript, customLibrary ? libraryRoot : undefined);
    const hasOurs = change !== 'added'; // 'unchanged' or 'updated' means an entry of ours already exists

    if (!hasOurs && state.handledAt) return { action: 'already-handled' }; // the user removed it: respect that
    if (change === 'unchanged') {
      if (!state.handledAt) recordState(libraryRoot, statePath, hookScript, now);
      return { action: 'up-to-date' };
    }

    if (existed) fs.copyFileSync(settingsPath, `${settingsPath}.bak-${now().toISOString().replace(/[:.]/g, '-')}`);
    writeAtomic(settingsPath, JSON.stringify(next, null, 2) + '\n');
    recordState(libraryRoot, statePath, hookScript, now);
    if (change === 'added') {
      log(`installed the skill-update hook in ${settingsPath} (it checks a skill for a newer version only when that skill is used; effective from your next Claude Code session). Turn off with SKILL_LIB_AUTO_HOOK=0 or "node ${path.join(path.dirname(hookScript), 'install-hook.js')} --remove --apply".`);
      return { action: 'installed' };
    }
    log(`updated the skill-update hook path in ${settingsPath} to this install`);
    return { action: 'path-updated' };
  } catch (err) {
    log(`could not install the skill-update hook: ${String(err?.message || err)}`);
    return { action: 'error' };
  }
}

function recordState(libraryRoot, statePath, hookScript, now) {
  fs.mkdirSync(libraryRoot, { recursive: true });
  writeAtomic(statePath, JSON.stringify({ handledAt: now().toISOString(), hookScript }, null, 2) + '\n');
}
