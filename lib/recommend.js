// Read-only project scan + rule matching behind recommend_setup.
//
// scanProject() looks at a handful of well-known manifest files and folders and
// turns what it finds into a set of signal ids ("lang:node", "fw:react", ...).
// readExistingSetup() reports what the project already has under .claude/ so the
// same thing is never recommended twice. recommend() matches signals against the
// rules in data/setup-rules.json and returns the top few per category.
//
// Nothing here writes to disk, and nothing reads a file that can hold secrets:
// ".env" is only checked for existence, never opened.
import fs from 'node:fs';
import path from 'node:path';

const MAX_READ_BYTES = 256 * 1024;

function readText(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_READ_BYTES) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function readJson(p) {
  const text = readText(p);
  if (text === null) return null;
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

const exists = (...parts) => fs.existsSync(path.join(...parts));

function listDir(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

// dependency name (npm) -> signal. Matched against dependencies + devDependencies.
const NPM_SIGNALS = {
  react: 'fw:react',
  next: 'fw:next',
  vue: 'fw:vue',
  '@angular/core': 'fw:angular',
  svelte: 'fw:svelte',
  express: 'fw:express',
  fastify: 'fw:fastify',
  '@nestjs/core': 'fw:nest',
  prisma: 'db:prisma',
  '@prisma/client': 'db:prisma',
  '@supabase/supabase-js': 'db:supabase',
  convex: 'db:convex',
  mongoose: 'db:mongo',
  pg: 'db:postgres',
  mysql2: 'db:mysql',
  stripe: 'api:stripe',
  openai: 'api:openai',
  '@anthropic-ai/sdk': 'api:anthropic',
  '@sentry/node': 'tool:sentry',
  '@sentry/react': 'tool:sentry',
  '@sentry/nextjs': 'tool:sentry',
  jest: 'test:jest',
  vitest: 'test:vitest',
  mocha: 'test:mocha',
  '@playwright/test': 'test:playwright',
  playwright: 'test:playwright',
  cypress: 'test:cypress',
  eslint: 'tool:eslint',
  prettier: 'tool:prettier',
  typescript: 'lang:typescript',
  tailwindcss: 'tool:tailwind',
};

// Substring of requirements.txt / pyproject.toml (lower-cased) -> signal.
const PY_SIGNALS = [
  ['fastapi', 'fw:fastapi'],
  ['django', 'fw:django'],
  ['flask', 'fw:flask'],
  ['streamlit', 'fw:streamlit'],
  ['sqlalchemy', 'db:sql'],
  ['psycopg', 'db:postgres'],
  ['supabase', 'db:supabase'],
  ['stripe', 'api:stripe'],
  ['openai', 'api:openai'],
  ['anthropic', 'api:anthropic'],
  ['sentry-sdk', 'tool:sentry'],
  ['pytest', 'test:pytest'],
  ['ruff', 'tool:ruff'],
  ['black', 'tool:black'],
  ['mypy', 'tool:mypy'],
];

export function scanProject(dir) {
  const signals = new Set();
  const evidence = {}; // signal -> where it came from, for the report

  const add = (signal, why) => {
    signals.add(signal);
    if (!evidence[signal]) evidence[signal] = why;
  };

  const pkg = readJson(path.join(dir, 'package.json'));
  if (pkg) {
    add('lang:node', 'package.json');
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const [name, signal] of Object.entries(NPM_SIGNALS)) if (name in deps) add(signal, `package.json: ${name}`);
  }

  const pyText = [readText(path.join(dir, 'requirements.txt')), readText(path.join(dir, 'pyproject.toml')), readText(path.join(dir, 'requirements-dev.txt'))]
    .filter((t) => t !== null)
    .join('\n')
    .toLowerCase();
  if (exists(dir, 'requirements.txt') || exists(dir, 'pyproject.toml') || exists(dir, 'setup.py') || exists(dir, 'Pipfile')) add('lang:python', 'Python manifest');
  for (const [needle, signal] of PY_SIGNALS) if (pyText.includes(needle)) add(signal, `Python dependencies: ${needle}`);

  if (exists(dir, 'go.mod')) add('lang:go', 'go.mod');
  if (exists(dir, 'Cargo.toml')) add('lang:rust', 'Cargo.toml');
  if (exists(dir, 'pom.xml') || exists(dir, 'build.gradle') || exists(dir, 'build.gradle.kts')) add('lang:java', 'Maven/Gradle build file');
  if (listDir(dir).some((e) => e.isFile() && /\.csproj$|\.sln$/i.test(e.name))) add('lang:dotnet', '.NET project file');

  if (exists(dir, '.github', 'workflows')) add('ci:github-actions', '.github/workflows');
  if (exists(dir, '.git')) add('vcs:git', '.git');
  if (exists(dir, 'Dockerfile') || exists(dir, 'docker-compose.yml') || exists(dir, 'docker-compose.yaml') || exists(dir, 'compose.yaml')) add('infra:docker', 'Docker file');
  if (exists(dir, 'openapi.yaml') || exists(dir, 'openapi.yml') || exists(dir, 'openapi.json') || exists(dir, 'swagger.json')) add('api:openapi', 'OpenAPI spec');
  if (exists(dir, 'tests') || exists(dir, 'test') || exists(dir, '__tests__') || exists(dir, 'spec')) add('test:suite', 'test folder');
  // Existence only: the contents of an env file are never read.
  if (exists(dir, '.env') || exists(dir, '.env.local') || exists(dir, '.env.example')) add('file:env', 'env file present (not read)');
  if (exists(dir, 'prisma', 'schema.prisma')) add('db:prisma', 'prisma/schema.prisma');
  if (exists(dir, 'supabase')) add('db:supabase', 'supabase folder');
  if (exists(dir, 'migrations') || exists(dir, 'db', 'migrate')) add('db:migrations', 'migrations folder');

  const entries = listDir(dir).filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules');
  if (signals.size === 0 && entries.length === 0) add('project:empty', 'folder is empty');
  else if (![...signals].some((s) => s.startsWith('lang:'))) add('project:no-manifest', 'no language manifest found');

  return { signals: [...signals].sort(), evidence };
}

export function readExistingSetup(dir) {
  const claudeDir = path.join(dir, '.claude');
  const settings = readJson(path.join(claudeDir, 'settings.json')) || {};
  const local = readJson(path.join(claudeDir, 'settings.local.json')) || {};
  const hookEvents = new Set([...Object.keys(settings.hooks || {}), ...Object.keys(local.hooks || {})]);
  const mcpJson = readJson(path.join(dir, '.mcp.json')) || {};
  const names = (sub, filter) =>
    listDir(path.join(claudeDir, sub))
      .filter(filter)
      .map((e) => e.name.replace(/\.md$/i, ''));
  return {
    claudeMd: exists(dir, 'CLAUDE.md') || exists(claudeDir, 'CLAUDE.md'),
    hookEvents: [...hookEvents].sort(),
    mcpServers: Object.keys(mcpJson.mcpServers || {}).sort(),
    skills: names('skills', (e) => e.isDirectory() || e.isSymbolicLink()),
    subagents: names('agents', (e) => e.isFile() && /\.md$/i.test(e.name)),
    commands: names('commands', (e) => e.isFile() && /\.md$/i.test(e.name)),
  };
}

export const CATEGORIES = ['memory', 'mcp', 'skill', 'hook', 'subagent', 'command'];

// rule: { id, category, name, why, when: [signal, ...], weight?, skillQuery?, hookEvent? }
// A rule matches when ANY signal in `when` is present. Rules already satisfied by
// the project's existing setup are dropped. Returns the top `perCategory` of each
// category, or the top `limit` of just `category` when one is asked for.
export function recommend(signals, existing, rules, { category, perCategory = 2, limit = 5 } = {}) {
  const have = new Set(signals);
  const present = (r) => {
    if (r.category === 'memory') return existing.claudeMd;
    if (r.category === 'mcp') return existing.mcpServers.includes(r.id);
    if (r.category === 'skill') return existing.skills.includes(r.id);
    if (r.category === 'subagent') return existing.subagents.includes(r.id);
    if (r.category === 'command') return existing.commands.includes(r.id);
    if (r.category === 'hook') return Boolean(r.hookEvent) && existing.hookEvents.includes(r.hookEvent);
    return false;
  };
  const scored = [];
  for (const r of rules) {
    if (category && r.category !== category) continue;
    const matched = (r.when || []).filter((s) => have.has(s));
    if (matched.length === 0 || present(r)) continue;
    scored.push({ ...r, matched, score: (r.weight ?? 1) * 10 + matched.length });
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const cap = category ? limit : perCategory;
  const taken = new Map();
  const out = [];
  for (const r of scored) {
    const n = taken.get(r.category) || 0;
    if (n >= cap) continue;
    taken.set(r.category, n + 1);
    out.push(r);
  }
  const order = (c) => CATEGORIES.indexOf(c);
  return out.sort((a, b) => order(a.category) - order(b.category) || b.score - a.score);
}
