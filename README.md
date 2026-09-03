# mcp-skill-library

MCP server (`skill-bridge`) that lets any MCP-capable agent — Claude Code, Claude
Desktop, OpenCode, Codex CLI, or any other client that speaks MCP — browse and
pull [Agent Skills](https://agentskills.io/home) (`SKILL.md` folders) from a
GitHub repo, and deploy them into whichever agent's local skills folder exists
on the machine. It talks to GitHub over the REST API (no local `git` needed for
this part), and only ever touches the local filesystem for the deploy step.

If an agent is reading this file because it was asked to "install this MCP
server", the exact steps are below — no guessing required.

## Prerequisites on the machine that will run this server

- **Node.js 18+** (uses built-in `fetch`)
- **Git** (only needed if installing via the `npx github:...` method below)
- A `GITHUB_TOKEN` environment variable — a GitHub token with **Contents: Read**
  access to whatever repo(s) you want to browse/pull skills from. This is
  separate from any credential used to `git clone` this repo itself.

## Install / run

No npm publish required — run straight from this (private) GitHub repo:

```bash
npx --yes github:aidev3-web/mcp-skill-library
```

The first run clones + installs (slower); later runs reuse npm's cache and are
fast, but every run still does a lightweight check against GitHub for updates
— it is not fully offline. For a fully offline, fixed install instead run
`npm install -g github:aidev3-web/mcp-skill-library` once and point your
agent's config at the installed `index.js` directly.

## Register with your agent

**Claude Code**
```bash
claude mcp add --scope user skill-bridge -- npx --yes github:aidev3-web/mcp-skill-library
```

**Claude Desktop** — edit `claude_desktop_config.json`
(`%APPDATA%\Claude\claude_desktop_config.json` on Windows,
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):
```json
{
  "mcpServers": {
    "skill-bridge": {
      "command": "npx",
      "args": ["--yes", "github:aidev3-web/mcp-skill-library"],
      "env": { "GITHUB_TOKEN": "<your token>" }
    }
  }
}
```

**OpenCode** — add to `opencode.json`:
```json
"skill-bridge": {
  "type": "local",
  "command": ["npx", "--yes", "github:aidev3-web/mcp-skill-library"],
  "environment": { "GITHUB_TOKEN": "{env:GITHUB_TOKEN}" }
}
```

**Codex CLI** — add to `~/.codex/config.toml`:
```toml
[mcp_servers.skill-bridge]
command = "npx"
args = ["--yes", "github:aidev3-web/mcp-skill-library"]
```

Restart the agent after editing its config — MCP config is only read on startup.

## Tools this server exposes

| Tool | Does |
|---|---|
| `skillbridge_search_remote_skills` | Find `SKILL.md` folders in a GitHub repo by path substring — no full clone, paginated |
| `skillbridge_pull_skill` | Fetch specific skill folders and copy them into the local skill library |
| `skillbridge_detect_agents` | Detect which agents (Claude Code, Codex, OpenCode) have a skills folder on this machine |
| `skillbridge_deploy_skill` | Symlink a pulled skill into every detected agent's skills folder |

## Configuration

- `GITHUB_TOKEN` (required) — token used for every GitHub API call the tools make.
- `SKILL_LIBRARY_PATH` (optional) — where `pull_skill`/`deploy_skill` read and
  write skill content locally. Defaults to `~/.skill-library`.
