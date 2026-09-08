import fs from 'node:fs';
import path from 'node:path';

const EXCLUDED_DIRS = new Set(['.git']);

// Recursively lists every real skill file under skillDir as
// { relativePath, absolutePath }, using '/' separators regardless of OS
// (GitHub's tree API paths are always '/'-separated). Excludes:
// - the top-level .meta.json this tool's own caller manages (a nested
//   same-named file, e.g. scripts/.meta.json, is NOT excluded — only the
//   exact bookkeeping file at the skill root)
// - .git directories
// - symlinks (so a folder someone already deploy_skill'd into isn't
//   walked through)
export function walkSkillFiles(skillDir) {
  const out = [];

  function walk(dir, relPrefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (rel === '.meta.json') continue;
      const abs = path.join(dir, entry.name);

      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(abs, rel);
      } else if (entry.isFile()) {
        out.push({ relativePath: rel, absolutePath: abs });
      }
    }
  }

  walk(skillDir, '');
  return out;
}
