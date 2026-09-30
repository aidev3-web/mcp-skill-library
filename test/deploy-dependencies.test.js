import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const SKILL_MD = (name) => `---\nname: ${name}\ndescription: the ${name} skill\n---\nbody\n`;

// A machine with Claude Code installed (home/.claude) and a library holding a skill,
// two dependencies (one optional) and an agent file bundled with the main skill.
function machine({ missing = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-deps-'));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const lib = path.join(root, 'lib');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const skill = (name, extra = {}) => {
    if (missing.includes(name)) return;
    fs.mkdirSync(path.join(lib, name), { recursive: true });
    fs.writeFileSync(path.join(lib, name, 'SKILL.md'), SKILL_MD(name));
    for (const [f, c] of Object.entries(extra)) {
      fs.mkdirSync(path.dirname(path.join(lib, name, f)), { recursive: true });
      fs.writeFileSync(path.join(lib, name, f), c);
    }
  };
  skill('main', { 'dependencies.json': JSON.stringify({ requires: ['req'], optional: ['opt'] }), 'agents/worker.md': 'agent body' });
  skill('req');
  skill('opt');
  return { root, home, lib };
}

async function connect(m) {
  const env = { ...process.env, USERPROFILE: m.home, HOME: m.home, SKILL_LIBRARY_PATH: m.lib, SKILL_LIB_AUTO_HOOK: '0' };
  delete env.CLAUDE_CONFIG_DIR;
  const client = new Client({ name: 'deploy-deps-test', version: '0.0.1' });
  await client.connect(new StdioClientTransport({ command: 'node', args: ['index.js'], cwd: PACKAGE_ROOT, env }));
  return client;
}

const deploy = (client, extra = {}) =>
  client.callTool({ name: 'deploy_skill', arguments: { skillName: 'main', scopes: ['global'], targets: ['claude-code'], ...extra } });

test('deploy_skill links the skill AND its dependencies, and copies the skill\'s agent files', async () => {
  const m = machine();
  const client = await connect(m);
  try {
    const res = await deploy(client);
    const skills = fs.readdirSync(path.join(m.home, '.claude', 'skills')).sort();
    assert.deepEqual(skills, ['main', 'opt', 'req']);
    assert.equal(fs.readFileSync(path.join(m.home, '.claude', 'agents', 'worker.md'), 'utf8'), 'agent body');
    const text = res.content.map((c) => c.text).join('\n');
    assert.match(text, /Plus 2 dependencies/);
    assert.deepEqual(res.structuredContent.results.filter((r) => r.status === 'deployed').map((r) => r.skill).sort(), ['main', 'opt', 'req']);
  } finally {
    await client.close();
  }
});

test('includeOptional:false leaves the optional dependency out', async () => {
  const m = machine();
  const client = await connect(m);
  try {
    await deploy(client, { includeOptional: false });
    assert.deepEqual(fs.readdirSync(path.join(m.home, '.claude', 'skills')).sort(), ['main', 'req']);
  } finally {
    await client.close();
  }
});

test('withDependencies:false deploys only the skill itself', async () => {
  const m = machine();
  const client = await connect(m);
  try {
    await deploy(client, { withDependencies: false });
    assert.deepEqual(fs.readdirSync(path.join(m.home, '.claude', 'skills')), ['main']);
  } finally {
    await client.close();
  }
});

test('a dependency that is not in the library is reported, not silently skipped, and the rest still deploys', async () => {
  const m = machine({ missing: ['req'] });
  const client = await connect(m);
  try {
    const res = await deploy(client);
    const missing = res.structuredContent.results.filter((r) => r.status === 'dependency-missing');
    assert.deepEqual(missing.map((r) => r.skill), ['req']);
    assert.match(missing[0].note, /pull_skill/);
    assert.deepEqual(fs.readdirSync(path.join(m.home, '.claude', 'skills')).sort(), ['main', 'opt']);
  } finally {
    await client.close();
  }
});

test('a skill without dependencies.json deploys exactly as before', async () => {
  const m = machine();
  fs.rmSync(path.join(m.lib, 'main', 'dependencies.json'));
  const client = await connect(m);
  try {
    const res = await deploy(client);
    assert.deepEqual(fs.readdirSync(path.join(m.home, '.claude', 'skills')), ['main']);
    assert.doesNotMatch(res.content.map((c) => c.text).join('\n'), /dependenc/);
  } finally {
    await client.close();
  }
});
