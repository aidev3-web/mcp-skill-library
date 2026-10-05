import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseDependencies,
  resolveDependencies,
  siblingPath,
  missingDependencies,
  readDependenciesFile,
  isSafeName,
  MAX_DEPENDENCIES,
} from '../lib/dependencies.js';

test('parses requires and optional', () => {
  const d = parseDependencies('{"requires":["a","b"],"optional":["c"]}');
  assert.deepEqual(d, { requires: ['a', 'b'], optional: ['c'], problems: [] });
});

test('a missing key is fine, an empty object means no dependencies', () => {
  assert.deepEqual(parseDependencies('{}'), { requires: [], optional: [], problems: [] });
  assert.deepEqual(parseDependencies('{"optional":["x"]}').requires, []);
});

test('names that are paths or odd are dropped and reported, never used', () => {
  const d = parseDependencies(JSON.stringify({ requires: ['ok', '../../etc', 'a/b', '..', '.', '', 7, null, 'C:\\x', '-lead', 'ok2'] }));
  assert.deepEqual(d.requires, ['ok', 'ok2']);
  assert.ok(d.problems.length >= 7, d.problems.join(' | '));
});

test('a name in both lists, or twice, is kept once (first mention wins)', () => {
  const d = parseDependencies('{"requires":["a","a"],"optional":["a","b"]}');
  assert.deepEqual(d.requires, ['a']);
  assert.deepEqual(d.optional, ['b']);
});

test('malformed input never throws', () => {
  assert.match(parseDependencies('{not json').problems[0], /not valid JSON/);
  assert.match(parseDependencies('[]').problems[0], /must be a JSON object/);
  assert.match(parseDependencies('"x"').problems[0], /must be a JSON object/);
  assert.match(parseDependencies('{"requires":"a"}').problems[0], /must be an array/);
});

test('more than the cap is truncated and reported', () => {
  const many = Array.from({ length: MAX_DEPENDENCIES + 5 }, (_, i) => `s${i}`);
  const d = parseDependencies(JSON.stringify({ requires: many }));
  assert.equal(d.requires.length, MAX_DEPENDENCIES);
  assert.match(d.problems.join(' '), /more than/);
});

test('isSafeName', () => {
  for (const ok of ['a', 'skill-1', 'a.b', 'A_b']) assert.equal(isSafeName(ok), true, ok);
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', '-x', ' x', 'x y', null, 5]) assert.equal(isSafeName(bad), false, String(bad));
});

test('siblingPath: root skill -> root folder, nested skill -> its own folder level', () => {
  assert.equal(siblingPath('technext-sales-proposal', 'assembler'), 'assembler');
  assert.equal(siblingPath('team/x', 'y'), 'team/y');
  assert.equal(siblingPath('a/b/c', 'd'), 'a/b/d');
});

function graph(map) {
  return async (name) => map[name] ?? null;
}

test('resolve: flat list keeps discovery order and kinds', async () => {
  const { deps: r } = await resolveDependencies('main', graph({ main: { requires: ['a', 'b'], optional: ['c'] } }));
  assert.deepEqual(r.map((d) => [d.name, d.kind, d.via]), [['a', 'requires', 'main'], ['b', 'requires', 'main'], ['c', 'optional', 'main']]);
});

test('resolve: follows dependencies of dependencies', async () => {
  const { deps: r } = await resolveDependencies('main', graph({ main: { requires: ['a'] }, a: { requires: ['b'] }, b: { requires: ['c'] } }));
  assert.deepEqual(r.map((d) => d.name), ['a', 'b', 'c']);
});

test('resolve: a cycle terminates and the root is never listed as its own dependency', async () => {
  const { deps: r } = await resolveDependencies('main', graph({ main: { requires: ['a'] }, a: { requires: ['b'] }, b: { requires: ['a', 'main'] } }));
  assert.deepEqual(r.map((d) => d.name), ['a', 'b']);
});

test('resolve: anything reached only through an optional skill stays optional; a later required mention upgrades it', async () => {
  const { deps: r } = await resolveDependencies('main', graph({ main: { optional: ['o'], requires: ['r'] }, o: { requires: ['x'] }, r: { requires: ['x'] } }));
  const byName = Object.fromEntries(r.map((d) => [d.name, d.kind]));
  assert.equal(byName.o, 'optional');
  assert.equal(byName.x, 'requires', 'also required by a required skill');
});

test('resolve: the number of dependencies is capped', async () => {
  const wide = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`s${i}`, { requires: [] }]));
  const many = { requires: Object.keys(wide) };
  const r = await resolveDependencies('main', graph({ main: many, ...wide }));
  assert.equal(r.deps.length, MAX_DEPENDENCIES);
  assert.equal(r.truncated, true);
});

test('resolve: a skill with no dependencies file adds nothing', async () => {
  assert.deepEqual(await resolveDependencies('main', graph({})), { deps: [], truncated: false });
});

function libWith(structure) {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'skilllib-deps-'));
  for (const [name, files] of Object.entries(structure)) {
    fs.mkdirSync(path.join(lib, name), { recursive: true });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(lib, name, f), c);
  }
  return lib;
}

test('missingDependencies: only folders without a SKILL.md count as missing', () => {
  const lib = libWith({
    main: { 'SKILL.md': 'x', 'dependencies.json': '{"requires":["have","gone"],"optional":["also-gone"]}' },
    have: { 'SKILL.md': 'x' },
    empty: {},
  });
  assert.deepEqual(missingDependencies(path.join(lib, 'main'), lib), { requires: ['gone'], optional: ['also-gone'] });
});

test('missingDependencies / readDependenciesFile on a skill without the file', () => {
  const lib = libWith({ plain: { 'SKILL.md': 'x' } });
  assert.deepEqual(missingDependencies(path.join(lib, 'plain'), lib), { requires: [], optional: [] });
  assert.equal(readDependenciesFile(path.join(lib, 'plain')), null);
});
