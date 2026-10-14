import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanProject, readExistingSetup, recommend } from '../lib/recommend.js';

const RULES = JSON.parse(fs.readFileSync(new URL('../data/setup-rules.json', import.meta.url), 'utf8')).rules;

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recommend-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

const NEXT_APP = {
  'package.json': JSON.stringify({ dependencies: { next: '15', react: '19', stripe: '1' }, devDependencies: { prettier: '3', jest: '29' } }),
  '.env': 'SECRET=do-not-read',
  '.github/workflows/ci.yml': 'on: push',
  'tests/a.test.js': '',
};

test('scan picks up language, framework, database, test, CI and env signals', () => {
  const { signals } = scanProject(project(NEXT_APP));
  for (const s of ['lang:node', 'fw:next', 'fw:react', 'api:stripe', 'tool:prettier', 'test:jest', 'test:suite', 'ci:github-actions', 'file:env']) {
    assert.ok(signals.includes(s), `missing ${s}`);
  }
});

test('scan never reads the contents of .env', () => {
  const { evidence } = scanProject(project(NEXT_APP));
  assert.ok(!JSON.stringify(evidence).includes('do-not-read'));
});

test('python manifest signals', () => {
  const { signals } = scanProject(project({ 'requirements.txt': 'streamlit>=1.65\nreportlab\n', 'requirements-dev.txt': 'pytest' }));
  assert.ok(signals.includes('lang:python') && signals.includes('fw:streamlit') && signals.includes('test:pytest'));
});

test('an empty folder is reported as empty', () => {
  assert.deepEqual(scanProject(project({})).signals, ['project:empty']);
});

test('recommends at most two per category and ranks by weight', () => {
  const { signals } = scanProject(project(NEXT_APP));
  const recs = recommend(signals, readExistingSetup(project({})), RULES);
  const counts = {};
  for (const r of recs) counts[r.category] = (counts[r.category] || 0) + 1;
  assert.ok(Object.values(counts).every((n) => n <= 2));
  assert.ok(recs.some((r) => r.id === 'context7'));
  assert.ok(recs.some((r) => r.id === 'block-secret-files'));
});

test('does not recommend what the project already has', () => {
  const dir = project({
    ...NEXT_APP,
    'CLAUDE.md': '# x',
    '.mcp.json': JSON.stringify({ mcpServers: { context7: {}, playwright: {} } }),
    '.claude/settings.json': JSON.stringify({ hooks: { PreToolUse: [] } }),
    '.claude/agents/code-reviewer.md': '---\nname: code-reviewer\n---\n',
    '.claude/skills/frontend-design/SKILL.md': '',
  });
  const existing = readExistingSetup(dir);
  assert.equal(existing.claudeMd, true);
  assert.deepEqual(existing.mcpServers, ['context7', 'playwright']);
  const ids = recommend(scanProject(dir).signals, existing, RULES, { perCategory: 50 }).map((r) => r.id);
  for (const gone of ['claude-md', 'context7', 'playwright', 'block-secret-files', 'code-reviewer', 'frontend-design']) {
    assert.ok(!ids.includes(gone), `${gone} should be skipped`);
  }
});

test('asking for one category returns only that category, up to five', () => {
  const { signals } = scanProject(project(NEXT_APP));
  const recs = recommend(signals, readExistingSetup(project({})), RULES, { category: 'hook' });
  assert.ok(recs.length > 0 && recs.length <= 5);
  assert.ok(recs.every((r) => r.category === 'hook'));
});

test('every rule is well formed', () => {
  const ids = new Set();
  for (const r of RULES) {
    assert.ok(r.id && r.name && r.why && Array.isArray(r.when) && r.when.length, `bad rule ${r.id}`);
    assert.ok(!ids.has(`${r.category}/${r.id}`), `duplicate ${r.id}`);
    ids.add(`${r.category}/${r.id}`);
  }
});

test('an empty folder still gets the CLAUDE.md recommendation', () => {
  const recs = recommend(['project:empty'], readExistingSetup(project({})), RULES);
  assert.deepEqual(recs.map((r) => r.id), ['claude-md']);
});
