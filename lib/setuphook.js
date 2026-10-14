import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanProject, readExistingSetup } from './recommend.js';

// Logic behind hook/project-setup-hook.js, a SessionStart hook: when a Claude Code
// session starts in a project that has no CLAUDE.md (a new or empty folder, or one
// never set up), it hands Claude a short instruction to offer setup recommendations
// through the recommend_setup tool, so the person does not have to know it exists.
//
// It is deliberately quiet: at most ONE reminder per project folder (remembered in the
// library folder), never in the home directory or a drive root, never when CLAUDE.md
// already exists, and every error ends in `null` (no output). Nothing here writes to
// the project.

const STATE_FILE = '.setup-hook-state.json';
const MAX_REMEMBERED = 200;

function readState(libraryRoot) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(libraryRoot, STATE_FILE), 'utf8'));
    return s && typeof s.projects === 'object' && s.projects ? s : { projects: {} };
  } catch {
    return { projects: {} };
  }
}

function writeState(libraryRoot, state) {
  try {
    const entries = Object.entries(state.projects).sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, MAX_REMEMBERED);
    fs.mkdirSync(libraryRoot, { recursive: true });
    fs.writeFileSync(path.join(libraryRoot, STATE_FILE), JSON.stringify({ projects: Object.fromEntries(entries) }, null, 2));
  } catch {
    // remembering is an optimisation; failing to save must not surface
  }
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const isRoot = (p) => path.parse(path.resolve(p)).root.toLowerCase() === path.resolve(p).toLowerCase();

// Returns the JSON object to print on stdout, or null to print nothing.
export function runSetupHook(input, { libraryRoot, home = os.homedir(), now = () => new Date() }) {
  if (input?.hook_event_name && input.hook_event_name !== 'SessionStart') return null;
  // "resume", "clear" and "compact" continue work that was already under way.
  if (input?.source && input.source !== 'startup') return null;
  const cwd = typeof input?.cwd === 'string' && input.cwd.trim() ? path.resolve(input.cwd) : null;
  if (!cwd) return null;
  try {
    if (!fs.statSync(cwd).isDirectory()) return null;
  } catch {
    return null;
  }
  if (samePath(cwd, home) || isRoot(cwd) || cwd.toLowerCase().startsWith(path.resolve(libraryRoot).toLowerCase() + path.sep)) return null;

  if (readExistingSetup(cwd).claudeMd) return null;
  const state = readState(libraryRoot);
  if (state.projects[cwd]) return null; // already reminded once for this project

  const { signals } = scanProject(cwd);
  const empty = signals.includes('project:empty');
  state.projects[cwd] = now().toISOString();
  writeState(libraryRoot, state);

  const what = empty ? 'The project folder is empty (a new project).' : `The project has no CLAUDE.md. Detected: ${signals.join(', ') || 'nothing recognisable'}.`;
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        `[technext-mcp-skill-lib] ${what} If the recommend_setup tool of the technext-mcp-skill-lib MCP server is available, call it with projectPath "${cwd}" and ` +
        'tell the person, in a few lines, what Claude Code setup it recommends (skills, MCP servers, hooks) and offer to apply what they pick. ' +
        'If their first message is an unrelated quick question, answer it first and mention the recommendations afterwards. ' +
        'Change nothing in the project unless they agree. Say this at most once.',
    },
  };
}
