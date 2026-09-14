# mcp-skill-library

MCP server (`mcp-skill-lib`) that lets any MCP-capable agent — Claude Code, Claude
Desktop, OpenCode, Codex CLI, or any other client that speaks MCP — browse and
pull [Agent Skills](https://agentskills.io/home) (`SKILL.md` folders) from a
GitHub repo, deploy them into whichever agent's local skills folder exists on
the machine, and push a locally-created skill back up to a GitHub repo. It
talks to GitHub through the **GitHub CLI (`gh`)** — no personal access token
is ever read, stored, or passed around by this server — and only ever touches
the local filesystem for the deploy/validate/push steps.

If an agent is reading this file because it was asked to "install this MCP
server", the exact steps are below — no guessing required.

## Prerequisites on the machine that will run this server

- **Node.js 18+** — the only hard requirement for running `index.js` itself.
- **Git** — to clone this repo once for the recommended local-run install below.
- **The GitHub CLI (`gh`)**, installed and logged in:
  ```bash
  gh auth login
  ```
  Every GitHub call this server makes (`gh api ...` under the hood) runs as
  whichever account `gh` is currently logged in as — there is no separate
  token to create, store, or hand to anyone.
- **Collaborator access on whatever skill repo(s) you want to browse/pull
  from**, if that repo is private — ask a repo admin to add your GitHub
  account. This is enforced by GitHub itself (a non-collaborator's `gh`
  session simply can't read a private repo), not by anything in this code.
  `push_skill` additionally needs **write** access on the target
  repo.
- **If this machine ever ran an older, token-based version of this server:
  unset `GITHUB_TOKEN` (and `GH_TOKEN`) from its environment.** `gh` uses
  either of those env vars *instead of* your `gh auth login` session if
  they're set — confirmed on a real machine that still had a stale
  `GITHUB_TOKEN` lying around, which made every call fail with "Bad
  credentials" even though `gh auth login` was already done. `gh auth
  status` will call this out by name if it's the cause.

## Install / run

**Recommended — run local:**

```bash
git clone https://github.com/aidev3-web/mcp-skill-library.git
cd mcp-skill-library
npm install
```

Then point your agent's config at the **absolute path** of `index.js` in
that folder, using `node` as the command (exact snippets per agent below).
To update later, `git pull` inside that folder — no re-registration needed.

**Alternative — `npx`** (fine if you'd rather not manage a local checkout):
```bash
npx --yes github:aidev3-web/mcp-skill-library
```
This re-clones the repo on every launch, so it's slower to start and more
sensitive to a flaky connection than the recommended local-run install above
— use it only if you're not going to be launching this server often.

## Register with your agent

Every snippet below uses `node` pointed at your local checkout's `index.js`
— replace `/absolute/path/to/mcp-skill-library/index.js` with the real path
on your machine (on Windows, use `\\` between path segments in JSON/TOML).
If you're using the `npx` alternative instead, replace `"command": "node",
"args": ["/absolute/path/to/mcp-skill-library/index.js"]` with `"command":
"npx", "args": ["--yes", "github:aidev3-web/mcp-skill-library"]` in each
snippet. None of these need a `GITHUB_TOKEN` or any other secret in the
config — auth comes entirely from the `gh auth login` session on the machine.

**Claude Code**
```bash
claude mcp add --scope user mcp-skill-lib -- node /absolute/path/to/mcp-skill-library/index.js
```
On Windows, quote the path if it contains spaces (common under a
localized user folder, e.g. `"C:\Users\you\OneDrive\Máy tính\...\index.js"`).

**Claude Desktop** — edit `claude_desktop_config.json` via the app's
**Settings → Developer → Edit Config** button (safest — it opens the exact
file this install of Claude Desktop actually reads, including on a
Microsoft Store install, which uses a different, sandboxed path than the
`%APPDATA%\Claude\...` location some docs assume):
```json
{
  "mcpServers": {
    "mcp-skill-lib": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-skill-library/index.js"]
    }
  }
}
```

**OpenCode** — add to `opencode.json`:
```json
"mcp-skill-lib": {
  "type": "local",
  "command": ["node", "/absolute/path/to/mcp-skill-library/index.js"]
}
```

**Codex CLI** — add to `~/.codex/config.toml`:
```toml
[mcp_servers.mcp-skill-lib]
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
    "mcp-skill-lib": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-skill-library/index.js"]
    }
  }
}
```

Restart the agent after editing its config — MCP config is only read on startup.

## Let an agent install itself (copy-paste init prompt)

Don't want to type any of the commands above by hand? Paste the block below
as-is into a chat with any MCP-capable agent (Claude Code, Claude Desktop,
OpenCode, Codex CLI, Antigravity IDE...) running on the target machine. It
detects which agent it is, registers `mcp-skill-lib` the right way for that
agent, and verifies the install — without you touching a config file.

```text
Install and register the "mcp-skill-lib" MCP server
(@aidev3-web/mcp-skill-library) for yourself on this machine. Do this:

1. Check `node --version` is 18 or higher. If Node.js is missing or too
   old, tell me how to install/upgrade it and stop.

