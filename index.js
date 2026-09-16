#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureGhReady,
  getDefaultBranch,
  getRecursiveTree,
  getBlobText,
  getBlobBytes,
  getAuthenticatedUser,
  getBranchHead,
  tryGetBranchHead,
  createBranch,
  createBlob,
  createTree,
  createCommit,
  updateRef,
  getFork,
  createFork,
  findOpenPull,
  createPull,
} from './lib/github.js';
import { parseFrontmatter } from './lib/frontmatter.js';
import { detectAgents, deploySkill, removeSkill, findRemainingDeployments } from './lib/agents.js';
import { validateSkillFolder } from './lib/validate.js';
import { isSkillManifestPath, mapWithConcurrency } from './lib/util.js';
import { searchRegistry } from './lib/registry.js';
import { walkSkillFiles, findSecretFiles, findDangerousInstructions } from './lib/localfs.js';
import { computeStaticSignals, buildTestPlan, buildReportHtml, writeReport } from './lib/benchmark.js';

// Independent of where this tool's own code lives — set SKILL_LIBRARY_PATH to
// point at wherever pulled skills should be stored locally.
const LIBRARY_ROOT = process.env.SKILL_LIBRARY_PATH
  ? path.resolve(process.env.SKILL_LIBRARY_PATH)
  : path.join(os.homedir(), '.skill-library');


// Short-lived in-memory cache so paginated search_remote_skills calls (and a
// follow-up pull_skill) don't re-fetch the whole repo tree every time.
const treeCache = new Map(); // key -> { at, tree, truncated }
const TREE_TTL_MS = 5 * 60 * 1000;
// A full recursive tree is megabytes for a large repo, and search_all_sources
// loads one per configured source — without a bound, a long-lived server
// accumulates every tree it has ever seen. Map preserves insertion order, so
// the first key is the oldest.
const TREE_CACHE_MAX = 24;

async function loadTree(owner, repo, ref) {
  await ensureGhReady();
  const resolvedRef = ref || (await getDefaultBranch(owner, repo));
  const key = `${owner}/${repo}@${resolvedRef}`;
  const cached = treeCache.get(key);
  if (cached && Date.now() - cached.at < TREE_TTL_MS) return { ...cached, ref: resolvedRef };
  const { tree, truncated } = await getRecursiveTree(owner, repo, resolvedRef);
  const entry = { at: Date.now(), tree, truncated };
  treeCache.delete(key); // re-insert so a refreshed entry counts as newest
  treeCache.set(key, entry);
  while (treeCache.size > TREE_CACHE_MAX) treeCache.delete(treeCache.keys().next().value);
  return { ...entry, ref: resolvedRef };
}

function skillDirsFromTree(tree) {
  return tree
    .filter((e) => e.type === 'blob' && (e.path === 'SKILL.md' || e.path.endsWith('/SKILL.md')))
    .map((e) => ({
      skillMdPath: e.path,
      sha: e.sha,
      dir: e.path === 'SKILL.md' ? '' : e.path.slice(0, -'/SKILL.md'.length),
    }));
}

// A skill name is one folder directly under LIBRARY_ROOT — never a path.
// Without this, a `skillName` like "../../Documents" escapes the library
// entirely, which for remove_skill meant a recursive delete of whatever it
// landed on. Skill content is pulled from outside repos and read by an agent,
// so a hostile skill could talk an agent into passing exactly that.
function resolveSkillDir(skillName) {
  const name = String(skillName ?? '');
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || path.isAbsolute(name)) {
    return null;
  }
  const root = path.resolve(LIBRARY_ROOT);
  const resolved = path.resolve(root, name);
  // Defence in depth: even a separator-free name must still land inside root.
  if (resolved !== path.join(root, name) || !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

const BAD_SKILL_NAME_MSG =
  'Invalid skillName — it must be a single folder name directly under the skill library (no "/", "\\", "..", or absolute path).';

// Known skill repos to search across in one call: sources.json ships with
// this package (shared, edit via a PR to this repo); sources.local.json is
// optional and lives in LIBRARY_ROOT instead (personal, never committed —
// add your own private repos there without touching the shared list).
const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));

