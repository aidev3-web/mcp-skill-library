// Regression tests for the hardening pass of 2026-09-11. Each test here maps
// to a hole that was demonstrated against the running server, not a
// hypothetical — if one of these starts failing, that hole is back open.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getBlobBytes, __setGhRunner } from '../lib/github.js';
import { findSecretFiles } from '../lib/localfs.js';
import { findRemainingDeployments } from '../lib/agents.js';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

function sandbox(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sb-${name}-`));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Boots the real server over stdio with its skill library pointed at `libRoot`,
// so these exercise the same code path a client does — an in-process import
// would skip the MCP layer's own argument handling.
async function connect(libRoot, extraEnv = {}) {
  const env = { ...process.env, SKILL_LIBRARY_PATH: libRoot, ...extraEnv };
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  const client = new Client({ name: 'security-test', version: '0.0.1' });
  await client.connect(new StdioClientTransport({ command: 'node', args: ['index.js'], cwd: PACKAGE_ROOT, env }));
  return client;
}

function textOf(res) {
  return (res.content || []).map((c) => c.text || '').join('\n');
}

test('remove_skill refuses a traversing skillName instead of deleting outside the library', async () => {
  const root = sandbox('traversal');
  const lib = path.join(root, 'skill-library');
  const victim = path.join(root, 'important-user-files');
  fs.mkdirSync(lib, { recursive: true });
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'precious.txt'), 'the user\'s real work');

  const client = await connect(lib);
  try {
    for (const skillName of ['../important-user-files', '..\\important-user-files', victim, 'a/b', '..', '.']) {
      const res = await client.callTool({ name: 'remove_skill', arguments: { skillName } });
      assert.equal(res.isError, true, `expected refusal for ${JSON.stringify(skillName)}`);
      assert.match(textOf(res), /Invalid skillName/);
    }
  } finally {
    await client.close();
  }

  assert.ok(fs.existsSync(path.join(victim, 'precious.txt')), 'out-of-library file must survive');
});

test('deploy_skill refuses a traversing skillName', async () => {
  const lib = sandbox('deploy-traversal');
  const client = await connect(lib);
  try {
    const res = await client.callTool({
      name: 'deploy_skill',
      arguments: { skillName: '../../Documents' },
    });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /Invalid skillName/);
  } finally {
    await client.close();
  }
});

test('remove_skill keeps the library folder while the skill is still deployed somewhere', async () => {
  const root = sandbox('still-deployed');
  const lib = path.join(root, 'skill-library');
  const project = path.join(root, 'project');
  const skillDir = path.join(lib, 'demo-skill');
  const projectSkills = path.join(project, '.claude', 'skills');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(projectSkills, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: d\n---\n');
  fs.symlinkSync(skillDir, path.join(projectSkills, 'demo-skill'), process.platform === 'win32' ? 'junction' : 'dir');

  const client = await connect(lib);
  try {
    // Asked to undeploy the GLOBAL scope only — the project-scope link stays,
    // so deleting the library folder here would leave it dangling.
    const res = await client.callTool({
      name: 'remove_skill',
      arguments: { skillName: 'demo-skill', cwd: project, scopes: ['global'] },
    });
    assert.equal(res.structuredContent.libraryRemoved, false);
    assert.match(res.structuredContent.librarySkipReason, /still deployed/);
    assert.ok(fs.existsSync(skillDir), 'library folder must survive while a link points at it');

    // Now undeploy everything: the link goes, and the folder may be deleted.
    const res2 = await client.callTool({
      name: 'remove_skill',
      arguments: { skillName: 'demo-skill', cwd: project },
    });
    assert.equal(res2.structuredContent.libraryRemoved, true);
    assert.ok(!fs.existsSync(skillDir));
    assert.ok(!fs.existsSync(path.join(projectSkills, 'demo-skill')));
  } finally {
    await client.close();
  }
});

test('push_skill refuses a skill folder containing credential files, before any GitHub call', async () => {
  const root = sandbox('secrets');
  const skill = path.join(root, 'leaky-skill');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: leaky-skill\ndescription: A skill with a secret in it\n---\n\nBody.\n');
  fs.writeFileSync(path.join(skill, '.env'), 'API_KEY=sk-live-should-never-be-pushed\n');
  fs.writeFileSync(path.join(skill, 'deploy.pem'), '-----BEGIN PRIVATE KEY-----\n');
  fs.writeFileSync(path.join(skill, '.env.example'), 'API_KEY=\n'); // a template: must NOT trip the check

  const client = await connect(path.join(root, 'lib'));
  try {
    const res = await client.callTool({
      name: 'push_skill',
      arguments: { skillPath: skill, owner: 'aidev3-web', repo: 'SKILL-LIB', identity: 'test' },
    });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.status, 'secrets-detected');
    const txt = textOf(res);
    assert.match(txt, /\.env/);
    assert.match(txt, /deploy\.pem/);
    assert.ok(!/\.env\.example/.test(txt), '.env.example is a template and must be allowed');
  } finally {
    await client.close();
  }
});

test('findSecretFiles flags credentials but not their .example/.sample templates', () => {
  const flagged = findSecretFiles(
    ['SKILL.md', '.env', '.env.local', '.env.example', '.env.sample', 'certs/server.key', 'id_rsa', 'notes/keyboard.md']
      .map((relativePath) => ({ relativePath })),
  );
  assert.deepEqual(flagged.sort(), ['.env', '.env.local', 'certs/server.key', 'id_rsa'].sort());
});

test('getBlobBytes returns the exact bytes GitHub sent (no utf8 round-trip corruption)', async () => {
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  __setGhRunner(async () => ({
    code: 0,
    stdout: JSON.stringify({ content: pngHeader.toString('base64'), encoding: 'base64' }),
    stderr: '',
  }));
  try {
    const bytes = await getBlobBytes('owner', 'repo', 'deadbeef');
    assert.deepEqual([...bytes], [...pngHeader]);
  } finally {
    __setGhRunner();
  }
});

test('an invalid owner/repo cannot reshape the API path', async () => {
  __setGhRunner(async () => ({ code: 0, stdout: '{}', stderr: '' }));
  try {
    await assert.rejects(() => getBlobBytes('owner/../..', 'repo', 'sha'), /Invalid GitHub owner\/repo/);
    await assert.rejects(() => getBlobBytes('owner', 'repo?foo=1', 'sha'), /Invalid GitHub owner\/repo/);
  } finally {
    __setGhRunner();
  }
});

test('findRemainingDeployments ignores a same-named symlink pointing elsewhere', () => {
  const root = sandbox('not-ours');
  const skillDir = path.join(root, 'lib', 'demo');
  // Same folder NAME, different place — the exact case a naive existsSync
  // check would mistake for "this skill is still deployed".
  const otherDir = path.join(root, 'somewhere-else', 'demo');
  const skillsDir = path.join(root, '.claude', 'skills');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.symlinkSync(otherDir, path.join(skillsDir, 'demo'), process.platform === 'win32' ? 'junction' : 'dir');

  const targets = [{ agent: 'claude-code', scope: 'project', skillsDir, agentPresent: true }];
  assert.deepEqual(findRemainingDeployments(skillDir, targets), []);
  assert.equal(findRemainingDeployments(otherDir, targets).length, 1);
});

test('a malformed sources.local.json names the offending file instead of leaking a bare parse error', async () => {
  const lib = sandbox('bad-sources');
  fs.writeFileSync(path.join(lib, 'sources.local.json'), '{ this is not json');

  const client = await connect(lib);
  try {
    const res = await client.callTool({ name: 'search_all_sources', arguments: { query: 'x' } });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /sources\.local\.json/);
  } finally {
    await client.close();
  }
});
