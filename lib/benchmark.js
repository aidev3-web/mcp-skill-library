import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { walkSkillFiles } from './localfs.js';

// The 6-layer rubric this project's own research settled on (see
// skill-evaluation-kit.html): 0 Static, 1 Trigger, 2 Outcome, 3 Stability,
// 4 Edge case & guardrail, 5 Scope. This server can only mechanically
// compute Layer 0 — it has no ability to spawn agent sessions itself, so
// Layers 1-3 need real evidence from the CALLING agent actually spawning
// fresh sessions (via its own Agent/Task tooling) and observing what
// happens, not a self-rated guess. buildTestPlan() returns that
// instruction set; push_skill's benchmark gate then requires the
// concrete evidence fields it asks for — a bare 0-20 number is no longer
// accepted for Layers 1-3, on purpose (a guessed number was found to be
// unfalsifiable and was rejected as an evaluation method for this repo).

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

// Layers 1-5 need either real execution evidence (1-3) or a reader who
// can understand the skill's intent (4-5) — neither of which this
// stdio server can do itself. This returns the skill's content plus a
// concrete test plan, and tells the calling agent exactly what evidence
// push_skill's `benchmark` argument now requires per layer.
export function buildTestPlan(skillDir, staticSignals) {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  const skillMd = fs.existsSync(skillMdPath) ? fs.readFileSync(skillMdPath, 'utf8') : '(no SKILL.md found)';
  const files = walkSkillFiles(skillDir).map((f) => f.relativePath);

  return `Layers 1-5 of this project's 6-layer rubric (Layer 0 was already computed above you). Layers 1-3 require you to actually spawn fresh, no-prior-context sessions (your own Agent/Task tooling) and observe real behavior — a self-rated guess is not accepted for those, and push_skill's benchmark gate checks the boolean fields below mechanically, not just a total score.

Files in this skill: ${files.join(', ') || '(none besides SKILL.md)'}

--- SKILL.md content ---
${skillMd}
--- end SKILL.md content ---

## Layer 1 — Trigger (real test, 0-20)
Spawn a fresh session with this skill available and give it a realistic prompt that SHOULD trigger this skill (e.g. adapted from the skill's own description). Separately, spawn another fresh session and give it a realistic but adjacent prompt that should NOT trigger this skill (something a careless description could still catch). Report:
{ "positivePrompt": "...", "positiveFired": true/false, "negativePrompt": "...", "negativeFired": true/false, "sessionEvidence": "<1-2 sentences on what each fresh session actually did>" }
push_skill requires positiveFired === true AND negativeFired === false.

## Layer 2 — Outcome (real test, 0-20)
Spawn two fresh sessions given the exact same realistic task: one WITH this skill available, one WITHOUT it (undeploy it first, or use a session where it was never deployed). Compare the two results. Report:
{ "withSkillResult": "<short summary of what the with-skill session produced>", "withoutSkillResult": "<short summary of the without-skill session>", "skillHelped": true/false }
push_skill requires skillHelped === true.

## Layer 3 — Stability (real test, 0-20)
Run the SAME scenario 3 separate times (3 fresh sessions, skill available), and compare the 3 results for consistency. Report:
{ "runs": 3, "consistent": true/false, "notes": "<what varied between runs, if anything>" }
push_skill requires runs >= 3 AND consistent === true.

## Layer 4 — Edge case & guardrail (read & judge, 0-20)
No session spawning needed — read the SKILL.md content above. Does it call out its own edge cases, limits, or safety rules explicitly, rather than silently assuming a happy path? Report: { "score": 0-20, "notes": "..." }

## Layer 5 — Scope (read & judge, 0-20)
No session spawning needed — is the skill's job narrowly and clearly bounded, or does it invite scope creep into unrelated tasks? Report: { "score": 0-20, "notes": "..." }

Then call push_skill with a \`benchmark\` argument shaped like:
{
  "layer0Passed": ${staticSignals.passed},
  "trigger": { "positivePrompt": "...", "positiveFired": true, "negativePrompt": "...", "negativeFired": false, "sessionEvidence": "..." },
  "outcome": { "withSkillResult": "...", "withoutSkillResult": "...", "skillHelped": true },
  "stability": { "runs": 3, "consistent": true, "notes": "..." },
  "edgeCase": { "score": 0-20, "notes": "..." },
  "scope": { "score": 0-20, "notes": "..." },
  "score": <edgeCase.score + scope.score + 20 if trigger passed + 20 if outcome passed + 20 if stability passed, 0-100>,
  "summary": "<one sentence per weak layer, or 'no concerns'>",
  "weakLayers": [<names of any weak layer>]
}

Be honest and conservative — a fabricated or skipped test is worse than a low score, since a low score here is cheap to fix and a false pass isn't.`;
}
