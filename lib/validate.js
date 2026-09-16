import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Close to the checks SKILL-LIB's own CI enforces
// (.github/scripts/lint_skills.py) — frontmatter parses, `name` format/length
// matches the folder, `description` is non-empty. A fast local approximation,
// not a substitute for that CI job: parseFrontmatter is not a full YAML parser
// (see its own comment), so "parses as valid YAML" is only approximated here.
//
// ONE DELIBERATE DIVERGENCE: extra frontmatter keys are a WARNING here, not an
// error. `name` and `description` are the minimum a skill must carry; anything
// beyond that is allowed.
//
// Why diverge: the two-key rule in PACKAGING.md §4 is a PORTABILITY convention,
// not a technical requirement — that section says so itself ("Most agents will
// silently ignore unknown YAML keys (no error)"). Enforcing it as a hard error
// made this validator stricter than the ecosystem it validates: real, widely
// installed skills carry extra keys (`allowed-tools`, `license`, `metadata`,
// `version`, `model`), and every one of them was rejected outright — including
// skills this project's own find_skills tool surfaces as good results.
//
// What the warning must keep saying: SKILL-LIB's CI has NOT been relaxed, so a
// skill with extra keys can still be refused at PR time. Warn, don't block, and
// name that risk explicitly rather than letting it surprise someone later.
export function validateSkillFolder(skillDir) {
  const issues = [];
  const warnings = [];

  if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
    return { valid: false, issues: [`Not a directory: ${skillDir}`], warnings: [], name: null, description: null };
  }

  const skillMdPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) {
    return { valid: false, issues: ['No SKILL.md found in this folder'], warnings: [], name: null, description: null };
  }

  const content = fs.readFileSync(skillMdPath, 'utf8');
  const fm = parseFrontmatter(content);
  if (!fm) {
    return {
      valid: false,
      issues: ['No frontmatter block (--- ... ---) found in SKILL.md, or it did not parse as key: value pairs'],
      warnings: [],
      name: null,
      description: null,
    };
  }

  const extraKeys = Object.keys(fm).filter((k) => k !== 'name' && k !== 'description');
  if (extraKeys.length) {
    warnings.push(
      `Frontmatter carries key(s) beyond name/description (${extraKeys.join(', ')}). ` +
        'That is valid here — name and description are the minimum, not the maximum. ' +
        'But SKILL-LIB\'s CI lint still rejects extra keys (PACKAGING.md §4 asks for agent-specific ' +
        'config in an agents/ folder so the skill stays portable), so a PR carrying them may fail there.',
    );
  }

  const name = fm.name || null;
  const folderName = path.basename(skillDir);
  if (!name) {
    issues.push('Frontmatter is missing required key "name"');
  } else {
    if (!NAME_RE.test(name)) issues.push(`"name" ("${name}") must be lowercase letters/digits/hyphens only`);
    if (name.length > 64) issues.push(`"name" is ${name.length} chars, must be <= 64`);
    if (name !== folderName) issues.push(`"name" ("${name}") does not match folder name ("${folderName}")`);
  }

  const description = fm.description || null;
  if (!description || !description.trim()) {
    issues.push('Frontmatter is missing a non-empty "description"');
  }

  return { valid: issues.length === 0, issues, warnings, name, description };
}
