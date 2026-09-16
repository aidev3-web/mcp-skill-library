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

// Grounded in this project's own copy of SkillSafetyBench ("Evaluating Agent
// Safety under Skill-Facing Attack Surfaces", paper/2605.12015.pdf): unsafe
// influence can live in a skill's own instructional content, not just in
// filenames — a SKILL.md body can tell the reading agent to wipe an unscoped
// path or exfiltrate credential-shaped files, and the agent has no
// independent reason to distrust its own skill's instructions.
//
// This is a narrow, high-confidence signature match, not a general
// "contains rm/curl" scan — a legitimate "rm -rf dist/" build-cleanup skill
// or a "curl https://api.example.com/deploy" deploy skill must NOT trip it.
// Destructive patterns only match unscoped/home/root targets; exfiltration
// patterns require BOTH a sensitive-path mention AND a network-send verb
// somewhere in the same content, not either alone.
const DESTRUCTIVE_PATTERNS = [
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(~|\$HOME|\/(?:\s|$)|\*\s*$)/im, // rm -rf ~ | $HOME | / | * (unscoped)
  /\bformat\s+[cC]:\s*\/?/i,
  /\bdel\s+\/[sS]\s+\/[qQ]\s+[cC]:\\/i,
];

const SENSITIVE_PATH_PATTERNS = [
  /~\/\.ssh\b/i,
  /~\/\.aws\/credentials\b/i,
  /~\/\.gnupg\b/i,
  /\.env\b/i,
  /\bid_rsa\b/i,
  /\bcredentials\.json\b/i,
  /\bLogin Data\b/i, // Chrome/Edge saved-password store filename
];

const EXFIL_VERB_PATTERNS = [
  /\bcurl\b[^\n]{0,120}(-d\b|--data\b|-F\b|-T\b|-X\s*POST)/i,
  /\bwget\b[^\n]{0,120}--post/i,
  /\|\s*(curl|nc|ncat|netcat)\b/i,
  /\bfetch\(|axios\.post\(|requests\.post\(/i,
];

// Returns findings (human-readable strings), not a boolean, so push_skill
// can name exactly what matched instead of a bare refusal.
export function findDangerousInstructions(skillMdContent) {
  const findings = [];
  for (const re of DESTRUCTIVE_PATTERNS) {
    const m = skillMdContent.match(re);
    if (m) findings.push(`unscoped destructive command: "${m[0].trim()}"`);
  }
  const hasSensitivePath = SENSITIVE_PATH_PATTERNS.some((re) => re.test(skillMdContent));
  const hasExfilVerb = EXFIL_VERB_PATTERNS.some((re) => re.test(skillMdContent));
  if (hasSensitivePath && hasExfilVerb) {
    findings.push('mentions a credential/sensitive path and a network-send call in the same content');
  }
  return findings;
}
