# mcp-skill-library

MCP server (`skill-bridge`) that lets any MCP-capable agent — Claude Code, Claude
Desktop, OpenCode, Codex CLI, or any other client that speaks MCP — browse and
pull [Agent Skills](https://agentskills.io/home) (`SKILL.md` folders) from a
GitHub repo, deploy them into whichever agent's local skills folder exists on
the machine, and push a locally-created skill back up to a GitHub repo. It
talks to GitHub over the REST API (no local `git` needed for that part), and
only ever touches the local filesystem for the deploy/validate/push steps.

If an agent is reading this file because it was asked to "install this MCP
server", the exact steps are below — no guessing required.

## Prerequisites on the machine that will run this server

- **Node.js 18+** (uses built-in `fetch`) — the only hard requirement.
- **Git** — to clone this repo once for the recommended local-run install below.
- A `GITHUB_TOKEN` environment variable with:
  - **Contents: Read** on whatever repo(s) you want to browse/pull skills from.
  - **Contents: Read AND Write** on any repo you'll use `skillbridge_push_skill`
    against — Read alone (sufficient for every other tool) is not enough for
    that one, since it creates commits.
  - (**read:packages** is only needed for the `npx` alternative further down —
    the recommended install below never touches GitHub Packages, so a plain
    fine-grained PAT is enough for install itself.)
  - Note: branch protection rules are a *repo setting*, not a token scope —
    even a Read+Write token can't push directly to a branch that requires PRs;
    `skillbridge_push_skill` can't bypass that, it'll just fail with GitHub's
    own rejection message.

## Install / run

**Recommended — run local (no network needed at server startup):**

`npx` has to re-check/re-fetch the package from a registry every time an
agent launches it — that's an extra network round-trip and an extra auth
scope (`read:packages`) on the critical path of just starting a local
process. Cloning once and running the checked-out `index.js` directly
removes both:

```bash
git clone https://github.com/aidev3-web/mcp-skill-library.git
cd mcp-skill-library
npm install
```

Then point your agent's config at the **absolute path** of `index.js` in
that folder, using `node` as the command (exact snippets per agent below).
To update later, `git pull` inside that folder — no re-registration needed.

**Alternative — `npx`** (fine if the machine has reliable network and you'd
rather not manage a local checkout, but see the trade-off below):

GitHub Packages path (needs `read:packages` on the token; one-time `~/.npmrc`
setup, `${GITHUB_TOKEN}` stays a literal placeholder resolved at read-time):
```bash
echo '@aidev3-web:registry=https://npm.pkg.github.com' >> ~/.npmrc
echo '//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}' >> ~/.npmrc
```
```powershell
Add-Content $HOME\.npmrc '@aidev3-web:registry=https://npm.pkg.github.com'
Add-Content $HOME\.npmrc '//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}'
```
```bash
npx --yes @aidev3-web/mcp-skill-library
```

Or straight from the git repo (no `~/.npmrc` setup, only `Contents: Read`
needed, but re-clones on every launch):
```bash
npx --yes github:aidev3-web/mcp-skill-library
```

**Trade-off, from experience**: both `npx` forms have caused real, hard-to-
diagnose failures in practice — a fine-grained token lacking `read:packages`
gets a bare `403` from the GitHub Packages path, and the git-based path can
time out mid-launch on a flaky connection (re-cloning on every single
startup, not just the first). The recommended local-run install above
doesn't hit either failure mode, because nothing after the one-time clone
touches the network.

## Register with your agent

Every snippet below uses `node` pointed at your local checkout's `index.js`
— replace `/absolute/path/to/mcp-skill-library/index.js` with the real path
on your machine (on Windows, use `\\` between path segments in JSON/TOML).
If you're using the `npx` alternative instead, replace `"command": "node",
"args": ["/absolute/path/to/mcp-skill-library/index.js"]` with `"command":
"npx", "args": ["--yes", "@aidev3-web/mcp-skill-library"]` (or the `github:`
form) in each snippet.

**Claude Code**
```bash
claude mcp add --scope user skill-bridge -- node /absolute/path/to/mcp-skill-library/index.js
```

**Claude Desktop** — edit `claude_desktop_config.json` via the app's
**Settings → Developer → Edit Config** button (safest — it opens the exact
file this install of Claude Desktop actually reads, including on a
Microsoft Store install, which uses a different, sandboxed path than the
`%APPDATA%\Claude\...` location some docs assume):
```json
{
  "mcpServers": {
    "skill-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-skill-library/index.js"],
      "env": { "GITHUB_TOKEN": "<your token>" }
    }
  }
}
```

**OpenCode** — add to `opencode.json`:
```json
"skill-bridge": {
  "type": "local",
  "command": ["node", "/absolute/path/to/mcp-skill-library/index.js"],
  "environment": { "GITHUB_TOKEN": "{env:GITHUB_TOKEN}" }
}
```

**Codex CLI** — add to `~/.codex/config.toml`:
```toml
[mcp_servers.skill-bridge]
command = "node"
args = ["/absolute/path/to/mcp-skill-library/index.js"]
```

**Antigravity IDE** (Google's agentic IDE — not Gemini CLI; its `~/.gemini`
folder is its own config home, unrelated to actual Gemini CLI) — edit via the
UI: click **...** at the top of the Agent panel → **MCP Servers** → **Manage
MCP Servers** → **View raw config**, or edit the file directly at
`~/.gemini/config/mcp_config.json` (global) or `.agents/mcp_config.json`
(workspace-only):
```json
{
  "mcpServers": {
    "skill-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-skill-library/index.js"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    }
  }
}
```

Restart the agent after editing its config — MCP config is only read on startup.

## Let an agent install itself (copy-paste init prompt)

Don't want to type any of the commands above by hand? Paste the block below
as-is into a chat with any MCP-capable agent (Claude Code, Claude Desktop,
OpenCode, Codex CLI, Antigravity IDE...) running on the target machine. It
detects which agent it is, registers `skill-bridge` the right way for that
agent, and verifies the install — without you touching a config file.

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
   - Antigravity IDE (Google's agentic IDE — NOT Gemini CLI, even though it
     uses a `~/.gemini` folder for its own config) → edit
     `~/.gemini/config/mcp_config.json` (global) or `.agents/mcp_config.json`
     (workspace-only), or use the UI: **...** at the top of the Agent panel →
     **MCP Servers** → **Manage MCP Servers** → **View raw config**.

5. Register the server for yourself using the exact command/config
   snippet for your agent type, from this repo's README.md
   ("Register with your agent" section). Prefer the recommended
   local-run install: `git clone` this repo (or reuse an existing
   checkout if I already have one), `npm install`, then point your
   config at that checkout's `index.js` via `node` — this avoids
   network/registry-auth failures at every future launch. Only fall
   back to the `npx` alternative if I explicitly say I'd rather not
   manage a local checkout; if so, use the GitHub Packages form unless
   I say I don't have `~/.npmrc` set up for @aidev3-web, in which case
   use the `github:` form instead. Pass the GITHUB_TOKEN via the
   agent's own env mechanism (its config file's "env" field, or an
   actual exported environment variable) — never hardcode the token
   as a literal string in a committed file. Note: a
   `"${GITHUB_TOKEN}"`-style placeholder in a JSON/TOML config file is
   NOT auto-expanded by every agent — some require the real env var to
   actually be exported in the environment the agent runs in, not just
   declared as a placeholder string. If the tool still reports the
   variable missing after this step, fix that before moving on, don't
   treat the config edit alone as done.

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
| `skillbridge_detect_agents` | Detect which agents (Claude Code, Codex, OpenCode, Cursor, Gemini CLI, GitHub Copilot) have a skills folder on this machine |
| `skillbridge_deploy_skill` | Symlink a pulled skill into every detected agent's skills folder (falls back to a copy if symlinking isn't available). Takes an optional `scopes` filter (`global`/`project`) — the calling agent should ask the user which scope(s) they want before calling this, the same way Claude Code's own plugin installer asks "user scope" vs "project scope" |
| `skillbridge_validate_skill` | Check a local skill folder against the same 4 rules SKILL-LIB's CI lint enforces (frontmatter parses, only name/description keys, name format/length/folder-match, non-empty description) — no network, safe to call repeatedly |
| `skillbridge_push_skill` | Validate (fail-closed) then push a local skill folder to a GitHub repo as one atomic commit via the Git Data API, with an identity cross-check against the GITHUB_TOKEN account and a per-skill `.meta.json` tracking uploadedBy/uploadedAt/updatedBy/updatedAt |

### Recommended workflow for publishing a locally-created skill

`skillbridge_push_skill` never pushes straight to the repo's default branch
(`main`/`master`) — it always targets a feature branch (auto-named
`skill/<skillName>` if you don't pass one), creating it from the current
default-branch head if it doesn't exist yet. The full recommended flow:

1. **Push** — `skillbridge_push_skill` to the feature branch.
2. **Pull it back down to verify** — `skillbridge_search_remote_skills` /
   `skillbridge_pull_skill` with `ref` set to that same branch, to confirm
   the skill round-tripped correctly (not just trusting the local copy).
3. **Open a PR** — e.g. `gh pr create --base <default branch> --head
   skill/<skillName>` — once step 2 looks right.
4. **A human reviews and merges** — this repo's `CODEOWNERS` already
   requires review before merge; the tool never merges anything itself.

Only pass `allowDirectToDefaultBranch: true` if a human has explicitly asked
for a direct push, bypassing this workflow — it's a deliberate, rarely-needed
escape hatch, not the default path.

## Configuration

- `GITHUB_TOKEN` (required) — token used for every GitHub API call the tools make.
  `skillbridge_push_skill` needs Contents: Read AND Write; every other tool
  only needs Contents: Read.
- `SKILL_LIBRARY_PATH` (optional) — where `pull_skill`/`deploy_skill` read and
  write skill content locally. Defaults to `~/.skill-library`.

### Where the token actually lives

There is exactly **one** place that ever holds the real token value: a
**real `GITHUB_TOKEN` environment variable** on the machine. Every config
file below only stores a placeholder that resolves back to that variable —
never a copy of the secret itself:

| Location | Holds | Placeholder or real value? |
|---|---|---|
| `~/.npmrc` | `${GITHUB_TOKEN}` | Placeholder — npm resolves it from the env var at read time |
| **Real OS/shell env var `GITHUB_TOKEN`** | the actual token | **This is the only place the real secret lives**, for every path except Claude Desktop below |
| `.mcp.json` (project scope, Claude Code) | `"${GITHUB_TOKEN}"` | Placeholder — Claude Code needs the real env var to already be exported when it starts, not merely declared, or you'll see "Missing environment variables" |
| `opencode.json` | `"{env:GITHUB_TOKEN}"` | Placeholder — same requirement |
| `~/.codex/config.toml` | no `env` field at all | Codex inherits `GITHUB_TOKEN` from whatever shell/session launched it — it must already be exported there |
| `mcp_config.json` (Antigravity IDE) | `"${GITHUB_TOKEN}"` | Placeholder — same requirement as Claude Code/`.mcp.json` above |
| `claude_desktop_config.json` | `"env": {"GITHUB_TOKEN": "<the real value>"}` | **The one exception** — the literal value is typed directly into this file, because Claude Desktop is a GUI app that doesn't inherit your shell's environment. Safe because this file lives locally under `%APPDATA%\Claude\` / `~/Library/Application Support/Claude/` — it is never part of this or any other git repo. |

### Handing a token to a new person

1. Create a **fine-grained PAT** (Contents:Read on the target repo — add
   Contents:Write too if they'll use `skillbridge_push_skill`, plus
   read:packages if they'll use the GitHub Packages install path) and send
   it over a secure channel (password manager) — not plain chat. Note:
   `GET /user` (used by `skillbridge_push_skill`'s identity cross-check)
   works with any authenticated token — it needs no extra scope of its own.
2. They set the real `GITHUB_TOKEN` environment variable on their own
   machine:
   - PowerShell, current session only: `$env:GITHUB_TOKEN = "ghp_xxx"`
   - PowerShell, permanent for that user: `[System.Environment]::SetEnvironmentVariable("GITHUB_TOKEN","ghp_xxx","User")`, then open a new terminal
   - Bash/zsh: add `export GITHUB_TOKEN=ghp_xxx` to `~/.bashrc` / `~/.zshrc`
3. On a company-managed machine, skip step 2 entirely and run
   `provision-skill-bridge.ps1 -GitHubToken "ghp_xxx"` once instead — it
   sets the variable at machine level and registers the server with every
   agent it finds, so the end user never has to touch the token or any
   config file themselves.
4. Claude Desktop is the one case that still needs a manual edit even
   after step 2/3: paste the real value into `claude_desktop_config.json`'s
   `env.GITHUB_TOKEN` field yourself (or let `provision-skill-bridge.ps1`
   do it — it already writes that file when Claude Desktop is present).
