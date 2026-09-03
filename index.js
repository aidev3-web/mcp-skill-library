#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDefaultBranch, getRecursiveTree, getBlobText } from './lib/github.js';
import { parseFrontmatter } from './lib/frontmatter.js';
import { detectAgents, deploySkill } from './lib/agents.js';

// Independent of where this tool's own code lives — set SKILL_LIBRARY_PATH to
// point at wherever pulled skills should be stored locally.
const LIBRARY_ROOT = process.env.SKILL_LIBRARY_PATH
  ? path.resolve(process.env.SKILL_LIBRARY_PATH)
  : path.join(os.homedir(), '.skill-library');

function requireToken() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN environment variable is not set on this machine.');
  }
  return token;
}

// Short-lived in-memory cache so paginated search_remote_skills calls (and a
// follow-up pull_skill) don't re-fetch the whole repo tree every time.
const treeCache = new Map(); // key -> { at, tree, truncated }
const TREE_TTL_MS = 5 * 60 * 1000;

async function loadTree(owner, repo, ref) {
  const token = requireToken();
  const resolvedRef = ref || (await getDefaultBranch(owner, repo, token));
  const key = `${owner}/${repo}@${resolvedRef}`;
  const cached = treeCache.get(key);
  if (cached && Date.now() - cached.at < TREE_TTL_MS) return { ...cached, ref: resolvedRef };
  const { tree, truncated } = await getRecursiveTree(owner, repo, resolvedRef, token);
  const entry = { at: Date.now(), tree, truncated };
  treeCache.set(key, entry);
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

const server = new McpServer({ name: 'skill-bridge', version: '0.1.0' });

server.registerTool(
  'skillbridge_search_remote_skills',
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
    const token = requireToken();
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
      const content = await getBlobText(owner, repo, d.sha, token);
      const fm = parseFrontmatter(content) || {};
      items.push({ path: d.dir, name: fm.name || null, description: fm.description || null });
    }
    const nextOffset = offset + limit;
    const nextCursor = nextOffset < dirs.length ? String(nextOffset) : null;
    const structuredContent = { items, totalMatched: dirs.length, nextCursor, truncated };
    return {
      content: [
        {
          type: 'text',
          text: `Found ${dirs.length} matching skill(s) in ${owner}/${repo}@${resolvedRef}; returning ${items.length}${nextCursor ? ' (more available)' : ''}.`,
        },
      ],
      structuredContent,
    };
  },
);

server.registerTool(
  'skillbridge_pull_skill',
  {
    description:
      'Fetch specific skill folders (as returned by skillbridge_search_remote_skills) from a GitHub repo — only those folders, not the whole repo — and copy them into the local canonical skill library (SKILL-LIB/).',
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
    const token = requireToken();
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
      const destRoot = path.join(LIBRARY_ROOT, folderName);
      for (const f of files) {
        const rel = f.path.slice(prefix.length);
        const destFile = path.join(destRoot, rel);
        fs.mkdirSync(path.dirname(destFile), { recursive: true });
        const text = await getBlobText(owner, repo, f.sha, token);
        fs.writeFileSync(destFile, text);
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
    return {
      content: [{ type: 'text', text: `Pulled ${pulled.filter((p) => p.status === 'pulled').length}/${skillPaths.length} skill(s) into ${LIBRARY_ROOT}.` }],
      structuredContent: { pulled },
    };
  },
);

server.registerTool(
  'skillbridge_detect_agents',
  {
    description:
      'Detect which agent CLIs (Claude Code, Codex, OpenCode) are installed on THIS machine, at global and project scope, by checking their known skill directories.',
    inputSchema: {
      cwd: z.string().optional().describe('Project directory to check for project-scoped skill folders (defaults to this server process cwd)'),
    },
    outputSchema: {
      agents: z.array(z.object({ agent: z.string(), scope: z.string(), skillsDir: z.string(), agentPresent: z.boolean() })),
    },
  },
  async ({ cwd }) => {
    const agents = detectAgents(cwd || process.cwd());
    return {
      content: [{ type: 'text', text: `Detected ${agents.filter((a) => a.agentPresent).length}/${agents.length} agent locations present.` }],
      structuredContent: { agents },
    };
  },
);

server.registerTool(
  'skillbridge_deploy_skill',
  {
    description:
      'Symlink (junction on Windows) a skill already pulled into SKILL-LIB/ into every detected agent skill directory on this machine, so any agent here can use it. Never overwrites an existing non-symlink folder.',
    inputSchema: {
      skillName: z.string().describe('Folder name under SKILL-LIB/, as returned by skillbridge_pull_skill'),
      cwd: z.string().optional(),
      targets: z.array(z.enum(['claude-code', 'codex', 'opencode'])).optional().describe('Restrict to these agents only (default: all detected)'),
    },
    outputSchema: {
      results: z.array(z.object({ agent: z.string(), scope: z.string(), skillsDir: z.string(), status: z.string(), path: z.string().optional(), error: z.string().optional() })),
    },
  },
  async ({ skillName, cwd, targets }) => {
    const sourceDir = path.join(LIBRARY_ROOT, skillName);
    if (!fs.existsSync(path.join(sourceDir, 'SKILL.md'))) {
      return {
        content: [{ type: 'text', text: `No SKILL.md found at ${sourceDir}. Run skillbridge_pull_skill first.` }],
        isError: true,
      };
    }
    let agents = detectAgents(cwd || process.cwd());
    if (targets?.length) agents = agents.filter((a) => targets.includes(a.agent));
    const results = deploySkill(sourceDir, agents);
    return {
      content: [{ type: 'text', text: `Deployed "${skillName}" to ${results.filter((r) => r.status === 'deployed').length} agent location(s).` }],
      structuredContent: { results },
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
