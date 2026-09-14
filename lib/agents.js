import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');

export function detectAgents(cwd = process.cwd()) {
  const candidates = [
    { agent: 'claude-code', scope: 'global', base: path.join(home, '.claude') },
    { agent: 'claude-code', scope: 'project', base: path.join(cwd, '.claude') },
    { agent: 'codex', scope: 'global', base: codexHome },
    { agent: 'opencode', scope: 'global', base: path.join(home, '.config', 'opencode') },
    { agent: 'opencode', scope: 'project', base: path.join(cwd, '.opencode') },
    // Verified conventions (each vendor's own docs, checked 2026-09):
    // Cursor  — cursor.com/docs/skills            -> ~/.cursor/skills, <project>/.cursor/skills
    // Gemini  — geminicli.com/docs/cli/skills      -> ~/.gemini/skills, <project>/.gemini/skills
    // Copilot — docs.github.com/copilot-sdk/skills -> ~/.copilot/skills, <project>/.github/skills
    { agent: 'cursor', scope: 'global', base: path.join(home, '.cursor') },
    { agent: 'cursor', scope: 'project', base: path.join(cwd, '.cursor') },
    { agent: 'gemini', scope: 'global', base: path.join(home, '.gemini') },
    { agent: 'gemini', scope: 'project', base: path.join(cwd, '.gemini') },
    { agent: 'copilot', scope: 'global', base: path.join(home, '.copilot') },
    { agent: 'copilot', scope: 'project', base: path.join(cwd, '.github') },
  ];
  return candidates.map((c) => {
    const skillsDir = path.join(c.base, 'skills');
    return {
      agent: c.agent,
      scope: c.scope,
      skillsDir,
      agentPresent: fs.existsSync(c.base),
    };
  });
}

export function deploySkill(sourceDir, targets) {
  const results = [];
  for (const t of targets) {
    // Only carry the fields declared in the deploy_skill outputSchema —
    // detectAgents()'s own agentPresent must not leak into the result.
    const base = { agent: t.agent, scope: t.scope, skillsDir: t.skillsDir };
    if (!t.agentPresent) {
      results.push({ ...base, status: 'skipped-agent-not-found' });
      continue;
    }
    const linkPath = path.join(t.skillsDir, path.basename(sourceDir));
    try {
      fs.mkdirSync(t.skillsDir, { recursive: true });
      if (fs.existsSync(linkPath)) {
        const stat = fs.lstatSync(linkPath);
        if (stat.isSymbolicLink()) {
          const real = fs.readlinkSync(linkPath);
          if (path.resolve(t.skillsDir, real) === path.resolve(sourceDir)) {
            results.push({ ...base, status: 'already-linked', path: linkPath });
            continue;
          }
        }
        results.push({ ...base, status: 'skipped-exists', path: linkPath });
        continue;
      }
      const type = process.platform === 'win32' ? 'junction' : 'dir';
      try {
        fs.symlinkSync(path.resolve(sourceDir), linkPath, type);
        results.push({ ...base, status: 'deployed', path: linkPath });
      } catch (symlinkErr) {
        // Some environments (restricted filesystems, certain sandboxes, some
        // Windows accounts without symlink privilege) reject symlinkSync even
        // though a plain recursive copy would succeed. Fall back to a copy
        // rather than failing outright — flagged with its own status so a
        // caller can tell a copy (which won't pick up future edits without
        // re-deploying) apart from a real symlink.
        fs.cpSync(path.resolve(sourceDir), linkPath, { recursive: true });
        results.push({
          ...base,
          status: 'deployed-copy',
          path: linkPath,
          note: `symlink unavailable (${String(symlinkErr?.message || symlinkErr)}); copied instead — re-run deploy after future skill updates`,
        });
      }
    } catch (err) {
      results.push({ ...base, status: 'error', path: linkPath, error: String(err?.message || err) });
    }
  }
  return results;
}

// Every place that still points at sourceDir after an undeploy pass. Deleting
// the library folder while any of these remain is exactly how you end up with
// the dangling symlinks remove_skill exists to prevent — so the caller checks
// this across ALL detected agents, not just the ones it was asked to undeploy.
export function findRemainingDeployments(sourceDir, targets) {
  const remaining = [];
  for (const t of targets) {
    if (!t.agentPresent) continue;
    const linkPath = path.join(t.skillsDir, path.basename(sourceDir));
    if (!fs.existsSync(linkPath)) continue;
    let kind = 'folder';
    try {
      if (fs.lstatSync(linkPath).isSymbolicLink()) {
        const real = fs.readlinkSync(linkPath);
        if (path.resolve(t.skillsDir, real) !== path.resolve(sourceDir)) continue; // points elsewhere, not ours
        kind = 'symlink';
      }
    } catch {
      // Unreadable entry — report it rather than assuming it's safe to ignore.
    }
    remaining.push({ agent: t.agent, scope: t.scope, path: linkPath, kind });
  }
  return remaining;
}

// Mirror of deploySkill's own linked-check: only remove a symlink/junction
// that resolves back to sourceDir. A same-named real folder or a symlink
// pointing somewhere else is left untouched — this function must never
// delete something it didn't create.
export function removeSkill(sourceDir, targets) {
  const results = [];
  for (const t of targets) {
    const base = { agent: t.agent, scope: t.scope, skillsDir: t.skillsDir };
    if (!t.agentPresent) {
      results.push({ ...base, status: 'skipped-agent-not-found' });
      continue;
    }
    const linkPath = path.join(t.skillsDir, path.basename(sourceDir));
    if (!fs.existsSync(linkPath)) {
      results.push({ ...base, status: 'not-deployed', path: linkPath });
      continue;
    }
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        const real = fs.readlinkSync(linkPath);
        if (path.resolve(t.skillsDir, real) !== path.resolve(sourceDir)) {
          results.push({ ...base, status: 'skipped-not-ours', path: linkPath, note: 'a symlink is there, but it points somewhere else — left alone' });
          continue;
        }
        fs.rmSync(linkPath); // removes the link itself, never the target's contents
        results.push({ ...base, status: 'removed', path: linkPath });
      } else {
        // Could be a real folder (never ours) or a deploy_skill copy-fallback
        // (ours, but indistinguishable from a real folder once copied) —
        // either way, deleting a non-symlink here risks destroying someone
        // else's content, so this is always a no-op requiring manual cleanup.
        results.push({ ...base, status: 'skipped-not-symlink', path: linkPath, note: 'not a symlink (real folder, or a copy-fallback deploy) — remove it by hand if you\'re sure it\'s this skill\'s copy' });
      }
    } catch (err) {
      results.push({ ...base, status: 'error', path: linkPath, error: String(err?.message || err) });
    }
  }
  return results;
}
