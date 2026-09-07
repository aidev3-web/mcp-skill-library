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

## Let an agent install itself (copy-paste init prompt)

Don't want to type any of the commands above by hand? Paste the block below
as-is into a chat with any MCP-capable agent (Claude Code, Claude Desktop,
OpenCode, Codex CLI...) running on the target machine. It detects which
agent it is, registers `skill-bridge` the right way for that agent, and
verifies the install — without you touching a config file.

```text
Install and register the "skill-bridge" MCP server
(@aidev3-web/mcp-skill-library) for yourself on this machine. Do this:

1. Check `node --version` is 18 or higher. If Node.js is missing or too
   old, tell me how to install/upgrade it and stop.

2. Check whether "skill-bridge" is already registered for you, at any
   scope (e.g. `claude mcp list` / `claude mcp get skill-bridge` for
   Claude Code, or the equivalent config file for your agent type). If
   it already exists:
   - Show me exactly what it's currently pointing at (command, scope,
     env var names) instead of silently adding a second one.
   - Do NOT register a duplicate under the same name at a different
     scope — that creates an ambiguous, conflicting setup. Ask me
     whether to leave the existing one alone, fix it in place, or
     remove it before you add a new one.
   - Only continue to the steps below if there is truly nothing
     registered yet, or I've told you to replace what's there.

3. Check whether the GITHUB_TOKEN environment variable is already set
   in this shell/session — the exact name `GITHUB_TOKEN`, not a
   similarly-named variable for a different agent (e.g.
   `GITHUB_TOKEN_OPENCODE`). A differently-named variable does not
   count, even if it looks like it serves the same purpose — its
   scope/permissions may not match what this server needs. If
   `GITHUB_TOKEN` itself is NOT set:
   - Ask me for a GitHub token with "Contents: Read" access on the
     repo(s) I want to browse skills from (fine-grained PAT scoped to
     that repo, not a broad classic token).
   - Never print, log, or write the raw token value into any file
     except the one config entry that needs it (see step 5). Treat it
     like a password.

4. Identify which agent you are:
   - Claude Code CLI → use `claude mcp add`.
   - Claude Desktop → edit claude_desktop_config.json.
   - OpenCode → edit opencode.json.
   - Codex CLI → edit ~/.codex/config.toml.

5. Register the server for yourself using the exact command/config
   snippet for your agent type, from this repo's README.md
   ("Register with your agent" section). Use the GitHub Packages
   install path (`npx --yes @aidev3-web/mcp-skill-library`) unless I
   say I don't have `~/.npmrc` set up for @aidev3-web, in which case
   use `npx --yes github:aidev3-web/mcp-skill-library` instead. Pass
   the GITHUB_TOKEN via the agent's own env mechanism (its config
   file's "env" field, or an actual exported environment variable) —
   never hardcode the token as a literal string in a committed file.
   Note: a `"${GITHUB_TOKEN}"`-style placeholder in a JSON/TOML config
   file is NOT auto-expanded by every agent — some require the real
   env var to actually be exported in the environment the agent runs
   in, not just declared as a placeholder string. If the tool still
   reports the variable missing after this step, fix that before
   moving on, don't treat the config edit alone as done.

6. If SKILL_LIBRARY_PATH should be anything other than the default
   (~/.skill-library), ask me for the path and add it alongside
   GITHUB_TOKEN in the same env block.

7. Tell me to restart you (or reload MCP servers) so the new config
   is picked up.

8. Once restarted, call the `skillbridge_detect_agents` tool once and
   report back which agent locations were found on this machine, to
   confirm the server is actually running.
```

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
