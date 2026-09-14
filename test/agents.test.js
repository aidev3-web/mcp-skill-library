import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deploySkill } from '../lib/agents.js';

function makeSourceSkill() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillbridge-agents-src-'));
  const skillDir = path.join(dir, 'demo-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: x\n---\n');
  return skillDir;
}

test('agent not present -> skipped-agent-not-found, no filesystem writes attempted', () => {
  const source = makeSourceSkill();
  const target = {
    agent: 'cursor',
    scope: 'global',
    skillsDir: path.join(os.tmpdir(), 'skillbridge-agents-nonexistent-' + Date.now(), 'skills'),
    agentPresent: false,
  };

  const [result] = deploySkill(source, [target]);

  assert.equal(result.status, 'skipped-agent-not-found');
  assert.equal(fs.existsSync(target.skillsDir), false);
});

test('symlink failure falls back to a real copy, with a note explaining why', (t) => {
  const source = makeSourceSkill();
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillbridge-agents-dst-'));
  const target = { agent: 'claude-code', scope: 'global', skillsDir, agentPresent: true };

  const original = fs.symlinkSync;
  fs.symlinkSync = () => {
    throw new Error('EPERM: operation not permitted, symlink');
  };
  t.after(() => {
    fs.symlinkSync = original;
  });

  const [result] = deploySkill(source, [target]);

  assert.equal(result.status, 'deployed-copy');
  assert.ok(result.note && result.note.includes('symlink unavailable'));
  const copiedSkillMd = path.join(skillsDir, 'demo-skill', 'SKILL.md');
  assert.equal(fs.existsSync(copiedSkillMd), true);
  assert.equal(fs.lstatSync(path.join(skillsDir, 'demo-skill')).isSymbolicLink(), false);
});