2. Check whether "mcp-skill-lib" is already registered for you, at any
   scope (e.g. `claude mcp list` / `claude mcp get mcp-skill-lib` for
   Claude Code, or the equivalent config file for your agent type). If
   it already exists:
   - Show me exactly what it's currently pointing at (command, scope)
     instead of silently adding a second one.
   - Do NOT register a duplicate under the same name at a different
     scope — that creates an ambiguous, conflicting setup. Ask me
     whether to leave the existing one alone, fix it in place, or
     remove it before you add a new one.
   - Only continue to the steps below if there is truly nothing
     registered yet, or I've told you to replace what's there.

3. Check whether the GitHub CLI is installed and logged in:
   `gh --version` (install from https://cli.github.com/ if missing), then
   `gh auth status` (if not logged in, tell me to run `gh auth login` and
   wait for me to confirm it succeeded before continuing). This server
   reads no token of any kind — it shells out to `gh` for every GitHub
   call, using whichever account `gh` is logged in as.

4. Ask me which GitHub repo(s) I want to browse/pull skills from. If any
   of them are private, remind me I need to already be a collaborator on
   them (ask a repo admin if not) — `gh auth login` alone doesn't grant
   access to a repo you're not added to.

5. Identify which agent you are:
   - Claude Code CLI → use `claude mcp add`.
   - Claude Desktop → edit claude_desktop_config.json.
   - OpenCode → edit opencode.json.
   - Codex CLI → edit ~/.codex/config.toml.
   - Antigravity IDE (Google's agentic IDE — NOT Gemini CLI, even though it
     uses a `~/.gemini` folder for its own config) → edit
     `~/.gemini/config/mcp_config.json` (global) or `.agents/mcp_config.json`
     (workspace-only), or use the UI: **...** at the top of the Agent panel →
     **MCP Servers** → **Manage MCP Servers** → **View raw config**.

6. Register the server for yourself using the exact command/config
   snippet for your agent type, from this repo's README.md
   ("Register with your agent" section). Prefer the recommended
   local-run install: `git clone https://github.com/aidev3-web/mcp-skill-library.git`
   (or reuse an existing checkout if I already have one), `npm install`,
   then point your config at that checkout's `index.js` via `node`.
   Only fall back to the `npx` alternative if I explicitly say I'd
   rather not manage a local checkout. No `env` block or token of any
   kind is needed in either case.

7. If SKILL_LIBRARY_PATH should be anything other than the default
   (~/.skill-library), ask me for the path and add it in an `env`
   block alongside the command.

8. Tell me to restart you (or reload MCP servers) so the new config
   is picked up.

9. Once restarted, call the `detect_agents` tool once and
   report back which agent locations were found on this machine, to
   confirm the server is actually running.
```

## Tools this server exposes

| Tool | Does |
|---|---|
| `search_remote_skills` | Find `SKILL.md` folders in a GitHub repo by path substring — no full clone, paginated |
| `search_all_sources` | Same search, but across every repo listed in `sources.json` (shared, versioned in this package) plus `sources.local.json` (optional, personal, under `SKILL_LIBRARY_PATH`) — one call instead of calling `search_remote_skills` once per repo |
| `pull_skill` | Fetch specific skill folders and copy them into the local skill library |
| `detect_agents` | Detect which agents (Claude Code, Codex, OpenCode, Cursor, Gemini CLI, GitHub Copilot) have a skills folder on this machine |
| `deploy_skill` | Symlink a pulled skill into every detected agent's skills folder (falls back to a copy if symlinking isn't available). Takes an optional `scopes` filter (`global`/`project`) — the calling agent should ask the user which scope(s) they want before calling this, the same way Claude Code's own plugin installer asks "user scope" vs "project scope" |
| `remove_skill` | Undo `deploy_skill` — remove the symlinks from every agent's skill folder, and (unless `keepInLibrary: true`) delete the skill from `SKILL-LIB/` too. Only ever removes a symlink that actually resolves back to this skill; a same-named real folder is left untouched. Permanent, no undo — the calling agent should confirm with the user first |
| `validate_skill` | Check a local skill folder against the same 4 rules SKILL-LIB's CI lint enforces (frontmatter parses, only name/description keys, name format/length/folder-match, non-empty description) — no network, safe to call repeatedly |
| `benchmark_skill` | Judge a local skill against the 6-layer quality rubric (see `skill-evaluation-kit.html`). Call twice: (1) `skillPath` only — computes Layer 0 (Static) mechanically and returns a test plan; Layers 1-3 (Trigger/Outcome/Stability) require the calling agent to actually spawn fresh sessions and observe real behavior, a guessed score isn't accepted. (2) `skillPath` + `results` once all 6 layers are done — writes a permanent HTML report to `<skillPath>.benchmark-report.html` (a sibling of the skill folder, never pushed as skill content) and returns a pass/fail verdict. No network |
| `push_skill` | Validate (fail-closed) then push a local skill folder to a GitHub repo as one atomic commit via the Git Data API, with an identity cross-check against the account `gh` is logged in as, and a per-skill `.meta.json` tracking uploadedBy/uploadedAt/updatedBy/updatedAt. Requires a `benchmark` argument (the result of calling `benchmark_skill` first) and refuses to push below a 70/100 threshold |

See [`docs/USAGE.md`](docs/USAGE.md) for a step-by-step walkthrough of each
tool (real input/output examples) and a troubleshooting table.

### What the tools refuse to do

These are enforced in code, not just documented — `test/security.test.js`
covers each one:

| Guard | Why |
|---|---|
| `skillName` must be a single folder name directly under the library — no `/`, `\`, `..` or absolute path (`deploy_skill`, `remove_skill`, `pull_skill`'s destination) | Skill content comes from outside repos and is read by an agent. Without this, a `skillName` of `../../Documents` made `remove_skill` a recursive delete of whatever it landed on |
| A repo entry that resolves outside the destination folder aborts that skill's pull | Classic zip-slip: the repo controls those paths, this machine shouldn't trust them |
| `remove_skill` won't delete the library folder while any detected agent still links to it | Otherwise a scoped removal (`scopes: ["global"]`) leaves the project-scope symlink dangling. Reported as `librarySkipReason` |
| `push_skill` refuses the whole push if the folder holds anything credential-shaped (`.env`, `*.pem`, `id_rsa`, …; `.env.example` is fine) | A shared repo push can't be un-seen. There is deliberately no override flag |
| `push_skill` refuses if `benchmark_skill`'s Layer 0 failed, any Layer 1-3 evidence field shows a failed real test (wrong trigger, no measurable outcome, inconsistent runs), or the combined score is below 70/100 | A skill nobody can trigger correctly, or that doesn't hold up under real scrutiny, gets fixed before it's shared — not force-published. No override flag |
| `owner`/`repo` must match `[A-Za-z0-9._-]{1,100}` before they reach an API path | Every GitHub path is built by interpolation; a `/` or `?` in a name would reshape the request |
| `pull_skill` writes raw bytes, never a UTF-8 round-trip | Verified against a real 78 KB font: the old text path inflated it to 98 KB of U+FFFD. Skills legitimately ship PDFs, images and fonts |

### Recommended workflow for publishing a locally-created skill

`push_skill` never pushes straight to the repo's default branch
(`main`/`master`) — it always targets a feature branch (auto-named
`skill/<skillName>` if you don't pass one), creating it from the current
default-branch head if it doesn't exist yet. The full recommended flow:

1. **Validate & benchmark** — `validate_skill`, then `benchmark_skill` and pass its result as `push_skill`'s `benchmark` argument.
2. **Push** — `push_skill` to the feature branch.
3. **Pull it back down to verify** — `search_remote_skills` /
   `pull_skill` with `ref` set to that same branch, to confirm
   the skill round-tripped correctly (not just trusting the local copy).
4. **Open a PR** — e.g. `gh pr create --base <default branch> --head
   skill/<skillName>` — once step 3 looks right.
5. **A human reviews and merges** — this repo's `CODEOWNERS` already
   requires review before merge; the tool never merges anything itself.

Only pass `allowDirectToDefaultBranch: true` if a human has explicitly asked
for a direct push, bypassing this workflow — it's a deliberate, rarely-needed
escape hatch, not the default path.

## Configuration

- **Auth** — not a config value at all. Every tool that talks to GitHub calls
  `ensureGhReady()` first, which checks `gh` is installed and logged in
  (`gh auth login`) and fails with a clear message if not. There is no
  `GITHUB_TOKEN` (or any other token) anywhere in this codebase.
- `SKILL_LIBRARY_PATH` (optional) — where `pull_skill`/`deploy_skill` read and
  write skill content locally. Defaults to `~/.skill-library`.
- `sources.json` (in this package) — the shared list of repos
  `search_all_sources` searches across. Add a repo by opening a
  PR to this file:
  ```json
  { "sources": [{ "owner": "your-org", "repo": "your-skill-repo", "note": "what this is" }] }
  ```
- `sources.local.json` (optional, in `SKILL_LIBRARY_PATH`, e.g.
  `~/.skill-library/sources.local.json`) — same shape, for private repos you
  want included without touching the shared list. Never committed.

### Getting a new person access

1. They install the GitHub CLI (https://cli.github.com/) and run
   `gh auth login` once — this is a normal personal GitHub login (browser or
   device-code flow), not a token they need to generate or paste anywhere.
2. If the skill repo(s) they need are private, a repo admin adds their
   GitHub account as a **collaborator** (Settings → Collaborators on the
   repo). Without this, their `gh` session simply can't read that repo —
   there's no separate step in this project to grant that access.
3. They register the server for themselves following "Register with your
   agent" above — no `env` block, no secret to hand over securely, nothing
   for this project to rotate or revoke. Revoking someone's access is just
   removing them as a repo collaborator on GitHub.

## Tests

```bash
npm test    # node --test, no network and no `gh` required
```

`test/github.test.js` covers the `gh` layer's error translation through the
`__setGhRunner` seam (a missing binary, a 404, a 403, a logged-out session).
`test/security.test.js` boots the real server over stdio and asserts each
refusal in "What the tools refuse to do" above — every one of them was first
demonstrated as a working exploit against this server, so a failure there
means that hole is open again.
