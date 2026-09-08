import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Mirrors the exact 4 checks SKILL-LIB's own CI enforces
// (.github/scripts/lint_skills.py) — parses frontmatter, only name+description
// keys allowed, name format/length/folder-match, non-empty description. This
// is a fast local approximation, not a substitute for that CI job: parseFrontmatter
// is not a full YAML parser (see its own comment), so "parses as valid YAML"
// is only approximated here.
export function validateSkillFolder(skillDir) {
  const issues = [];

  if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
    return { valid: false, issues: [`Not a directory: ${skillDir}`], name: null, description: null };
  }

  const skillMdPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) {
    return { valid: false, issues: ['No SKILL.md found in this folder'], name: null, description: null };
  }

  const content = fs.readFileSync(skillMdPath, 'utf8');
  const fm = parseFrontmatter(content);
  if (!fm) {
    return {
      valid: false,
      issues: ['No frontmatter block (--- ... ---) found in SKILL.md, or it did not parse as key: value pairs'],
      name: null,
      description: null,
    };
  }

  const extraKeys = Object.keys(fm).filter((k) => k !== 'name' && k !== 'description');
  if (extraKeys.length) {
    issues.push(
      `Frontmatter has key(s) other than name/description (${extraKeys.join(', ')}) — move agent-specific config to an agents/ folder instead`,
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

  return { valid: issues.length === 0, issues, name, description };
}
