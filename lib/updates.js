import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { walkSkillFiles } from './localfs.js';
import { validateSkillFolder } from './validate.js';
import { mapWithConcurrency } from './util.js';

// Everything the update flow needs that does not touch the network or the MCP
// transport, so it can be unit-tested with plain temp folders and fake trees.
//
// The model: pull_skill records, per skill, WHERE it came from and the git blob
// sha of every file it wrote (.source.json). Later, comparing that record with
// the remote tree tells whether the skill changed, which files, and — by
// hashing the local files again — whether the user edited any of them.

export const SOURCE_FILE = '.source.json';

// git's own object id for a file's bytes: sha1("blob <size>\0" + bytes). The
// GitHub tree API reports exactly this, so a local file can be compared to the
// remote one without downloading anything.
export function gitBlobSha(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
}

// One short id for "this exact remote state of the skill". Declining an update
// records it, so only a state that differs from the declined one asks again.
export function signatureOf(files) {
  const lines = Object.keys(files)
    .sort()
    .map((k) => `${k}:${files[k]}`)
    .join('\n');
  return crypto.createHash('sha1').update(lines).digest('hex');
}

export function readSource(skillDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(skillDir, SOURCE_FILE), 'utf8'));
    if (parsed && parsed.owner && parsed.repo && parsed.path && parsed.files && typeof parsed.files === 'object') return parsed;
  } catch {
    // missing or unreadable: the skill is simply not tracked
  }
  return null;
}

export function writeSource(skillDir, record) {
  fs.writeFileSync(path.join(skillDir, SOURCE_FILE), JSON.stringify(record, null, 2) + '\n');
}

// { "SKILL.md": sha, "assets/a.md": sha } for the blobs under skillPath.
export function remoteFilesFromTree(tree, skillPath) {
  const prefix = skillPath ? `${skillPath}/` : '';
  const out = {};
  for (const e of tree) {
    if (e.type !== 'blob' || !e.path.startsWith(prefix)) continue;
    out[e.path.slice(prefix.length)] = e.sha;
  }
  return out;
}

export function diffFiles(before, after) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const rel of Object.keys(after)) {
    if (!(rel in before)) added.push(rel);
    else if (before[rel] !== after[rel]) changed.push(rel);
  }
  for (const rel of Object.keys(before)) if (!(rel in after)) removed.push(rel);
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}

function localFileHashes(skillDir) {
  const out = {};
  for (const f of walkSkillFiles(skillDir)) {
    if (f.relativePath === SOURCE_FILE) continue;
    out[f.relativePath] = gitBlobSha(fs.readFileSync(f.absolutePath));
  }
  return out;
}

// Files the user changed (or deleted) since the last pull/update: local hash
// differs from the recorded one. Only these can be lost by an update.
export function localModifications(skillDir, recordedFiles) {
  const local = localFileHashes(skillDir);
  const modified = [];
  for (const rel of Object.keys(recordedFiles)) {
    if (local[rel] !== recordedFiles[rel]) modified.push(rel);
  }
  return modified.sort();
}

// True when rel, resolved under root, stays inside root (repo-controlled paths
// are treated like archive entries: anything that escapes is refused).
export function isInside(root, rel) {
  const dest = path.resolve(root, rel);
  return dest === path.join(root, rel) && dest.startsWith(path.resolve(root) + path.sep);
}

const DOWNLOAD_CONCURRENCY = 5;
const PREVIEW_FILES = 3;
const PREVIEW_MAX_BYTES = 40 * 1024;
const PREVIEW_LINES = 8;
const TEXT_EXT = /\.(md|txt|json|ya?ml|py|js|mjs|ts|sh|ps1|html|css)$/i;

// A few added/removed lines per changed text file, so whoever reads the report
// can say what actually changed, not only which files. Set-based on purpose: it
// answers "which lines are new or gone", which is enough to judge relevance.
export function textDiffSummary(oldText, newText, maxLines = PREVIEW_LINES) {
  const clean = (t) => t.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  const before = clean(oldText);
  const after = clean(newText);
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((l) => !beforeSet.has(l));
  const removed = before.filter((l) => !afterSet.has(l));
  const cut = (arr) => arr.slice(0, maxLines).map((l) => (l.length > 160 ? `${l.slice(0, 157)}...` : l));
  return { added: cut(added), removed: cut(removed), addedTotal: added.length, removedTotal: removed.length };
}

