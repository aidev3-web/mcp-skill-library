#!/usr/bin/env node
// PreToolUse hook for Claude Code, scoped to the Skill tool (see docs/USAGE.md).
// Reads the hook JSON on stdin; prints a hookSpecificOutput.additionalContext
// JSON only when the skill about to run has a newer upstream version the user
// has not been asked about this session. Everything else: silent, exit 0.
import os from 'node:os';
import path from 'node:path';
import { runHook } from '../lib/hook.js';
import { ensureGhReady, getRecursiveTree, getCommitsForPath, getBlobBytes } from '../lib/github.js';

// Same location the MCP server uses. --library comes from the command the server
// registered (a hook process does not inherit the server's environment).
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
  const out = await runHook(input, {
    libraryRoot,
    loadTree: async (owner, repo, ref) => {
      await ensureGhReady();
      return getRecursiveTree(owner, repo, ref);
    },
    getCommits: (owner, repo, ref, folder) => getCommitsForPath(owner, repo, ref, folder),
    fetchBlob: (owner, repo, sha) => getBlobBytes(owner, repo, sha),
  });
  if (out) process.stdout.write(JSON.stringify(out));
} catch {
  // A hook must never break or slow the skill it wraps.
}
process.exit(0);
