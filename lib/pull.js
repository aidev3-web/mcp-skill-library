import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { writeSource, SOURCE_FILE } from './updates.js';
import { mapWithConcurrency } from './util.js';
import { readDependenciesFile, resolveDependencies, siblingPath, MAX_DEPENDENCIES } from './dependencies.js';

// The "pull a skill folder out of a repo tree" logic behind pull_skill, and the
// dependency pass that follows it. It lives here, not in index.js, because index.js
// starts the stdio server at import time and so cannot be imported by a test.
// Everything that touches the network or the library location is passed in:
//   resolveSkillDir(name) -> absolute folder inside the library, or null for a bad name
//   badNameMessage        -> text reported for a bad name
//   getBlobBytes(owner, repo, sha) -> Buffer
//   getCommitsForPath(owner, repo, ref, path, n) -> [{ sha }]
//   onPulled(name)        -> called after a skill was written (cache invalidation)
export function createPuller({ resolveSkillDir, badNameMessage, getBlobBytes, getCommitsForPath, onPulled = () => {} }) {
  // Pulls ONE skill folder out of an already-loaded repo tree into the library and
  // records where it came from. Returns the same entry shape pull_skill reports.
  async function pullOneSkill(tree, owner, repo, resolvedRef, skillPath) {
    const prefix = `${skillPath}/`;
    const files = tree.filter((e) => e.type === 'blob' && e.path.startsWith(prefix));
    const folderName = path.basename(skillPath);
    if (!files.some((f) => f.path === `${skillPath}/SKILL.md`)) {
      return { path: skillPath, name: folderName, localPath: '', status: 'error', warnings: ['No SKILL.md found under this path in the repo tree'] };
    }
    // Same guard as deploy/remove: the folder this writes into must be one
    // name directly under the library, never a path the repo (or a crafted
    // skillPath like "a/..") can steer somewhere else.
    const destRoot = resolveSkillDir(folderName);
    if (!destRoot) {
      return { path: skillPath, name: folderName, localPath: '', status: 'error', warnings: [badNameMessage] };
    }
    let escaped = null;
    const targets = [];
    for (const f of files) {
      const rel = f.path.slice(prefix.length);
      const destFile = path.resolve(destRoot, rel);
      // Repo-controlled path, so treat it like an archive entry: anything
      // that resolves outside destRoot is a zip-slip and aborts the skill.
      // Every path is checked before the first byte is written.
      if (destFile !== path.join(destRoot, rel) || !destFile.startsWith(destRoot + path.sep)) {
        escaped = f.path;
        break;
      }
      targets.push({ sha: f.sha, destFile });
    }
    if (!escaped) {
      // A few files at a time: one by one made a 13-skill install take minutes, and
      // an unbounded burst would open one socket per file.
      await mapWithConcurrency(targets, 5, async ({ sha, destFile }) => {
        fs.mkdirSync(path.dirname(destFile), { recursive: true });
        // Bytes, not text: a skill folder can hold images/PDFs/fonts, and a
        // utf8 round-trip rewrites every non-UTF8 byte to U+FFFD.
        fs.writeFileSync(destFile, await getBlobBytes(owner, repo, sha));
      });
    }
    if (escaped) {
      return {
        path: skillPath,
        name: folderName,
        localPath: '',
        status: 'error',
        warnings: [`Repo entry "${escaped}" resolves outside the skill folder — refusing to write it (path traversal).`],
      };
    }
    const skillMd = fs.readFileSync(path.join(destRoot, 'SKILL.md'), 'utf8');
    const fm = parseFrontmatter(skillMd) || {};
    const warnings = [];
    if (!fm.name) warnings.push('SKILL.md frontmatter is missing "name"');
    else if (fm.name !== folderName) warnings.push(`frontmatter name "${fm.name}" does not match folder name "${folderName}"`);
    if (!fm.description) warnings.push('SKILL.md frontmatter is missing "description"');
    const extraKeys = Object.keys(fm).filter((k) => k !== 'name' && k !== 'description');
    if (extraKeys.length) warnings.push(`frontmatter has agent-specific keys that won't port cleanly: ${extraKeys.join(', ')}`);
    // Remember where this came from and the exact blob of every file written,
    // so check_skill_update can later tell what changed upstream and whether
    // the user edited anything locally. Best effort: never fail a pull on it.
    try {
      let commit = null;
      try {
        commit = (await getCommitsForPath(owner, repo, resolvedRef, skillPath, 1))[0]?.sha ?? null;
      } catch {
        // the commit id is informational only
      }
      writeSource(destRoot, {
        owner,
        repo,
        ref: resolvedRef,
        path: skillPath,
        commit,
        pulledAt: new Date().toISOString(),
        declinedSignature: null,
        files: Object.fromEntries(files.map((f) => [f.path.slice(prefix.length), f.sha])),
      });
      onPulled(folderName);
    } catch (err) {
      warnings.push(`could not record ${SOURCE_FILE} (update checks will skip this skill): ${String(err?.message || err)}`);
    }
    return { path: skillPath, name: fm.name || folderName, localPath: destRoot, status: 'pulled', warnings };
  }

  // Pulls the skills a pulled skill lists in its dependencies.json (see lib/dependencies.js),
  // from the same repo and ref, as siblings of the skill. A dependency already in the
  // library is left alone (its own dependencies.json is still followed). Returns the
  // entries for the dependencies only.
  async function pullDependencies(tree, owner, repo, resolvedRef, rootEntry, { includeOptional }) {
    const rootDir = resolveSkillDir(path.basename(rootEntry.path));
    if (!rootDir || !readDependenciesFile(rootDir)) return [];
    const entries = new Map(); // dependency name -> entry
    const problems = [];
    const depsOf = async (name, kind) => {
      if (name === path.basename(rootEntry.path)) {
        const parsed = readDependenciesFile(rootDir);
        problems.push(...(parsed?.problems || []).map((p) => `${rootEntry.name}: ${p}`));
        return parsed;
      }
      if (entries.has(name)) return null; // already handled through another path
      const dir = resolveSkillDir(name);
      if (!dir) {
        entries.set(name, { path: name, name, localPath: '', status: 'error', warnings: [badNameMessage], dependencyOf: rootEntry.name, optional: kind === 'optional' });
        return null;
      }
      if (kind === 'optional' && !includeOptional) {
        entries.set(name, { path: name, name, localPath: fs.existsSync(path.join(dir, 'SKILL.md')) ? dir : '', status: 'skipped-optional', warnings: [], dependencyOf: rootEntry.name, optional: true });
        return null;
      }
      if (fs.existsSync(path.join(dir, 'SKILL.md'))) {
        entries.set(name, { path: name, name, localPath: dir, status: 'already-present', warnings: [], dependencyOf: rootEntry.name, optional: kind === 'optional' });
      } else {
        const pulledDep = await pullOneSkill(tree, owner, repo, resolvedRef, siblingPath(rootEntry.path, name));
        entries.set(name, { ...pulledDep, dependencyOf: rootEntry.name, optional: kind === 'optional' });
        if (pulledDep.status !== 'pulled') return null;
      }
      const parsed = readDependenciesFile(dir);
      problems.push(...(parsed?.problems || []).map((p) => `${name}: ${p}`));
      return parsed;
    };
    const { deps, truncated } = await resolveDependencies(path.basename(rootEntry.path), depsOf);
    const out = deps.map((d) => entries.get(d.name)).filter(Boolean);
    // the kind can be upgraded after a dependency was first seen as optional
    for (const d of deps) {
      const e = entries.get(d.name);
      if (e) e.optional = d.kind === 'optional';
    }
    if (problems.length || truncated) {
      rootEntry.warnings.push(...problems, ...(truncated ? [`more than ${MAX_DEPENDENCIES} dependencies; the rest were not pulled`] : []));
    }
    return out;
  }

  return { pullOneSkill, pullDependencies };
}
