#!/usr/bin/env node
// SessionStart hook for Claude Code (see docs/USAGE.md). Reads the hook JSON on stdin and prints a
// hookSpecificOutput.additionalContext JSON only when the session starts in a project that has no
// CLAUDE.md and has not been reminded about before. Everything else: silent, exit 0.
import os from 'node:os';
import path from 'node:path';
import { runSetupHook } from '../lib/setuphook.js';

// Same location the MCP server uses; --library comes from the registered command because a hook
// process does not inherit the server's environment.
const argIdx = process.argv.indexOf('--library');
const libraryRoot = argIdx > 0 && process.argv[argIdx + 1]
  ? path.resolve(process.argv[argIdx + 1])
  : process.env.SKILL_LIBRARY_PATH
    ? path.resolve(process.env.SKILL_LIBRARY_PATH)
    : path.join(os.homedir(), '.skill-library');

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const input = JSON.parse((await readStdin()) || '{}');
  const out = runSetupHook(input, { libraryRoot });
  if (out) process.stdout.write(JSON.stringify(out));
} catch {
  // A hook must never break or slow the session it runs in.
}
process.exit(0);