function loadSources() {
  const sources = [];
  const seen = new Set();
  for (const p of [path.join(PACKAGE_ROOT, 'sources.json'), path.join(LIBRARY_ROOT, 'sources.local.json')]) {
    if (!fs.existsSync(p)) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      // Naming the file matters: the local one is hand-edited, and a bare
      // "Unexpected token" from deep inside a tool call is unfixable noise.
      throw new Error(`Could not read skill sources from ${p}: ${String(err?.message || err)}`);
    }
    for (const s of parsed?.sources || []) {
      if (!s?.owner || !s?.repo) continue;
      const key = `${s.owner}/${s.repo}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push(s);
    }
  }
  return sources;
}

const server = new McpServer({ name: 'mcp-skill-lib', version: '0.1.0' });

server.registerTool(
  'search_remote_skills',
  {
    description:
      'Find Agent Skills (SKILL.md folders) in a GitHub repo by folder-path substring, without downloading the repo. Returns name+description only for the matched page. Use this before pull_skill.',
    inputSchema: {
      owner: z.string().describe('GitHub repo owner/org'),
      repo: z.string().describe('GitHub repo name'),
      ref: z.string().optional().describe('Branch, tag, or commit SHA (defaults to the repo default branch)'),
      query: z.string().optional().describe('Case-insensitive substring to match against the skill folder path (cheap, no content fetch). Omit to list all.'),
      limit: z.number().int().min(1).max(100).default(25).describe('Max results to return in this page'),
      cursor: z.string().optional().describe('Opaque cursor from a previous call\'s nextCursor, to get the next page'),
    },
    outputSchema: {
      items: z.array(z.object({ path: z.string(), name: z.string().nullable(), description: z.string().nullable() })),
      totalMatched: z.number(),
      nextCursor: z.string().nullable(),
      truncated: z.boolean().describe('true if GitHub truncated the repo tree response (repo too large for one call)'),
    },
  },
  async ({ owner, repo, ref, query, limit, cursor }) => {
    const { tree, truncated, ref: resolvedRef } = await loadTree(owner, repo, ref);
    let dirs = skillDirsFromTree(tree);
    if (query) {
      const q = query.toLowerCase();
      dirs = dirs.filter((d) => d.dir.toLowerCase().includes(q));
    }
    const offset = cursor ? Number.parseInt(cursor, 10) || 0 : 0;
    const page = dirs.slice(offset, offset + limit);
    const items = [];
    for (const d of page) {
      const content = await getBlobText(owner, repo, d.sha);
      const fm = parseFrontmatter(content) || {};
      items.push({ path: d.dir, name: fm.name || null, description: fm.description || null });
    }
    const nextOffset = offset + limit;
    const nextCursor = nextOffset < dirs.length ? String(nextOffset) : null;
    const structuredContent = { items, totalMatched: dirs.length, nextCursor, truncated };
    // List names in the text block too, not just structuredContent — some MCP
    // clients only surface the text content to the model, so a bare count
    // ("Found 20... returning 20.") with no names is useless to them.
    const listing = items
      .map((it) => `- ${it.name || it.path} (${it.path})${it.description ? `: ${it.description}` : ''}`)
      .join('\n');
    const summary = `Found ${dirs.length} matching skill(s) in ${owner}/${repo}@${resolvedRef}; returning ${items.length}${nextCursor ? ' (more available)' : ''}.`;
    return {
      content: [
        {
          type: 'text',
          text: items.length ? `${summary}\n\n${listing}` : summary,
        },
      ],
      structuredContent,
    };
  },
);

server.registerTool(
  'search_all_sources',
  {
    description:
      'Search for skills across every repo listed in sources.json (shared with the team, edit via a PR to this package) plus sources.local.json (optional, personal repos, lives in SKILL_LIBRARY_PATH and is never committed) — one call instead of calling search_remote_skills once per repo. Use this when you don\'t know which specific repo a skill lives in; use search_remote_skills instead when you already know the exact repo.',
    inputSchema: {
      query: z.string().optional().describe('Case-insensitive substring to match against the skill folder path (cheap, no content fetch). Omit to list every skill from every source.'),
      limit: z.number().int().min(1).max(200).default(50).describe('Max results to return in total, across all sources combined'),
    },
    outputSchema: {
      items: z.array(z.object({
        path: z.string(),
        name: z.string().nullable(),
        description: z.string().nullable(),
        source: z.object({ owner: z.string(), repo: z.string() }),
      })),
      sourcesSearched: z.array(z.object({
        owner: z.string(),
        repo: z.string(),
        status: z.enum(['ok', 'error']),
        matched: z.number().optional(),
        error: z.string().optional(),
      })),
      totalMatched: z.number(),
    },
  },
  async ({ query, limit }) => {
    const sources = loadSources();
    if (sources.length === 0) {
      return {
        content: [{ type: 'text', text: 'No sources configured — add at least one to sources.json (shared) or sources.local.json (personal, under SKILL_LIBRARY_PATH).' }],
        isError: true,
        structuredContent: { items: [], totalMatched: 0 },
      };
    }

    const matches = [];
    const sourcesSearched = [];
    // Pass 1 — tree only. Matching is a path-substring test, so the whole
    // match set is known without fetching a single SKILL.md. Sequential, not
    // parallel: loadTree/getBlobText share one GitHub CLI process at a time in
    // practice, and this keeps per-source error reporting unambiguous.
    for (const src of sources) {
      try {
        const { tree } = await loadTree(src.owner, src.repo, src.ref);
        let dirs = skillDirsFromTree(tree);
        if (query) {
          const q = query.toLowerCase();
          dirs = dirs.filter((d) => d.dir.toLowerCase().includes(q));
        }
        for (const d of dirs) matches.push({ src, dir: d });
        sourcesSearched.push({ owner: src.owner, repo: src.repo, status: 'ok', matched: dirs.length });
      } catch (err) {
        sourcesSearched.push({ owner: src.owner, repo: src.repo, status: 'error', error: String(err?.message || err) });
      }
    }

    const totalMatched = matches.length;
    // Pass 2 — one blob fetch per RETURNED row, not per match. An empty query
    // across a few sizeable repos is hundreds of matches; fetching them all
    // just to throw away everything past `limit` is the difference between a
    // couple of seconds and several minutes.
    const items = [];
    for (const { src, dir } of matches.slice(0, limit)) {
      let fm = {};
      try {
        fm = parseFrontmatter(await getBlobText(src.owner, src.repo, dir.sha)) || {};
      } catch {
        // The folder is a real match either way — report it with null
        // name/description rather than dropping it or failing the whole call.
      }
      items.push({
        path: dir.dir,
        name: fm.name || null,
        description: fm.description || null,
        source: { owner: src.owner, repo: src.repo },
      });
    }
    const listing = items
      .map((it) => `- ${it.name || it.path} (${it.source.owner}/${it.source.repo}: ${it.path})${it.description ? `: ${it.description}` : ''}`)
      .join('\n');
    const failedSources = sourcesSearched.filter((s) => s.status === 'error');
    const failedNote = failedSources.length
      ? `\n\nSkipped ${failedSources.length} source(s) that errored: ${failedSources.map((s) => `${s.owner}/${s.repo} (${s.error})`).join('; ')}`
      : '';
    const summary = `Found ${totalMatched} matching skill(s) across ${sources.length} source(s); returning ${items.length}.`;
    return {
      content: [{ type: 'text', text: (items.length ? `${summary}\n\n${listing}` : summary) + failedNote }],
      structuredContent: { items, sourcesSearched, totalMatched },
    };
  },
);

server.registerTool(
  'find_skills',
  {
    description:
      'Search the open Agent Skill ecosystem for skills matching a free-text query, via the skills.sh registry (public endpoint, no token or API key — same as every other tool here). Use this when search_all_sources found nothing: that one only covers the fixed repo list in sources.json/sources.local.json, while this reaches the whole indexed ecosystem. The registry matches SEMANTICALLY for a multi-word query, so "prevent an agent over-engineering" also finds skills that call the same idea "scope creep" — phrase the query as a sentence describing the job, not as keywords. Each result carries an INSTALL COUNT, the only quality signal available before reading the skill itself; treat it as popularity, not review. Results are UNVETTED — still run validate_skill and benchmark_skill before using or pushing any of them. Each hit is resolved against its GitHub repo to recover the real folder path and description so the result can be handed straight to pull_skill; if GitHub is unreachable those two fields come back null and the rest is still usable.',
    inputSchema: {
      query: z
        .string()
        .min(2)
        .describe('Describe what the skill should DO, as a phrase rather than keywords, e.g. "keep a coding agent from adding features nobody asked for". Multi-word queries are matched semantically; a single word falls back to fuzzy name matching.'),
      limit: z.number().int().min(1).max(50).default(20).describe('Max results to return'),
      resolveDetails: z
        .boolean()
        .optional()
        .default(true)
        .describe('Look each hit up on GitHub to fill in its real folder path and description. Costs ordinary REST quota (~5000/hour, cached). Set false for a faster, registry-only answer when you just want names and install counts.'),
    },
    outputSchema: {
      items: z.array(
        z.object({
          owner: z.string(),
          repo: z.string(),
          path: z.string().nullable().describe('Folder inside the repo holding SKILL.md, ready for pull_skill. Null when details were not resolved or the skill could not be located in the repo.'),
          name: z.string(),
          description: z.string().nullable(),
          installs: z.number().describe('Install count from the registry — popularity, not a quality review.'),
          htmlUrl: z.string().nullable(),
        }),
      ),
      searchType: z.string().describe('How the registry read the query: "semantic" (multi-word) or "fuzzy" (single word).'),
      totalMatched: z.number(),
      unresolved: z.array(z.string()).describe('Registry hits whose folder could not be located on GitHub, as "owner/repo/skillId".'),
    },
  },
  async ({ query, limit, resolveDetails }) => {
    let searchType = 'unknown';
    let hits = [];
    try {
      const r = await searchRegistry(query, { limit });
      searchType = r.searchType;
      hits = r.items;
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text:
              `Skill registry search failed: ${String(err?.message || err)}\n\n` +
              `search_all_sources still works — it reads the curated repo list directly from GitHub and does not depend on skills.sh.`,
          },
        ],
        isError: true,
        // outputSchema declares these as required; without them a
        // schema-validating client rejects the response and the user never
        // sees the message above.
        structuredContent: { items: [], searchType, totalMatched: 0, unresolved: [] },
      };
    }

    if (!hits.length) {
      return {
        content: [{ type: 'text', text: `No skills found for "${query}". Try describing the job in a full phrase — the registry matches multi-word queries semantically, so a sentence usually beats keywords.` }],
        structuredContent: { items: [], searchType, totalMatched: 0, unresolved: [] },
      };
    }

    // The registry returns owner/repo/skillId but not where the skill actually
    // lives in the repo ("skills/x", ".claude/skills/x", the root...), and no
    // description. Both are needed before a result can be handed to
    // pull_skill, so resolve them from the repo tree — one cached tree per
    // DISTINCT repo, not one call per hit.
    const unresolved = [];
    let items = hits.map((h) => ({
      owner: h.owner,
      repo: h.repo,
      path: null,
      name: h.name,
      description: null,
      installs: h.installs,
      htmlUrl: null,
    }));

    if (resolveDetails) {
      const repos = [...new Set(hits.map((h) => `${h.owner}/${h.repo}`))];
      const trees = new Map();
      await mapWithConcurrency(repos, 5, async (full) => {
        const [owner, repo] = full.split('/');
        try {
          const { tree, ref } = await loadTree(owner, repo, undefined);
          trees.set(full, { tree, ref });
        } catch {
          // Private, renamed, deleted, or rate-limited — the registry row is
          // still a real result, so keep it with nulls rather than dropping it.
        }
      });

      items = await mapWithConcurrency(hits, 8, async (h, i) => {
        const base = items[i];
        const entry = trees.get(`${h.owner}/${h.repo}`);
        if (!entry) {
          unresolved.push(`${h.owner}/${h.repo}/${h.skillId}`);
          return base;
        }
        // Match the manifest whose own folder is named after the skill.
        const manifest = entry.tree.find(
          (e) => isSkillManifestPath(e.path) && e.path.split('/').slice(-2, -1)[0] === h.skillId,
        );
        if (!manifest) {
          unresolved.push(`${h.owner}/${h.repo}/${h.skillId}`);
          return base;
        }
        const dir = manifest.path.slice(0, -'/SKILL.md'.length);
        let description = null;
        try {
          description = parseFrontmatter(await getBlobText(h.owner, h.repo, manifest.sha))?.description ?? null;
        } catch {
          // Keep the path we did resolve — it is the field pull_skill needs.
        }
        return {
          ...base,
          path: dir,
          description,
          htmlUrl: `https://github.com/${h.owner}/${h.repo}/blob/${entry.ref}/${manifest.path}`,
        };
      });
    }

    const listing = items
      .map((it) => {
        const where = it.path === null ? `${it.owner}/${it.repo}` : `${it.owner}/${it.repo}: ${it.path}`;
        return `- ${it.name} [${it.installs} installs] (${where})${it.description ? `: ${it.description}` : ''}`;
      })
      .join('\n');

    const typeNote =
      searchType === 'semantic'
        ? 'Matched semantically, so results may use different wording than your query.'
        : searchType === 'fuzzy'
          ? 'Matched fuzzily on names only (single-word query) — phrase it as a sentence for semantic matching.'
          : `Registry reported searchType "${searchType}".`;
    const unresolvedNote = unresolved.length
      ? ` ${unresolved.length} could not be located on GitHub (repo private, renamed, or the skill folder is named differently) — those have no path and cannot be pulled directly.`
      : '';
    const summary =
      `Found ${items.length} skill(s) in the skills.sh registry. ${typeNote}${unresolvedNote}` +
      ` Install counts are popularity, NOT a quality review — these are UNVETTED, so run validate_skill + benchmark_skill before using or pushing any of them.`;

    return {
      content: [{ type: 'text', text: `${summary}\n\n${listing}` }],
      structuredContent: { items, searchType, totalMatched: items.length, unresolved },
    };
  },
);

