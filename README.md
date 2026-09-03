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

- **Node.js 18+** (uses built-in `fetch`) — the only hard requirement.
- A `GITHUB_TOKEN` environment variable with:
  - **Contents: Read** on whatever repo(s) you want to browse/pull skills from
  - **read:packages** if installing via GitHub Packages (recommended method below)
- **Git** — only needed for the alternative `npx github:...` install method; not
  needed for the GitHub Packages method.

## Install / run

**Recommended — GitHub Packages (no `git` needed on the target machine):**

One-time per machine, add this repo's private registry to npm config
(`~/.npmrc`; the `${GITHUB_TOKEN}` stays a literal placeholder, resolved from
the environment at read-time, so this file never contains a real secret):
```bash
echo '@aidev3-web:registry=https://npm.pkg.github.com' >> ~/.npmrc
echo '//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}' >> ~/.npmrc
```
```powershell
# PowerShell equivalent — single quotes keep ${GITHUB_TOKEN} literal
Add-Content $HOME\.npmrc '@aidev3-web:registry=https://npm.pkg.github.com'
Add-Content $HOME\.npmrc '//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}'
```

Then run:
```bash
npx --yes @aidev3-web/mcp-skill-library
```

**Alternative — straight from the git repo** (needs `git` on the machine, no
`~/.npmrc` setup, but never fully offline — see note below):
```bash
npx --yes github:aidev3-web/mcp-skill-library
```

Either way: the very first run installs (a few seconds); later runs reuse
npm's cache and are fast, but still do a lightweight check against the
registry/GitHub for updates each time — this is not fully offline. For a
fully offline, fixed install, run `npm install -g @aidev3-web/mcp-skill-library`
(or the `github:` form) once and point your agent's config at the installed
`index.js` directly instead of using `npx`.

## Register with your agent

Replace `npx --yes @aidev3-web/mcp-skill-library` below with
`npx --yes github:aidev3-web/mcp-skill-library` if using the git-based
install instead.

**Claude Code**
```bash
claude mcp add --scope user skill-bridge -- npx --yes @aidev3-web/mcp-skill-library
```

**Claude Desktop** — edit `claude_desktop_config.json`
(`%APPDATA%\Claude\claude_desktop_config.json` on Windows,
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):
```json
{
  "mcpServers": {
    "skill-bridge": {
      "command": "npx",
      "args": ["--yes", "@aidev3-web/mcp-skill-library"],
      "env": { "GITHUB_TOKEN": "<your token>" }
    }
  }
}
```

**OpenCode** — add to `opencode.json`:
```json
"skill-bridge": {
  "type": "local",
  "command": ["npx", "--yes", "@aidev3-web/mcp-skill-library"],
  "environment": { "GITHUB_TOKEN": "{env:GITHUB_TOKEN}" }
}
```

**Codex CLI** — add to `~/.codex/config.toml`:
```toml
[mcp_servers.skill-bridge]
command = "npx"
args = ["--yes", "@aidev3-web/mcp-skill-library"]
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
