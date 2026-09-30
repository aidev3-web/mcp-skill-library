// Pure helpers for adding/removing the skill-update hook in a Claude Code
// settings object. No file I/O here, so it is testable and never touches a real
// settings file by accident (hook/install-hook.js does the reading and writing).
//
// The entry is recognised by its command mentioning skill-update-hook.js, so a
// re-run is idempotent, a moved package updates its path instead of adding a
// second hook, and the user's other hooks are never touched.

export const HOOK_MARKER = 'skill-update-hook.js';

// The hook runs as its own process, without the environment the MCP server was
// registered with, so a non-default library location has to travel in the command.
export function buildCommand(hookScriptPath, libraryRoot) {
  return libraryRoot ? `node "${hookScriptPath}" --library "${libraryRoot}"` : `node "${hookScriptPath}"`;
}

function isOurs(hook) {
  return hook && typeof hook.command === 'string' && hook.command.includes(HOOK_MARKER);
}

// Returns { settings, change } where change is 'added' | 'updated' | 'unchanged'.
export function addHook(settings, hookScriptPath, libraryRoot) {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings must be a JSON object');
  const command = buildCommand(hookScriptPath, libraryRoot);
  const next = structuredClone(settings);
  if (next.hooks === undefined) next.hooks = {};
  if (typeof next.hooks !== 'object' || Array.isArray(next.hooks)) throw new Error('"hooks" in settings is not an object');
  if (next.hooks.PreToolUse === undefined) next.hooks.PreToolUse = [];
  if (!Array.isArray(next.hooks.PreToolUse)) throw new Error('"hooks.PreToolUse" in settings is not an array');

  for (const group of next.hooks.PreToolUse) {
    for (const h of group?.hooks || []) {
      if (!isOurs(h)) continue;
      if (h.command === command && group.matcher === 'Skill') return { settings: next, change: 'unchanged' };
      h.command = command;
      group.matcher = 'Skill';
      return { settings: next, change: 'updated' };
    }
  }
  next.hooks.PreToolUse.push({ matcher: 'Skill', hooks: [{ type: 'command', command, timeout: 15 }] });
  return { settings: next, change: 'added' };
}

// Removes only our entry (and a matcher group that becomes empty because of it).
export function removeHook(settings) {
  const next = structuredClone(settings);
  const groups = next?.hooks?.PreToolUse;
  if (!Array.isArray(groups)) return { settings: next, removed: 0 };
  let removed = 0;
  for (const group of groups) {
    if (!Array.isArray(group?.hooks)) continue;
    const kept = group.hooks.filter((h) => !isOurs(h));
    removed += group.hooks.length - kept.length;
    group.hooks = kept;
  }
  next.hooks.PreToolUse = groups.filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
  if (!next.hooks.PreToolUse.length) delete next.hooks.PreToolUse;
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return { settings: next, removed };
}
