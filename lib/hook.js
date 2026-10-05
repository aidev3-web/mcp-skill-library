import fs from 'node:fs';
import path from 'node:path';
import { readSource, checkForUpdate, describeUpdate, signatureOf } from './updates.js';

// Logic behind hook/skill-update-hook.js, kept here so it can be tested with
// fake network and a temp library. The hook is registered as a PreToolUse hook
// on the Skill tool only, so it runs exactly when a skill is about to be used
// (slash command or the model's own choice) and never at plain session start.
//
// It must be invisible when there is nothing to say: any error, an untracked
// skill, an up-to-date skill, a declined version, or a skill already reported
// this session all end in `null` (no output, no delay worth noticing).

const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const STATE_FILE = '.update-hook-state.json';
// One folder name only — the skill name comes from tool input, so it is never
// allowed to steer the lookup outside the library.
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

function readState(libraryRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(libraryRoot, STATE_FILE), 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeState(libraryRoot, state) {
  try {
    fs.writeFileSync(path.join(libraryRoot, STATE_FILE), JSON.stringify(state, null, 2));
  } catch {
    // state is an optimisation; failing to save it must not surface
  }
}

// "plugin:skill" style names resolve to the trailing skill folder name.
export function skillNameFromInput(input) {
  const raw = input?.tool_input?.skill;
  if (typeof raw !== 'string') return null;
  const name = raw.split(':').pop().trim();
  return SAFE_NAME.test(name) && name !== '.' && name !== '..' ? name : null;
}

// Returns the JSON object to print on stdout, or null to print nothing.
export async function runHook(input, { libraryRoot, loadTree, getCommits, fetchBlob, now = () => Date.now() }) {
  if (input?.tool_name !== 'Skill') return null;
  const name = skillNameFromInput(input);
  if (!name) return null;

  const skillDir = path.join(libraryRoot, name);
  const src = readSource(skillDir);
  if (!src) return null; // not pulled through technext-mcp-skill-lib: nothing to compare with

  const sessionId = String(input.session_id || 'unknown');
  const state = readState(libraryRoot);
  const entry = state[name] || {};
  // The cached verdict is only valid for the exact local + declined state it was made for.
  const localKey = `${signatureOf(src.files)}:${src.declinedSignature || ''}`;

  let check = null;
  let verdict = entry.localKey === localKey && now() - (entry.checkedAt || 0) < CHECK_TTL_MS ? entry.verdict : null;
  if (!verdict) {
    check = await checkForUpdate(skillDir, { loadTree, getCommits, fetchBlob });
    verdict = check.status === 'update-available' ? 'update' : 'none';
    // a changed local state (updated or declined since) starts a fresh conversation about it
    state[name] = { localKey, checkedAt: now(), verdict, notifiedSession: entry.localKey === localKey ? entry.notifiedSession : undefined };
    writeState(libraryRoot, state);
  }
  if (verdict !== 'update') return null;

  // Ask once per session; the answer (update / decline) changes the local state
  // and with it the cache key, so the next session decides afresh.
  if ((state[name] || entry).notifiedSession === sessionId) return null;
  if (!check) check = await checkForUpdate(skillDir, { loadTree, getCommits, fetchBlob });
  if (check.status !== 'update-available') return null;

  state[name] = { ...(state[name] || entry), notifiedSession: sessionId };
  writeState(libraryRoot, state);
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: describeUpdate(name, check),
    },
  };
}
