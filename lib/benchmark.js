import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { walkSkillFiles } from './localfs.js';

// The 6-layer rubric this project's own research settled on
// (see skill-evaluation-kit.html): Layer 0 (Static) and Layer 1 (Trigger)
// are hard gates, Layers 2-3 (Outcome/Stability) are scored, Layers 4-5
// (Edge case & guardrail / Scope) are manual review. This server can only
// mechanically check Layer 0 — it never runs the skill, so Layers 1-5
// need a judge that can actually read and reason about the skill, which
// is the calling agent, not this tool. buildBenchmarkReport() computes
// Layer 0 and hands the agent everything it needs to judge the rest.

const VAGUE_PHRASES = [
  'helps with', 'various', 'various things', 'a variety of', 'general purpose',
  'general-purpose', 'many things', 'all kinds of', 'etc.', 'and more',
  'utility for', 'stuff', 'things like',
];

const MIN_DESCRIPTION_LEN = 40;
const MAX_DESCRIPTION_LEN = 500;
const MAX_RECOMMENDED_MODULES = 3; // SkillsBench's "complexity contract": 2-3 modules is optimal

// Layer 0 (Static): format, length, complexity contract — a hard gate,
// computed the same way every time, no judgment involved.
export function computeStaticSignals(skillDir) {
  const issues = [];
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) {
    return { passed: false, issues: ['No SKILL.md found in this folder'], moduleCount: 0, descriptionLength: 0 };
  }

  const content = fs.readFileSync(skillMdPath, 'utf8');
  const fm = parseFrontmatter(content) || {};
  const description = String(fm.description || '');

  if (description.length < MIN_DESCRIPTION_LEN) {
    issues.push(`description is only ${description.length} chars (min ${MIN_DESCRIPTION_LEN}) — too short to tell an agent when to use this skill`);
  }
  if (description.length > MAX_DESCRIPTION_LEN) {
    issues.push(`description is ${description.length} chars (max ${MAX_DESCRIPTION_LEN}) — too long, split detail into the body instead`);
  }

  const lowerDesc = description.toLowerCase();
  const foundVague = VAGUE_PHRASES.filter((p) => lowerDesc.includes(p));
  if (foundVague.length) {
    issues.push(`description uses vague phrasing (${foundVague.map((p) => `"${p}"`).join(', ')}) instead of naming concretely when/what it does`);
  }

  const files = walkSkillFiles(skillDir);
  const moduleFiles = files.filter((f) => f.relativePath !== 'SKILL.md' && f.relativePath !== '.meta.json');
  const moduleCount = moduleFiles.length;
  if (moduleCount > MAX_RECOMMENDED_MODULES) {
    issues.push(`${moduleCount} supporting file(s) beyond SKILL.md (recommended max ${MAX_RECOMMENDED_MODULES}) — consider whether this skill is doing more than one job`);
  }

  return { passed: issues.length === 0, issues, moduleCount, descriptionLength: description.length };
}

// Layers 1-5 need a reader that can actually understand the skill's
// intent — that's the calling agent (already an LLM), not this server.
// This returns the skill's own content plus the rubric text, and asks
// the agent to call push_skill with a `benchmark` argument once it has
// judged it. This tool makes no GitHub calls and needs no network.
export function buildJudgePrompt(skillDir, staticSignals) {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  const skillMd = fs.existsSync(skillMdPath) ? fs.readFileSync(skillMdPath, 'utf8') : '(no SKILL.md found)';
  const files = walkSkillFiles(skillDir).map((f) => f.relativePath);

  return `You are judging this skill against the 5 layers this project can't check mechanically (Layer 0 was already computed above you, in staticSignals).

Files in this skill: ${files.join(', ') || '(none besides SKILL.md)'}

--- SKILL.md content ---
${skillMd}
--- end SKILL.md content ---

Score each layer 0-20 (100 total across the 5), based on reading the content above:
- Layer 1 (Trigger, 0-20): would an agent reliably call this skill exactly when it should, and NOT when it shouldn't? Vague triggers or overlapping descriptions with common skills score low.
- Layer 2 (Outcome, 0-20): if an agent followed this skill's instructions, would it plausibly produce a materially better result than winging it without the skill? Skills that just restate common sense score low.
- Layer 3 (Stability, 0-20): are the instructions specific and deterministic enough that following them would give a consistent result run after run, rather than depending on the agent's mood/interpretation? (This server cannot actually run the skill 5 times to verify — judge this from how precise the instructions are.)
- Layer 4 (Edge case & guardrail, 0-20): does the skill call out its own edge cases, limits, or safety rules explicitly, rather than silently assuming a happy path?
- Layer 5 (Scope, 0-20): is the skill's job narrowly and clearly bounded, or does it invite scope creep into unrelated tasks?

Then call push_skill again with a \`benchmark\` argument shaped like:
{ "layer0Passed": ${staticSignals.passed}, "score": <sum of the 5 layer scores, 0-100>, "summary": "<one sentence per weak layer, or 'no concerns'>", "weakLayers": [<names of any layer scored below 12>] }

Be honest and conservative — a low score here blocks the push, which is much cheaper to fix now than after it's shared with the team.`;
}