server.registerTool(
  'pull_skill',
  {
    description:
      'Fetch specific skill folders (as returned by search_remote_skills) from a GitHub repo — only those folders, not the whole repo — and copy them into the local canonical skill library (SKILL-LIB/).',
    inputSchema: {
      owner: z.string(),
      repo: z.string(),
      ref: z.string().optional(),
      skillPaths: z.array(z.string()).describe('Repo-relative folder paths to pull, e.g. ["team/some-skill"]'),
    },
    outputSchema: {
      pulled: z.array(
        z.object({
          path: z.string(),
          name: z.string(),
          localPath: z.string(),
          status: z.enum(['pulled', 'error']),
          warnings: z.array(z.string()),
        }),
      ),
    },
  },
  async ({ owner, repo, ref, skillPaths }) => {
    const { tree } = await loadTree(owner, repo, ref);
    const pulled = [];
    for (const skillPath of skillPaths) {
      const prefix = `${skillPath}/`;
      const files = tree.filter((e) => e.type === 'blob' && e.path.startsWith(prefix));
      const folderName = path.basename(skillPath);
      if (!files.some((f) => f.path === `${skillPath}/SKILL.md`)) {
        pulled.push({ path: skillPath, name: folderName, localPath: '', status: 'error', warnings: ['No SKILL.md found under this path in the repo tree'] });
        continue;
      }
      // Same guard as deploy/remove: the folder this writes into must be one
      // name directly under the library, never a path the repo (or a crafted
      // skillPath like "a/..") can steer somewhere else.
      const destRoot = resolveSkillDir(folderName);
      if (!destRoot) {
        pulled.push({ path: skillPath, name: folderName, localPath: '', status: 'error', warnings: [BAD_SKILL_NAME_MSG] });
        continue;
      }
      let escaped = null;
      for (const f of files) {
        const rel = f.path.slice(prefix.length);
        const destFile = path.resolve(destRoot, rel);
        // Repo-controlled path, so treat it like an archive entry: anything
        // that resolves outside destRoot is a zip-slip and aborts the skill.
        if (destFile !== path.join(destRoot, rel) || !destFile.startsWith(destRoot + path.sep)) {
          escaped = f.path;
          break;
        }
        fs.mkdirSync(path.dirname(destFile), { recursive: true });
        // Bytes, not text: a skill folder can hold images/PDFs/fonts, and a
        // utf8 round-trip rewrites every non-UTF8 byte to U+FFFD.
        fs.writeFileSync(destFile, await getBlobBytes(owner, repo, f.sha));
      }
      if (escaped) {
        pulled.push({
          path: skillPath,
          name: folderName,
          localPath: '',
          status: 'error',
          warnings: [`Repo entry "${escaped}" resolves outside the skill folder — refusing to write it (path traversal).`],
        });
        continue;
      }
      const skillMd = fs.readFileSync(path.join(destRoot, 'SKILL.md'), 'utf8');
      const fm = parseFrontmatter(skillMd) || {};
      const warnings = [];
      if (!fm.name) warnings.push('SKILL.md frontmatter is missing "name"');
      else if (fm.name !== folderName) warnings.push(`frontmatter name "${fm.name}" does not match folder name "${folderName}"`);
      if (!fm.description) warnings.push('SKILL.md frontmatter is missing "description"');
      const extraKeys = Object.keys(fm).filter((k) => k !== 'name' && k !== 'description');
      if (extraKeys.length) warnings.push(`frontmatter has agent-specific keys that won't port cleanly: ${extraKeys.join(', ')}`);
      pulled.push({ path: skillPath, name: fm.name || folderName, localPath: destRoot, status: 'pulled', warnings });
    }
    // Same reasoning as search_remote_skills: list names/warnings in the text
    // block, not just structuredContent, so clients that only surface text
    // still show what actually happened per skill.
    const detail = pulled
      .map((p) => {
        const warn = p.warnings.length ? ` [warnings: ${p.warnings.join('; ')}]` : '';
        return `- ${p.name} (${p.path}): ${p.status}${warn}`;
      })
      .join('\n');
    const summary = `Pulled ${pulled.filter((p) => p.status === 'pulled').length}/${skillPaths.length} skill(s) into ${LIBRARY_ROOT}.`;
    return {
      content: [{ type: 'text', text: pulled.length ? `${summary}\n\n${detail}` : summary }],
      structuredContent: { pulled },
    };
  },
);

