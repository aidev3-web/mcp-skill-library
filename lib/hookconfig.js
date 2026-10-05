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

// Two events carry the same command. PreToolUse (matcher "Skill") fires when the model calls the Skill
// tool; UserPromptSubmit fires when the user types a prompt, which is the only event a slash command such as
// /my-skill produces (a slash command loads the skill without any Skill tool call).
const EVENTS = [
  { name: 'PreToolUse', matcher: 'Skill' },
  { name: 'UserPromptSubmit', matcher: undefined },
];

function sameMatcher(group, matcher) {
  return matcher === undefined ? group.matcher === undefined : group.matcher === matcher;
}

// Returns { settings, change } where change is 'added' | 'updated' | 'unchanged'.
export function addHook(settings, hookScriptPath, libraryRoot) {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings must be a JSON object');
  const command = buildCommand(hookScriptPath, libraryRoot);
  const next = structuredClone(settings);
  if (next.hooks === undefined) next.hooks = {};
  if (typeof next.hooks !== 'object' || Array.isArray(next.hooks)) throw new Error('"hooks" in settings is not an object');
  for (const { name } of EVENTS) {
    if (next.hooks[name] === undefined) next.hooks[name] = [];
    if (!Array.isArray(next.hooks[name])) throw new Error(`"hooks.${name}" in settings is not an array`);
  }

  let hadOurs = false;
  let touched = false;
  for (const { name, matcher } of EVENTS) {
    let found = false;
    for (const group of next.hooks[name]) {
      for (const h of group?.hooks || []) {
        if (!isOurs(h)) continue;
        found = true;
        hadOurs = true;
        if (h.command !== command || !sameMatcher(group, matcher)) {
          h.command = command;
          if (matcher === undefined) delete group.matcher;
          else group.matcher = matcher;
          touched = true;
        }
      }
    }
    if (!found) {
      next.hooks[name].push({ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command, timeout: 15 }] });
      touched = true;
    }
  }
  if (!touched) return { settings: next, change: 'unchanged' };
  return { settings: next, change: hadOurs ? 'updated' : 'added' };
}

// Removes only our entries (and a matcher group that becomes empty because of it).
export function removeHook(settings) {
  const next = structuredClone(settings);
  let removed = 0;
  for (const { name } of EVENTS) {
    const groups = next?.hooks?.[name];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) continue;
      const kept = group.hooks.filter((h) => !isOurs(h));
      removed += group.hooks.length - kept.length;
      group.hooks = kept;
    }
    next.hooks[name] = groups.filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
    if (!next.hooks[name].length) delete next.hooks[name];
  }
  if (next.hooks && !Object.keys(next.hooks).length) delete next.hooks;
  return { settings: next, removed };
}
