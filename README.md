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
  `push_skill` needs **no** write access on the library repo — it forks it
  under your own account and opens a PR (see "Recommended workflow" below).
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
   call, using whichever account `gh` is logged in as. Do NOT ask me
   which repo(s) I want to use right now — that's decided later, per
   search/pull call, not during install. Just note for later: a private
   repo needs me to already be a collaborator on it (`gh auth login`
   alone doesn't grant that).

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
   local-run install: `git clone https://github.com/aidev3-web/mcp-skill-library.git`
   (or reuse an existing checkout if I already have one), `npm install`,
   then point your config at that checkout's `index.js` via `node`.
   Only fall back to the `npx` alternative if I explicitly say I'd
   rather not manage a local checkout. No `env` block or token of any
   kind is needed in either case.

6. Always use the default SKILL_LIBRARY_PATH (~/.skill-library) — do not
   ask me about this or add an `env` block for it.

7. Tell me to restart you (or reload MCP servers) so the new config
   is picked up.

8. Once restarted, call the `detect_agents` tool once and
   report back which agent locations were found on this machine, to
   confirm the server is actually running.
```

## Tools this server exposes

| Tool | Does |
|---|---|
| `search_remote_skills` | Find `SKILL.md` folders in a GitHub repo by path substring — no full clone, paginated |
| `search_all_sources` | Same search, but across every repo listed in `sources.json` (shared, versioned in this package) plus `sources.local.json` (optional, personal, under `SKILL_LIBRARY_PATH`) — one call instead of calling `search_remote_skills` once per repo |
| `find_skills` | Search the **whole open skill ecosystem**, not just the curated list, via the [skills.sh](https://skills.sh) registry. Matches **semantically**, so a query phrased one way finds skills that describe the same job differently. Returns an install count per hit. Use it when `search_all_sources` came up empty — see [Finding a skill nobody has curated yet](#finding-a-skill-nobody-has-curated-yet) |
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

### Finding a skill nobody has curated yet

`search_all_sources` only ever sees the repos listed in `sources.json` /
`sources.local.json`. When the skill you want isn't in any of them, `find_skills`
searches the wider ecosystem through the **skills.sh** registry — the index
behind Vercel Labs' open-source `npx skills` CLI.

**Phrase the query as a sentence, not as keywords.** The registry matches a
multi-word query *semantically*; a single word falls back to fuzzy name
matching. The result object reports which happened, in `searchType`
(`"semantic"` / `"fuzzy"`), because it changes how much to trust the hits.

This matters more than it sounds. A skill whose entire purpose is stopping an
agent from over-engineering, but which calls that *"scope creep"*, is
unreachable by a keyword search for "over-engineering" — and reachable by a
semantic search for *"keep a coding agent from adding features nobody asked
for"*.

Each hit carries an **install count** from the registry's CLI telemetry. Read
it as *popularity, not review* — skills.sh says so itself. Nobody has audited
these; that is what `validate_skill` and `benchmark_skill` are for.

> **An install count can point at the wrong copy.** A widely-forked skill is
> often indexed under a redistributor's repo rather than its origin, and the
> copy may carry no license even when the original is MIT. If a hit's
> frontmatter names an `upstream`, prefer the upstream repo.

Two fields need GitHub, not the registry: the skill's **real folder path** (the
registry returns only `owner/repo/skillId`) and its **description**. `find_skills`
resolves both by reading one cached repo tree per distinct repo, so a hit can be
handed straight to `pull_skill`. Pass `resolveDetails: false` to skip that —
roughly 1.6s instead of 5.6s for a page of 8, at the cost of `path` and
`description` coming back `null`.

**This is the one tool with an external dependency.** Everything else here needs
only `gh`. Specifics worth knowing before relying on it:

- It calls `https://skills.sh/api/search`, which needs **no token or API key** —
  consistent with this project's "never store a credential" rule.
- That endpoint is **not in skills.sh's published API docs** (the documented
  `/api/v1/*` endpoints require a Vercel OIDC token and answer `401`). It could
  change shape or disappear. Every failure mode — auth added, endpoint retired
  and answering HTML, host unreachable, request hung — is covered in
  `test/registry.test.js` and surfaces as a clear message, never a crash.
- Set `SKILLS_REGISTRY_URL` to point at a mirror if that ever happens.
- If the registry is down, `search_all_sources` is unaffected — it reads GitHub
  directly.

### Recommended workflow for publishing a locally-created skill

The library repo is **public and read-only to contributors** — you are
deliberately not a collaborator on it. So `push_skill` never writes to the
upstream repo at all (creating a branch there is already a write). It uses
GitHub's standard outside-contributor route instead: fork, commit to the fork,
open a pull request.

```
upstream/SKILL-LIB (read-only)          you/SKILL-LIB (your fork)
         main  ◄────── PR #12 ──────  skill/git-commit-check
         main  ◄────── PR #13 ──────  skill/daily-report
```

What one `push_skill` call does:

1. **Runs every gate first** — validate → benchmark → credential sweep →
   dangerous-instruction sweep → identity check. All of these fail closed
   *before* any GitHub call, exactly as before.
2. **Resolves your fork** — reuses it if you have one, creates it if you
   don't (and waits out GitHub's async fork-creation window). If you own a
   same-named repo that is *not* a fork of this upstream, it refuses with
   `status: "fork-name-conflict"` rather than committing into the wrong project.
3. **Commits to a branch in your fork** — one branch per skill, named
   `skill/<skillName>` unless you pass `branch`. A new branch starts from
   *upstream's* current default-branch head, so the PR diff stays limited to
   your skill even if your fork has gone stale.
4. **Opens the PR back to upstream** — or, if a PR is already open for that
   skill's branch, adds the commit to it instead of opening a duplicate.
   `pullRequestAction` in the result says which happened (`created` /
   `updated`).
5. **A human reviews and merges** — this repo's `CODEOWNERS` requires review
   before merge; the tool never merges anything itself.

The commit is pushed to your fork *before* the PR step, so if PR creation
fails the skill is not lost — the result carries a warning with the exact
`gh pr create` command to finish by hand.

To verify a push round-tripped, pull it back from your fork:
`pull_skill` with `owner` set to your own account and `ref` set to the
branch name the result reports.

## Configuration

- **Auth** — not a config value at all. Every tool that talks to GitHub calls
  `ensureGhReady()` first, which checks `gh` is installed and logged in
  (`gh auth login`) and fails with a clear message if not. There is no
  `GITHUB_TOKEN` (or any other token) anywhere in this codebase.
- `SKILL_LIBRARY_PATH` (optional) — where `pull_skill`/`deploy_skill` read and
  write skill content locally. Defaults to `~/.skill-library`.
- `SKILLS_REGISTRY_URL` (optional) — overrides the skills.sh search endpoint
  `find_skills` calls. Defaults to `https://skills.sh/api/search`. Point it at a
  mirror if that endpoint ever moves; the test suite also uses it to exercise
  the failure path against a closed port without touching the network. Not a
  credential — the endpoint is public.
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