server.registerTool(
  'detect_agents',
  {
    description:
      'Detect which agent CLIs (Claude Code, Codex, OpenCode, Cursor, Gemini CLI, GitHub Copilot) are installed on THIS machine, at global and project scope, by checking their known skill directories.',
    inputSchema: {
      cwd: z.string().optional().describe('Project directory to check for project-scoped skill folders (defaults to this server process cwd)'),
    },
    outputSchema: {
      agents: z.array(z.object({ agent: z.string(), scope: z.string(), skillsDir: z.string(), agentPresent: z.boolean() })),
    },
  },
  async ({ cwd }) => {
    const agents = detectAgents(cwd || process.cwd());
    // Same reasoning as search_remote_skills/pull_skill: list which agents
    // were actually found in the text block, not just a bare count — a
    // client that only surfaces text otherwise can't tell WHICH ones.
    const listing = agents
      .map((a) => `- ${a.agent} (${a.scope}): ${a.agentPresent ? 'present' : 'not found'} — ${a.skillsDir}`)
      .join('\n');
    const summary = `Detected ${agents.filter((a) => a.agentPresent).length}/${agents.length} agent locations present.`;
    return {
      content: [{ type: 'text', text: `${summary}\n\n${listing}` }],
      structuredContent: { agents },
    };
  },
);

server.registerTool(
  'deploy_skill',
  {
    description:
      'Symlink (junction on Windows) a skill already pulled into SKILL-LIB/ into every detected agent skill directory on this machine (Claude Code, Codex, OpenCode, Cursor, Gemini CLI, GitHub Copilot), so any agent here can use it. Falls back to copying if symlinking is unavailable in this environment. Never overwrites an existing non-symlink folder. IMPORTANT for the calling agent: before invoking this tool, ask the user which scope(s) to install into — "global" (available to every project on this machine) vs "project" (only this project, and shared with collaborators if committed) — the same way Claude Code\'s own plugin installer asks "Install for you (user scope)" vs "Install for all collaborators on this repository (project scope)". Do not default to deploying to every detected location without asking first, unless the user has already told you which scope(s) they want.',
    inputSchema: {
      skillName: z.string().describe('Folder name under SKILL-LIB/, as returned by pull_skill'),
      cwd: z.string().optional(),
      targets: z.array(z.enum(['claude-code', 'codex', 'opencode', 'cursor', 'gemini', 'copilot'])).optional().describe('Restrict to these agents only (default: all detected)'),
      scopes: z.array(z.enum(['global', 'project'])).optional().describe('Restrict to these scope(s) only (default: both). Ask the user which scope(s) they want before calling this tool — see the tool description.'),
    },
    outputSchema: {
      results: z.array(z.object({ agent: z.string(), scope: z.string(), skillsDir: z.string(), status: z.string(), path: z.string().optional(), note: z.string().optional(), error: z.string().optional() })),
    },
  },
  async ({ skillName, cwd, targets, scopes }) => {
    const sourceDir = resolveSkillDir(skillName);
    if (!sourceDir) {
      return { content: [{ type: 'text', text: BAD_SKILL_NAME_MSG }], isError: true, structuredContent: { results: [] } };
    }
    if (!fs.existsSync(path.join(sourceDir, 'SKILL.md'))) {
      return {
        content: [{ type: 'text', text: `No SKILL.md found at ${sourceDir}. Run pull_skill first.` }],
        isError: true,
        structuredContent: { results: [] },
      };
    }
    let agents = detectAgents(cwd || process.cwd());
    if (targets?.length) agents = agents.filter((a) => targets.includes(a.agent));
    if (scopes?.length) agents = agents.filter((a) => scopes.includes(a.scope));
    const results = deploySkill(sourceDir, agents);
    // Same reasoning as the other tools: list per-agent status/notes in the
    // text block, not just a count — a "deployed-copy" fallback especially
    // needs to be visible to whoever/whatever is reading the response.
    const listing = results
      .map((r) => {
        const extra = r.note ? ` [${r.note}]` : r.error ? ` [error: ${r.error}]` : '';
        return `- ${r.agent} (${r.scope}): ${r.status}${extra}`;
      })
      .join('\n');
    const deployedCount = results.filter((r) => r.status === 'deployed' || r.status === 'deployed-copy').length;
    const summary = `Deployed "${skillName}" to ${deployedCount} agent location(s).`;
    return {
      content: [{ type: 'text', text: results.length ? `${summary}\n\n${listing}` : summary }],
      structuredContent: { results },
    };
  },
);

server.registerTool(
  'remove_skill',
  {
    description:
      'Undo deploy_skill, and optionally delete the skill from SKILL-LIB/ too — the two-step manual cleanup (remove the symlink from every agent\'s skill folder, then delete the source folder) that this project previously had no tool for. Only ever removes a symlink that actually resolves back to this skill\'s SKILL-LIB folder — a same-named real folder, or a symlink pointing somewhere else, is left untouched and reported as skipped rather than deleted. IMPORTANT for the calling agent: this permanently deletes local files with no undo (SKILL_LIBRARY_PATH is not git-tracked) — confirm with the user which skill and whether to also delete it from SKILL-LIB/ (keepInLibrary) before calling this, the same way deploy_skill requires confirming scope first.',
    inputSchema: {
      skillName: z.string().describe('Folder name under SKILL-LIB/, as returned by pull_skill or already present locally'),
      cwd: z.string().optional(),
      targets: z.array(z.enum(['claude-code', 'codex', 'opencode', 'cursor', 'gemini', 'copilot'])).optional().describe('Restrict to these agents only (default: all detected)'),
      scopes: z.array(z.enum(['global', 'project'])).optional().describe('Restrict to these scope(s) only (default: both)'),
      keepInLibrary: z.boolean().optional().default(false).describe('Set true to only remove the deployed symlinks and leave the SKILL-LIB/ source folder in place. Default false also deletes the source folder — confirm this with the user first.'),
    },
    outputSchema: {
      undeployed: z.array(z.object({ agent: z.string(), scope: z.string(), skillsDir: z.string(), status: z.string(), path: z.string().optional(), note: z.string().optional(), error: z.string().optional() })),
      libraryRemoved: z.boolean(),
      libraryPath: z.string(),
      librarySkipReason: z.string().optional().describe('Why the source folder was kept even though keepInLibrary was false (it is still deployed somewhere).'),
    },
  },
  async ({ skillName, cwd, targets, scopes, keepInLibrary }) => {
    const sourceDir = resolveSkillDir(skillName);
    const emptyRemoval = { undeployed: [], libraryRemoved: false, libraryPath: sourceDir || '' };
    if (!sourceDir) {
      return { content: [{ type: 'text', text: BAD_SKILL_NAME_MSG }], isError: true, structuredContent: emptyRemoval };
    }
    if (!fs.existsSync(sourceDir)) {
      return {
        content: [{ type: 'text', text: `No skill folder found at ${sourceDir} — nothing to remove.` }],
        isError: true,
        structuredContent: emptyRemoval,
      };
    }
    const allAgents = detectAgents(cwd || process.cwd());
    let agents = allAgents;
    if (targets?.length) agents = agents.filter((a) => targets.includes(a.agent));
    if (scopes?.length) agents = agents.filter((a) => scopes.includes(a.scope));
    const undeployed = removeSkill(sourceDir, agents);

    // Deleting the library folder while anything still points at it recreates
    // the dangling-symlink mess this tool exists to clean up — so check every
    // detected agent, including ones this call was not asked to undeploy.
    const remaining = findRemainingDeployments(sourceDir, allAgents);
    let libraryRemoved = false;
    let librarySkipReason;
    if (!keepInLibrary) {
      if (remaining.length) {
        librarySkipReason =
          `still deployed at ${remaining.length} location(s) — ` +
          `${remaining.map((r) => `${r.agent}/${r.scope} (${r.kind})`).join(', ')}. ` +
          'Undeploy those first (drop the targets/scopes filter), or remove them by hand if they are not symlinks.';
      } else {
        fs.rmSync(sourceDir, { recursive: true, force: true });
        libraryRemoved = true;
      }
    }

    const listing = undeployed
      .map((r) => {
        const extra = r.note ? ` [${r.note}]` : r.error ? ` [error: ${r.error}]` : '';
        return `- ${r.agent} (${r.scope}): ${r.status}${extra}`;
      })
      .join('\n');
    const removedCount = undeployed.filter((r) => r.status === 'removed').length;
    const libraryLine = libraryRemoved
      ? `Deleted the source folder at ${sourceDir}.`
      : keepInLibrary
        ? `Left the source folder at ${sourceDir} in place (keepInLibrary was set).`
        : `Kept the source folder at ${sourceDir}: ${librarySkipReason}`;
    const summary = `Removed "${skillName}" from ${removedCount} agent location(s). ${libraryLine}`;
    return {
      content: [{ type: 'text', text: undeployed.length ? `${summary}\n\n${listing}` : summary }],
      structuredContent: { undeployed, libraryRemoved, libraryPath: sourceDir, ...(librarySkipReason ? { librarySkipReason } : {}) },
    };
  },
);