async function buildPreviews(skillDir, diff, remote, src, fetchBlob) {
  const previews = [];
  const candidates = [...diff.changed, ...diff.added].filter((rel) => TEXT_EXT.test(rel));
  candidates.sort((a, b) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : 0));
  for (const rel of candidates.slice(0, PREVIEW_FILES)) {
    try {
      const bytes = await fetchBlob(src.owner, src.repo, remote[rel]);
      if (!bytes || bytes.length > PREVIEW_MAX_BYTES || bytes.includes(0)) continue;
      let oldText = '';
      if (diff.changed.includes(rel)) {
        try {
          oldText = fs.readFileSync(path.join(skillDir, rel), 'utf8');
        } catch {
          // the old text is gone locally: report the new file's lines as added
        }
      }
      previews.push({ file: rel, ...textDiffSummary(oldText, bytes.toString('utf8')) });
    } catch {
      // a preview is a nicety; never fail the check over it
    }
  }
  return previews;
}

// What check_skill_update reports. Network access is injected so tests can
// drive it with fake trees: loadTree(owner, repo, ref) -> { tree } and
// getCommits(owner, repo, ref, path) -> [{ sha, message, date }].
// fetchBlob(owner, repo, sha) -> Buffer is optional and only used for the change preview.
export async function checkForUpdate(skillDir, { loadTree, getCommits, fetchBlob, ignoreDeclined = false }) {
  const src = readSource(skillDir);
  if (!src) return { status: 'untracked' };

  const { tree } = await loadTree(src.owner, src.repo, src.ref);
  const remote = remoteFilesFromTree(tree, src.path);
  if (!remote['SKILL.md']) return { status: 'removed-upstream' };

  const diff = diffFiles(src.files, remote);
  if (!diff.added.length && !diff.changed.length && !diff.removed.length) return { status: 'up-to-date' };

  const signature = signatureOf(remote);
  if (!ignoreDeclined && src.declinedSignature === signature) return { status: 'declined', signature };

  let commits = [];
  try {
    commits = await getCommits(src.owner, src.repo, src.ref, src.path);
  } catch {
    // messages are a nicety; the file list alone is enough to decide
  }
  const previews = fetchBlob ? await buildPreviews(skillDir, diff, remote, src, fetchBlob) : [];
  const touched = new Set([...diff.changed, ...diff.removed]);
  const conflicts = localModifications(skillDir, src.files).filter((f) => touched.has(f));
  return { status: 'update-available', diff, commits, previews, conflicts, signature, remote, source: src };
}

// Copies of skills replaced by an update live outside the skill folder so they
// are never walked as part of it or deployed alongside it.
export function backupSkill(skillDir, historyRoot, label) {
  const dest = path.join(historyRoot, path.basename(skillDir), label);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(skillDir, dest, { recursive: true });
  return dest;
}

