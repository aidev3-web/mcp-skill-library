import fs from 'node:fs';
import path from 'node:path';

// A skill can list the other skills it needs in a `dependencies.json` next to its
// SKILL.md, so installing it installs them too:
//
//   { "requires": ["a-skill", "b-skill"], "optional": ["c-skill"] }
//
// Each name is a folder in the SAME repo and ref the skill was pulled from, next to
// the skill's own folder (a sibling: `team/x` needs `team/y`, a root skill needs a
// root folder). Nothing here talks to the network or the MCP transport, so it is
// testable with plain objects and temp folders.

export const DEPENDENCIES_FILE = 'dependencies.json';
export const MAX_DEPENDENCIES = 25;

// One folder name, never a path: this text comes from a repo the user does not control.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeName(name) {
  return typeof name === 'string' && SAFE_NAME.test(name) && name !== '.' && name !== '..';
}

// Returns { requires, optional, problems }. Bad entries are dropped and reported, never
// thrown: a malformed dependencies.json must not make the skill itself uninstallable.
export function parseDependencies(text) {
  const problems = [];
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { requires: [], optional: [], problems: [`${DEPENDENCIES_FILE} is not valid JSON (${err.message})`] };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { requires: [], optional: [], problems: [`${DEPENDENCIES_FILE} must be a JSON object`] };
  }
  const seen = new Set();
  const take = (key) => {
    const list = raw[key];
    if (list === undefined) return [];
    if (!Array.isArray(list)) {
      problems.push(`"${key}" must be an array of skill folder names`);
      return [];
    }
    const out = [];
    for (const item of list) {
      if (!isSafeName(item)) {
        problems.push(`ignored "${String(item).slice(0, 60)}" in "${key}": not a plain skill folder name`);
        continue;
      }
      if (seen.has(item)) continue; // listed twice, or in both lists: first mention wins
      seen.add(item);
      out.push(item);
    }
    return out;
  };
  const requires = take('requires');
  const optional = take('optional');
  if (requires.length + optional.length > MAX_DEPENDENCIES) {
    problems.push(`more than ${MAX_DEPENDENCIES} dependencies listed; only the first ${MAX_DEPENDENCIES} are used`);
    const all = [...requires.map((n) => ({ n, k: 'requires' })), ...optional.map((n) => ({ n, k: 'optional' }))].slice(0, MAX_DEPENDENCIES);
    return { requires: all.filter((x) => x.k === 'requires').map((x) => x.n), optional: all.filter((x) => x.k === 'optional').map((x) => x.n), problems };
  }
  return { requires, optional, problems };
}

// Where a dependency lives in the repo: a sibling of the skill that asks for it.
export function siblingPath(skillPath, name) {
  const dir = path.posix.dirname(skillPath);
  return dir === '.' || dir === '' ? name : `${dir}/${name}`;
}

// Walks dependencies breadth first, starting from `root`. `getDeps(name, kind)` returns the
// parsed { requires, optional } of that skill or null when it has none/unknown.
// Cycle-safe (a skill is visited once), bounded by MAX_DEPENDENCIES, and a dependency
// reached only through an optional one stays optional.
// Returns { deps: [{ name, kind: 'requires' | 'optional', via }] (discovery order), truncated }.
export async function resolveDependencies(root, getDeps) {
  const found = new Map(); // name -> { name, kind, via }
  const queue = [{ name: root, kind: 'requires' }];
  const visited = new Set([root]);
  let truncated = false;
  while (queue.length) {
    const { name, kind } = queue.shift();
    const deps = await getDeps(name, kind);
    if (!deps) continue;
    for (const [list, own] of [[deps.requires || [], 'requires'], [deps.optional || [], 'optional']]) {
      for (const dep of list) {
        const depKind = kind === 'optional' || own === 'optional' ? 'optional' : 'requires';
        const existing = found.get(dep);
        if (existing) {
          if (existing.kind === 'optional' && depKind === 'requires') existing.kind = 'requires';
          continue;
        }
        if (dep === root) continue;
        if (found.size >= MAX_DEPENDENCIES) {
          truncated = true;
          continue;
        }
        found.set(dep, { name: dep, kind: depKind, via: name });
        if (!visited.has(dep)) {
          visited.add(dep);
          queue.push({ name: dep, kind: depKind });
        }
      }
    }
  }
  return { deps: [...found.values()], truncated };
}

// Local read of a skill's dependencies.json; null when it has none.
export function readDependenciesFile(skillDir) {
  try {
    return parseDependencies(fs.readFileSync(path.join(skillDir, DEPENDENCIES_FILE), 'utf8'));
  } catch {
    return null;
  }
}

// Dependencies declared by the skill in `skillDir` whose folder (with a SKILL.md) is
// not in the library yet.
export function missingDependencies(skillDir, libraryRoot) {
  const deps = readDependenciesFile(skillDir);
  if (!deps) return { requires: [], optional: [] };
  const absent = (name) => !fs.existsSync(path.join(libraryRoot, name, 'SKILL.md'));
  return { requires: deps.requires.filter(absent), optional: deps.optional.filter(absent) };
}