const MIN_BENCHMARK_SCORE = 70;

// Shared by benchmark_skill's optional `results` input and push_skill's
// required `benchmark` input — the same shape either way, so a report
// generated by benchmark_skill and the gate check in push_skill are
// always looking at the same fields.
const BENCHMARK_RESULT_SHAPE = {
  layer0Passed: z.boolean(),
  trigger: z.object({
    positivePrompt: z.string(),
    positiveRawOutput: z.string().describe('The actual raw text the positive-prompt session produced/returned — not a paraphrase, so a reader can verify it themselves'),
    positiveFired: z.boolean(),
    negativePrompt: z.string(),
    negativeRawOutput: z.string().describe('The actual raw text the negative-prompt session produced/returned'),
    negativeFired: z.boolean(),
    sessionEvidence: z.string(),
  }),
  outcome: z.object({
    withSkillRawOutput: z.string().describe('The actual raw output of the with-skill session, not a summary'),
    withoutSkillRawOutput: z.string().describe('The actual raw output of the without-skill session, not a summary'),
    skillHelped: z.boolean(),
  }),
  stability: z.object({
    runs: z.number().min(3),
    runOutputs: z.array(z.string()).min(3).describe('The actual raw output of each of the runs, in order — not a summary'),
    consistent: z.boolean(),
    notes: z.string(),
  }),
  edgeCase: z.object({
    score: z.number().min(0).max(20),
    notes: z.string(),
    adversarialConcern: z.boolean().optional().describe('true if the skill\'s own instructions could plausibly steer a naive agent into exfiltrating or destroying data outside its declared scope'),
  }),
  scope: z.object({ score: z.number().min(0).max(20), notes: z.string() }),
  dynamicCheck: z
    .object({
      ran: z.boolean(),
      attemptedActions: z.array(z.string()),
      notes: z.string(),
    })
    .optional()
    .describe(
      'OPTIONAL, advisory only — a real fresh session run in a throwaway scratch directory, instructed to report (not execute) any destructive/network action the skill calls for. Not part of the pass/fail gate: this project has no OS-level sandbox, so neither a clean result nor the session honoring the stop-instruction is a hard guarantee.',
    ),
  score: z.number().min(0).max(100),
  summary: z.string(),
  weakLayers: z.array(z.string()).optional(),
};

server.registerTool(
  'benchmark_skill',
  {
    description:
      `Judge a local skill folder's quality against this project's 6-layer rubric (Layer 0 Static, 1 Trigger, 2 Outcome, 3 Stability, 4 Edge case & guardrail, 5 Scope — see skill-evaluation-kit.html). Call it TWICE: (1) with just \`skillPath\` — computes Layer 0 mechanically and returns a TEST PLAN, since this tool cannot run the skill or spawn sessions itself; Layers 1-3 (Trigger/Outcome/Stability) require YOU to actually spawn fresh, no-prior-context sessions (your own Agent/Task tooling) and observe real behavior — a self-rated guess is not accepted. (2) once you have real results for all 6 layers, call it again with \`skillPath\` AND \`results\` (same shape as push_skill's \`benchmark\` argument) — this writes a permanent, inspectable HTML report to \`<skillPath>.benchmark-report.html\` (a sibling of the skill folder, never inside it, so it's never pushed as skill content) and returns its path plus an overall pass/fail verdict. Pass that same \`results\` object on to push_skill's \`benchmark\` argument next — push_skill refuses to publish (status "benchmark-too-low") if Layer 0 fails, any Layer 1-3 evidence field shows a failed test, or the total score is below ${MIN_BENCHMARK_SCORE}/100. No network calls from this tool.`,
    inputSchema: {
      skillPath: z.string().describe('Absolute local folder path to the skill to benchmark'),
      results: z
        .object(BENCHMARK_RESULT_SHAPE)
        .optional()
        .describe('Omit on the first call (returns Layer 0 + a test plan for Layers 1-5). Pass on a second call, once you have real results for all 6 layers, to generate the HTML report file.'),
    },
    outputSchema: {
      skillPath: z.string(),
      layer0Passed: z.boolean(),
      layer0Issues: z.array(z.string()),
      moduleCount: z.number(),
      descriptionLength: z.number(),
      testPlan: z.string().optional(),
      reportPath: z.string().optional(),
      overallPassed: z.boolean().optional(),
    },
  },
  async ({ skillPath, results }) => {
    if (!fs.existsSync(skillPath) || !fs.statSync(skillPath).isDirectory()) {
      return { content: [{ type: 'text', text: `Not a directory: ${skillPath}` }], isError: true };
    }
    const staticSignals = computeStaticSignals(skillPath);
    const layer0Summary = staticSignals.passed
      ? 'Layer 0 (Static): passed.'
      : `Layer 0 (Static): FAILED —\n${staticSignals.issues.map((i) => `- ${i}`).join('\n')}`;

    if (results) {
      const skillName = path.basename(skillPath);
      const html = buildReportHtml(skillName, staticSignals, results);
      const reportPath = writeReport(skillPath, html);
      const overallPassed =
        staticSignals.passed &&
        results.trigger.positiveFired &&
        !results.trigger.negativeFired &&
        results.outcome.skillHelped &&
        results.stability.runs >= 3 &&
        results.stability.consistent &&
        results.score >= MIN_BENCHMARK_SCORE;
      return {
        content: [
          {
            type: 'text',
            text: `${layer0Summary}\n\nReport written to ${reportPath}\nOverall: ${overallPassed ? 'PASS — ready to push' : 'FAIL — fix the weak layer(s) and re-benchmark'} (score ${results.score}/100)`,
          },
        ],
        structuredContent: {
          skillPath,
          layer0Passed: staticSignals.passed,
          layer0Issues: staticSignals.issues,
          moduleCount: staticSignals.moduleCount,
          descriptionLength: staticSignals.descriptionLength,
          reportPath,
          overallPassed,
        },
      };
    }

    const testPlan = buildTestPlan(skillPath, staticSignals);
    return {
      content: [{ type: 'text', text: `${layer0Summary}\n\n${testPlan}` }],
      structuredContent: {
        skillPath,
        layer0Passed: staticSignals.passed,
        layer0Issues: staticSignals.issues,
        moduleCount: staticSignals.moduleCount,
        descriptionLength: staticSignals.descriptionLength,
        testPlan,
      },
    };
  },
);