function pruneEmptyDirs(root, startDir) {
  let dir = startDir;
  while (dir.startsWith(root + path.sep)) {
    if (fs.readdirSync(dir).length) break;
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
}

// Downloads the changed files, stages the result, validates it, backs up the
// current folder, then applies the change file by file in place (the folder
// itself is never renamed, so junctions/symlinks that point at it keep working).
//   result.status: 'updated' | 'dry-run' | 'conflict' | 'invalid' | 'error'
export async function performUpdate(skillDir, { check, fetchBlob, historyRoot, force = false, dryRun = false, now = () => new Date() }) {
  const { diff, remote, source: src, conflicts } = check;
  const plan = { added: diff.added, changed: diff.changed, removed: diff.removed };

  if (dryRun) return { status: 'dry-run', conflicts, plan }; // reports even when a real run would be blocked
  if (conflicts.length && !force) return { status: 'conflict', conflicts, plan };

  // Download everything first: nothing on disk is touched if a fetch fails.
  const wanted = [...diff.added, ...diff.changed];
  for (const rel of wanted) {
    if (!isInside(skillDir, rel)) return { status: 'error', error: `Remote entry "${rel}" resolves outside the skill folder — refusing (path traversal).`, plan };
  }
  // A handful at a time: one at a time made a 17-file skill take ~17 s, and an
  // unbounded burst would open one socket per file.
  const blobs = await mapWithConcurrency(wanted, DOWNLOAD_CONCURRENCY, (rel) => fetchBlob(src.owner, src.repo, remote[rel]));
  const writes = new Map(wanted.map((rel, i) => [rel, blobs[i]]));

  // Stage a full copy with the change applied and run the same validation
  // pull/push use, so a broken upstream state is refused before it lands.
  // The stage folder must carry the real skill name: validation checks that the
  // frontmatter name matches the folder name.
  const stageRoot = fs.mkdtempSync(path.join(path.dirname(skillDir), '.update-'));
  const stage = path.join(stageRoot, path.basename(skillDir));
  try {
    fs.cpSync(skillDir, stage, { recursive: true });
    for (const [rel, bytes] of writes) {
      fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
      fs.writeFileSync(path.join(stage, rel), bytes);
    }
    for (const rel of diff.removed) fs.rmSync(path.join(stage, rel), { force: true });
    const verdict = validateSkillFolder(stage);
    if (!verdict.valid) return { status: 'invalid', issues: verdict.issues, plan };
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }

  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const backup = backupSkill(skillDir, historyRoot, `${stamp}-${signatureOf(src.files).slice(0, 8)}`);

  for (const [rel, bytes] of writes) {
    const dest = path.join(skillDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
  }
  for (const rel of diff.removed) {
    const dest = path.join(skillDir, rel);
    fs.rmSync(dest, { force: true });
    pruneEmptyDirs(path.resolve(skillDir), path.dirname(dest));
  }

  writeSource(skillDir, {
    ...src,
    files: remote,
    commit: check.commits?.[0]?.sha ?? src.commit ?? null,
    pulledAt: now().toISOString(),
    declinedSignature: null,
  });
  return { status: 'updated', plan, backup, forced: Boolean(conflicts.length) };
}

export function recordDecline(skillDir, signature) {
  const src = readSource(skillDir);
  if (!src) return false;
  writeSource(skillDir, { ...src, declinedSignature: signature });
  return true;
}

// Agent definition files (<skill>/agents/*.md) are copied, not linked, into an
// agent host's agents/ folder, so they do not follow a library update by
// themselves. Rules per destination file:
//   missing                       -> copy
//   identical to the new version  -> up to date
//   identical to the version this skill shipped before (oldHashes)
//                                 -> the user never edited it, safe to replace
//   anything else                 -> the user's own edit: leave it (force overrides)
export function syncAgentFiles(skillDir, agentDirs, { oldHashes = {}, force = false, dryRun = false } = {}) {
  const srcDir = path.join(skillDir, 'agents');
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) return [];
  const results = [];
  for (const dir of agentDirs) {
    for (const name of fs.readdirSync(srcDir).filter((n) => n.endsWith('.md')).sort()) {
      const src = path.join(srcDir, name);
      const dest = path.join(dir, name);
      const newHash = gitBlobSha(fs.readFileSync(src));
      let status;
      if (!fs.existsSync(dest)) status = 'copied';
      else {
        const destHash = gitBlobSha(fs.readFileSync(dest));
        if (destHash === newHash) status = 'up-to-date';
        else if (destHash === oldHashes[`agents/${name}`]) status = 'updated';
        else if (force) status = 'overwritten';
        else status = 'skipped-edited';
      }
      if (!dryRun && (status === 'copied' || status === 'updated' || status === 'overwritten')) {
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(src, dest);
      }
      results.push({ file: name, dir, path: dest, status });
    }
  }
  return results;
}

// The text an agent gets when a newer version exists: what changed, and exactly what to ask and call next.
export function describeUpdate(skillName, check) {
  const lines = [`A newer version of "${skillName}" is available upstream (${check.source.owner}/${check.source.repo}, ${check.source.path}).`, ''];
  if (check.commits?.length) {
    lines.push('Recent commits touching this skill:');
    for (const c of check.commits.slice(0, 8)) lines.push(`- ${c.message}${c.date ? ` (${String(c.date).slice(0, 10)})` : ''}`);
    lines.push('');
  }
  const { added, changed, removed } = check.diff;
  lines.push(`Files: ${changed.length} changed, ${added.length} added, ${removed.length} removed.`);
  for (const [label, list] of [['changed', changed], ['added', added], ['removed', removed]]) {
    if (list.length) lines.push(`- ${label}: ${list.slice(0, 12).join(', ')}${list.length > 12 ? `, … (+${list.length - 12} more)` : ''}`);
  }
  for (const p of check.previews || []) {
    lines.push('', `What changed in ${p.file} (lines added / removed; not a full diff):`);
    for (const l of p.added) lines.push(`+ ${l}`);
    if (p.addedTotal > p.added.length) lines.push(`+ … (${p.addedTotal - p.added.length} more added lines)`);
    for (const l of p.removed) lines.push(`- ${l}`);
    if (p.removedTotal > p.removed.length) lines.push(`- … (${p.removedTotal - p.removed.length} more removed lines)`);
  }
  if (check.conflicts?.length) {
    lines.push('', `You have edited ${check.conflicts.join(', ')} locally. An update will not overwrite them unless the user explicitly agrees to force it.`);
  }
  lines.push(
    '',
    'Now: tell the user briefly what changed, say whether it looks relevant to what they are doing in this project, and ask whether to update.',
    `If yes, call update_skill with skillName "${skillName}". If no, call decline_update with skillName "${skillName}" so they are not asked again until the skill changes further.`,
  );
  return lines.join('\n');
}
