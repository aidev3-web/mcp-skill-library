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
    if (!t.agentPresent) {
      results.push({ ...t, status: 'skipped-agent-not-found' });
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
            results.push({ ...t, status: 'already-linked', path: linkPath });
            continue;
          }
        }
        results.push({ ...t, status: 'skipped-exists', path: linkPath });
        continue;
      }
      const type = process.platform === 'win32' ? 'junction' : 'dir';
      fs.symlinkSync(path.resolve(sourceDir), linkPath, type);
      results.push({ ...t, status: 'deployed', path: linkPath });
    } catch (err) {
      results.push({ ...t, status: 'error', path: linkPath, error: String(err?.message || err) });
    }
  }
  return results;
}