server.registerTool(
  'validate_skill',
  {
    description:
      'Check a local skill folder against the same 4 rules SKILL-LIB\'s CI lint enforces (frontmatter parses, only name/description keys allowed, name format/length/folder-match, non-empty description). No network calls — safe to call repeatedly. This is a fast local approximation, not a substitute for the real CI lint job: the frontmatter reader used here is not a full YAML parser.',
    inputSchema: {
      skillPath: z
        .string()
        .describe('Absolute local folder path to the skill to validate (does not need to be inside SKILL_LIBRARY_PATH — can be any skill folder on disk, e.g. ~/.claude/skills/my-new-skill)'),
    },
    outputSchema: {
      skillPath: z.string(),
      name: z.string().nullable(),
      valid: z.boolean(),
      issues: z.array(z.string()),
    },
  },
  async ({ skillPath }) => {
    if (!fs.existsSync(skillPath) || !fs.statSync(skillPath).isDirectory()) {
      return { content: [{ type: 'text', text: `Not a directory: ${skillPath}` }], isError: true };
    }
    const { valid, issues, name } = validateSkillFolder(skillPath);
    const listing = issues.length ? issues.map((i) => `- ${i}`).join('\n') : 'No issues found.';
    const summary = `Skill "${name || path.basename(skillPath)}" at ${skillPath}: ${valid ? 'VALID' : `INVALID (${issues.length} issue(s))`}.`;
    return {
      content: [{ type: 'text', text: `${summary}\n\n${listing}` }],
      structuredContent: { skillPath, name, valid, issues },
    };
  },
);

