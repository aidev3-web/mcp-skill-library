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

// Files that must never leave the machine inside a skill push. This is a
// deliberately blunt name/extension check — push_skill refuses the whole push
// when one shows up rather than quietly skipping it, because "your secret was
// silently dropped" and "your skill is missing a file" are both worse than
// being told to clean the folder first. `.env.example` and friends are
// allowed: they exist precisely to be shared.
const SECRET_NAMES = new Set([
  '.env',
  '.env.local',
  '.npmrc',
  '.netrc',
  '_netrc',
  '.pypirc',
  'credentials',
  'credentials.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'service-account.json',
  '.htpasswd',
]);
const SECRET_EXTS = new Set(['.pem', '.key', '.pfx', '.p12', '.keystore', '.jks', '.ppk']);

export function findSecretFiles(files) {
  return files
    .filter((f) => {
      const base = path.basename(f.relativePath).toLowerCase();
      if (SECRET_NAMES.has(base)) return true;
      if (base.startsWith('.env.') && !base.endsWith('.example') && !base.endsWith('.sample')) return true;
      return SECRET_EXTS.has(path.extname(base));
    })
    .map((f) => f.relativePath);
}