server.registerTool(
  'push_skill',
  {
    description:
      'Validate (fail-closed — refuses if invalid, no GitHub calls made) then publish a local skill folder to the shared GitHub library through the standard outside-contributor flow: FORK the upstream repo under your own account, commit the skill to a branch IN YOUR FORK as ONE atomic commit (Git Data API: blob per file -> tree -> commit -> ref update), and open a PULL REQUEST from that fork branch back to upstream. The upstream repo is treated as READ-ONLY throughout — this tool never creates a branch, commit or ref there, so it works even though you are not a collaborator on it. Writes a per-skill .meta.json (uploadedBy/uploadedAt/updatedBy/updatedAt) in the same commit. The fork branch is auto-named "skill/<skillName>" (one branch per skill, so several skills can have independent PRs open at once); on a repeat push of the same skill the existing open PR is REUSED — a new commit is added to it rather than opening a duplicate PR. A human reviewer merges the PR; this tool never merges. IMPORTANT: ask the user for their name/email/GitHub username (the `identity` field) BEFORE calling this tool — do not guess or reuse a value from earlier context. The tool independently checks that identity against the account `gh` is logged in as, and refuses on a mismatch unless confirmMismatch is explicitly set. Needs the GitHub CLI (`gh`) installed and logged in (`gh auth login`) on this machine — read access to upstream is enough, no collaborator rights required.',
    inputSchema: {
      skillPath: z.string().describe('Absolute local folder path to the skill to push (must pass the same checks as validate_skill; this tool refuses to push otherwise)'),
      owner: z.string().describe('Owner of the UPSTREAM library repo (read-only — never written to). Your fork is found/created automatically under the account `gh` is logged in as.'),
      repo: z.string().describe('Name of the UPSTREAM library repo. Your fork keeps the same name.'),
      branch: z
        .string()
        .optional()
        .describe('Branch name to use INSIDE YOUR FORK (default: auto-generated "skill/<skillName>"). Created from the upstream default branch\'s current head if it doesn\'t exist yet. Never touches any branch in the upstream repo.'),
      identity: z
        .string()
        .describe(
          'The name, email, or GitHub username of the person actually uploading/updating this skill. Ask the user for this before calling — never guess it.',
        ),
      confirmMismatch: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Set true only if the user has explicitly confirmed they intend to push under an identity that does not match the account `gh` is logged in as (e.g. pushing on behalf of a teammate). Leave false/omitted otherwise.',
        ),
      commitMessage: z.string().optional().describe('Override the default commit message ("feat(library): Add/Update <skillName> skill")'),
      benchmark: z
        .object(BENCHMARK_RESULT_SHAPE)
        .describe(
          `Result of calling benchmark_skill on this same skillPath first and executing its test plan for real — Layers 1-3 (trigger/outcome/stability) require actually spawning fresh sessions and reporting what happened, not a guessed score. Required — this tool refuses to push (status "benchmark-too-low") if layer0Passed is false, trigger.positiveFired is false, trigger.negativeFired is true, outcome.skillHelped is false, stability.runs is under 3, stability.consistent is false, or the total score is below ${MIN_BENCHMARK_SCORE}. There is no override flag; fix the skill and re-benchmark instead.`,
        ),
    },
    outputSchema: {
      status: z.enum(['pushed', 'validation-failed', 'benchmark-too-low', 'secrets-detected', 'dangerous-instructions-detected', 'identity-mismatch', 'conflict', 'fork-name-conflict']),
      skillName: z.string().nullable(),
      isUpdate: z.boolean().optional(),
      commitSha: z.string().optional(),
      commitUrl: z.string().optional(),
      forkFullName: z.string().optional().describe('The fork the commit actually landed in, e.g. "yourname/SKILL-LIB"'),
      forkBranch: z.string().optional().describe('Branch inside the fork that now holds the skill'),
      forkCreated: z.boolean().optional().describe('True when this call had to create the fork (first ever push)'),
      pullRequestUrl: z.string().optional(),
      pullRequestNumber: z.number().optional(),
      pullRequestAction: z.enum(['created', 'updated']).optional().describe('"updated" means a commit was added to a PR that was already open for this skill'),
      filesPushed: z.array(z.string()),
      meta: z
        .object({
          uploadedBy: z.string(),
          uploadedAt: z.string(),
          updatedBy: z.string(),
          updatedAt: z.string(),
          verifiedAgainstGhAccount: z.boolean(),
        })
        .optional(),
      issues: z.array(z.string()),
      warnings: z.array(z.string()),
    },
  },
  async ({ skillPath, owner, repo, branch, identity, confirmMismatch, commitMessage, benchmark }) => {
    const warnings = [];

    // 1. Validate first — fail closed, zero GitHub calls if invalid.
    const v = validateSkillFolder(skillPath);
    if (!v.valid) {
      const listing = v.issues.map((i) => `- ${i}`).join('\n');
      return {
        content: [{ type: 'text', text: `Refusing to push — validation failed:\n\n${listing}` }],
        isError: true,
        structuredContent: {
          status: 'validation-failed',
          skillName: v.name,
          filesPushed: [],
          issues: v.issues,
          warnings: [],
        },
      };
    }
    const skillName = v.name;

    // 1a. Benchmark gate — also before any GitHub call. Fails closed on
    // Layer 0, on any Layer 1-3 evidence field showing a failed real test
    // (not just a low total score), or on the score threshold. No override
    // flag: a low-quality or unverified skill gets fixed and re-benchmarked,
    // not force-pushed anyway.
    const benchmarkFailed =
      !benchmark.layer0Passed ||
      !benchmark.trigger.positiveFired ||
      benchmark.trigger.negativeFired ||
      !benchmark.outcome.skillHelped ||
      benchmark.stability.runs < 3 ||
      !benchmark.stability.consistent ||
      benchmark.score < MIN_BENCHMARK_SCORE;
    if (benchmarkFailed) {
      const reasons = [];
      if (!benchmark.layer0Passed) reasons.push('Layer 0 (Static) did not pass');
      if (!benchmark.trigger.positiveFired) reasons.push('Layer 1 (Trigger): the positive test prompt did not actually fire the skill');
      if (benchmark.trigger.negativeFired) reasons.push('Layer 1 (Trigger): the negative test prompt fired the skill when it should not have');
      if (!benchmark.outcome.skillHelped) reasons.push('Layer 2 (Outcome): the with-skill session did not outperform the without-skill session');
      if (benchmark.stability.runs < 3) reasons.push('Layer 3 (Stability): fewer than 3 runs were tested');
      if (!benchmark.stability.consistent) reasons.push('Layer 3 (Stability): the 3 runs were not consistent');
      if (benchmark.score < MIN_BENCHMARK_SCORE) reasons.push(`score ${benchmark.score}/100 is below the ${MIN_BENCHMARK_SCORE}/100 minimum`);
      return {
        content: [
          {
            type: 'text',
            text:
              `Refusing to push — benchmark too low: ${reasons.join('; ')}.\n\n` +
              `Summary from benchmark_skill: ${benchmark.summary}\n` +
              (benchmark.weakLayers?.length ? `Weak layers: ${benchmark.weakLayers.join(', ')}\n` : '') +
              'Improve the skill and call benchmark_skill again before retrying push_skill.',
          },
        ],
        isError: true,
        structuredContent: {
          status: 'benchmark-too-low',
          skillName: v.name,
          filesPushed: [],
          issues: reasons,
          warnings: [],
        },
      };
    }

    // 1b. Credential sweep — also before any GitHub call. push_skill uploads
    // every file under the folder, so a stray .env or private key would be
    // published to a shared repo where it can't be un-seen. Fail closed and
    // name the files: there is no "push it anyway" flag on purpose.
    const files = walkSkillFiles(skillPath);
    const secrets = findSecretFiles(files);
    if (secrets.length) {
      const listing = secrets.map((s) => `- ${s}`).join('\n');
      return {
        content: [
          {
            type: 'text',
            text:
              `Refusing to push — the skill folder contains ${secrets.length} file(s) that look like credentials:\n\n${listing}\n\n` +
              'Remove them from the skill folder (or rename to .example/.sample if they are templates) and push again. ' +
              'Anything pushed to a shared repo should be assumed permanently visible to everyone with access.',
          },
        ],
        isError: true,
        structuredContent: {
          status: 'secrets-detected',
          skillName,
          filesPushed: [],
          issues: secrets.map((s) => `looks like a credential file: ${s}`),
          warnings: [],
        },
      };
    }

    // 1c. Dangerous-instruction sweep — also before any GitHub call, same
    // fail-closed posture and no override flag as the credential sweep
    // above. Grounded in SkillSafetyBench (paper/2605.12015.pdf): a skill's
    // own Markdown body can be adversarial content even when the person
    // pushing it has no ill intent — this catches high-confidence
    // theft/destruction signatures; Layer 4's read-and-judge (advisory
    // only) catches subtler, indirect ones this narrow regex scan misses.
    const skillMdContent = fs.readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8');
    const dangerousFindings = findDangerousInstructions(skillMdContent);
    if (dangerousFindings.length) {
      const listing = dangerousFindings.map((f) => `- ${f}`).join('\n');
      return {
        content: [
          {
            type: 'text',
            text:
              `Refusing to push — SKILL.md contains instruction pattern(s) consistent with data theft or destruction:\n\n${listing}\n\n` +
              'If this is a legitimate destructive/network operation, scope it explicitly (a named relative path, not an unscoped target like ~ or /) ' +
              'and make the intent and blast radius explicit in the skill text, then push again. There is no override flag.',
          },
        ],
        isError: true,
        structuredContent: {
          status: 'dangerous-instructions-detected',
          skillName,
          filesPushed: [],
          issues: dangerousFindings,
          warnings: [],
        },
      };
    }

    await ensureGhReady();
    const defaultBranch = await getDefaultBranch(owner, repo);
    const resolvedBranch = branch || `skill/${skillName}`;

    // 2. Identity cross-check — before any write call.
    const user = await getAuthenticatedUser();
    const candidates = [user.login, user.name, user.email].filter(Boolean).map((s) => s.toLowerCase());
    const claim = identity.toLowerCase();
    const matched = candidates.some((c) => c === claim || c.includes(claim) || claim.includes(c));
    if (!matched && !confirmMismatch) {
      return {
        content: [
          {
            type: 'text',
            text:
              `Refusing to push — identity mismatch. You said "${identity}" but "gh" is logged in as ` +
              `login="${user.login}" name="${user.name}" email="${user.email}". Fix the identity value, ` +
              `or pass confirmMismatch:true if you're intentionally pushing on someone else's behalf.`,
          },
        ],
        isError: true,
        structuredContent: {
          status: 'identity-mismatch',
          skillName,
          filesPushed: [],
          issues: [],
          warnings: [],
        },
      };
    }
    const verifiedAgainstGhAccount = matched;

    // 3. Resolve the fork. Upstream is read-only from here on — every write
    // below targets forkOwner/repo, never owner/repo.
    const forkOwner = user.login;
    let forkCreated = false;
    const existingFork = await getFork(forkOwner, owner, repo);
    if (existingFork?.mismatch) {
      return {
        content: [
          {
            type: 'text',
            text:
              `Refusing to push — "${existingFork.mismatch}" already exists on your account but is NOT a fork of ` +
              `${owner}/${repo} (it's an unrelated repo that happens to share the name). Pushing into it would ` +
              `commit this skill into the wrong project. Rename or delete that repo, then run this push again.`,
          },
        ],
        isError: true,
        structuredContent: { status: 'fork-name-conflict', skillName, filesPushed: [], issues: [], warnings: [] },
      };
    }
    if (!existingFork) {
      await createFork(owner, repo);
      forkCreated = true;
      warnings.push(`You had no fork of ${owner}/${repo} — created ${forkOwner}/${repo} for this push.`);
    }
    const forkFullName = `${forkOwner}/${repo}`;

    // 4. Resolve the branch INSIDE THE FORK. A branch that already exists is
    // built on top of (that's what adds a commit to the PR already open for
    // this skill); a new one starts from upstream's current default-branch
    // head, so the PR diff stays limited to this skill even if the fork's own
    // default branch has gone stale.
    let baseSha = await tryGetBranchHead(forkOwner, repo, resolvedBranch);
    if (baseSha === null) {
      baseSha = await getBranchHead(owner, repo, defaultBranch);
      await createBranch(forkOwner, repo, resolvedBranch, baseSha);
      warnings.push(
        `Branch "${resolvedBranch}" did not exist in ${forkFullName} — created it from ${owner}/${repo}@${defaultBranch}'s current head.`,
      );
    }
    const { sha: baseTreeSha, tree, truncated } = await getRecursiveTree(forkOwner, repo, baseSha);
    if (truncated) warnings.push('GitHub truncated the repo tree response (repo too large for one call) — existing-skill detection may be incomplete');

    const existingEntries = tree.filter((e) => e.path === skillName || e.path.startsWith(`${skillName}/`));
    const isUpdate = existingEntries.length > 0;

    // 4. Resolve prior metadata (preserve uploadedBy/uploadedAt on update).
    const nowIso = new Date().toISOString();
    let uploadedBy = identity;
    let uploadedAt = nowIso;
    if (isUpdate) {
      const metaEntry = existingEntries.find((e) => e.path === `${skillName}/.meta.json`);
      if (metaEntry) {
        try {
          const existingMetaText = await getBlobText(forkOwner, repo, metaEntry.sha);
          const existingMeta = JSON.parse(existingMetaText);
          if (existingMeta.uploadedBy) uploadedBy = existingMeta.uploadedBy;
          if (existingMeta.uploadedAt) uploadedAt = existingMeta.uploadedAt;
        } catch (e) {
          warnings.push(`existing .meta.json was malformed (${e.message}); backfilling upload metadata with this push's identity/time`);
        }
      } else {
        warnings.push('no prior .meta.json found for this existing skill; upload metadata backfilled with this push\'s identity/time');
      }
    }
    const meta = { uploadedBy, uploadedAt, updatedBy: identity, updatedAt: nowIso, verifiedAgainstGhAccount };

    // 6. Blob every real file (listed in step 1b), plus the synthesized
    // .meta.json — all into the fork.
    const entries = [];
    for (const f of files) {
      const buf = fs.readFileSync(f.absolutePath);
      const sha = await createBlob(forkOwner, repo, buf.toString('base64'));
      entries.push({ path: `${skillName}/${f.relativePath}`, mode: '100644', type: 'blob', sha });
    }
    const metaSha = await createBlob(forkOwner, repo, Buffer.from(JSON.stringify(meta, null, 2)).toString('base64'));
    entries.push({ path: `${skillName}/.meta.json`, mode: '100644', type: 'blob', sha: metaSha });

    // 7. Tree -> commit -> (re-check) -> ref update, still all in the fork.
    const newTreeSha = await createTree(forkOwner, repo, baseTreeSha, entries);
    const message = commitMessage || `feat(library): ${isUpdate ? 'Update' : 'Add'} ${skillName} skill`;
    const newCommitSha = await createCommit(forkOwner, repo, message, newTreeSha, baseSha);

    const currentSha = await getBranchHead(forkOwner, repo, resolvedBranch);
    if (currentSha !== baseSha) {
      return {
        content: [
          {
            type: 'text',
            text:
              `Refusing to update the ref — ${forkFullName}@${resolvedBranch} moved from ${baseSha} to ${currentSha} ` +
              `while this push was in progress (something else pushed to your fork in the meantime). Nothing on ${resolvedBranch} was ` +
              `changed — the commit/blobs this push created are unreferenced and harmless. Retry the whole call.`,
          },
        ],
        isError: true,
        structuredContent: {
          status: 'conflict',
          skillName,
          isUpdate,
          filesPushed: [],
          issues: [],
          warnings,
        },
      };
    }

    try {
      await updateRef(forkOwner, repo, resolvedBranch, newCommitSha);
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Refusing — ref update was rejected (${String(err?.message || err)}). Nothing on ${resolvedBranch} was changed. Retry the whole call.`,
          },
        ],
        isError: true,
        structuredContent: { status: 'conflict', skillName, isUpdate, filesPushed: [], issues: [], warnings },
      };
    }

    // 8. Open the PR back to upstream — or, if one is already open for this
    // exact fork branch, leave it alone: the commit above has already landed
    // on the branch the PR tracks, so GitHub shows it in that same PR. This is
    // what keeps a re-pushed skill to one PR instead of a pile of duplicates.
    //
    // The commit is already safely on the fork at this point, so a failure
    // here is reported as a warning rather than an error — losing the PR link
    // is recoverable (open it by hand), losing the commit is not.
    let pull = null;
    let pullRequestAction;
    try {
      pull = await findOpenPull(owner, repo, forkOwner, resolvedBranch);
      if (pull) {
        pullRequestAction = 'updated';
      } else {
        pull = await createPull(owner, repo, {
          title: message,
          head: `${forkOwner}:${resolvedBranch}`,
          base: defaultBranch,
          body:
            `${isUpdate ? 'Updates' : 'Adds'} the \`${skillName}\` skill.\n\n` +
            `- Benchmark score: ${benchmark.score}/100 (threshold ${MIN_BENCHMARK_SCORE})\n` +
            `- Submitted by: ${identity}${verifiedAgainstGhAccount ? '' : ' (identity NOT verified against the pushing GitHub account)'}\n` +
            `- Files: ${entries.length}\n\n` +
            `Opened automatically by \`push_skill\`. Please review before merging.`,
        });
        pullRequestAction = 'created';
      }
    } catch (err) {
      warnings.push(
        `Commit landed on ${forkFullName}@${resolvedBranch}, but the pull request step failed ` +
          `(${String(err?.message || err)}). Open it by hand: ` +
          `gh pr create --repo ${owner}/${repo} --base ${defaultBranch} --head ${forkOwner}:${resolvedBranch}`,
      );
    }

    const filesPushed = entries.map((e) => e.path);
    const listing = filesPushed.map((p) => `- ${p}`).join('\n');
    const summary =
      `Pushed "${skillName}" to your fork ${forkFullName}@${resolvedBranch} as commit ${newCommitSha} ` +
      `(${isUpdate ? 'updated' : 'added'}). ${owner}/${repo} itself was never written to.`;
    const prText = pull
      ? `\n\nPull request ${pullRequestAction === 'created' ? 'opened' : 'updated (commit added to the PR already open for this skill)'}: ` +
        `#${pull.number} ${pull.url}`
      : '';
    const warnText = warnings.length ? `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join('\n')}` : '';
    const nextSteps = pull
      ? `\n\nNext step: a maintainer of ${owner}/${repo} reviews and merges PR #${pull.number}. Do not merge it yourself.`
      : '';
    return {
      content: [{ type: 'text', text: `${summary}\n\n${listing}${prText}${warnText}${nextSteps}` }],
      structuredContent: {
        status: 'pushed',
        skillName,
        isUpdate,
        commitSha: newCommitSha,
        commitUrl: `https://github.com/${forkFullName}/commit/${newCommitSha}`,
        forkFullName,
        forkBranch: resolvedBranch,
        forkCreated,
        ...(pull ? { pullRequestUrl: pull.url, pullRequestNumber: pull.number, pullRequestAction } : {}),
        filesPushed,
        meta,
        issues: [],
        warnings,
      },
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
