# AGENTS.md — mcp-skill-library

Instructions for any AI agent (Claude Code, Codex, OpenCode...) making
changes inside this directory (`mcp-skill-library/`). This file governs
this subtree specifically; the repository root's `CLAUDE.md` governs
everything else in the monorepo. Where the two disagree (see §2.2), the
file closer to the code you're editing wins — that's this one, for
anything under `mcp-skill-library/`.

## 1. What this project is, and how to run/check it

- A single MCP server (`mcp-skill-lib`), published as
  `@aidev3-web/mcp-skill-library`. Plain Node ESM, no build step.

### 1.1 Project structure

```
mcp-skill-library/
├── README.md               # Install, agent-registration snippets, auth model, tool table
├── AGENTS.md               # This file — contributor rules for this subtree
├── package.json            # npm metadata, `npm test` script, dependencies
├── package-lock.json       # Locked dependency versions
├── .gitignore              # Git ignore patterns
├── .npmrc                  # npm registry config (only needed for the optional
│                           #   GitHub-Packages `npx` install path)
├── index.js                # Entry point — registers the 8 MCP tools.
│                           #   A thin router only: receives a call, calls the
│                           #   matching lib/ function, holds no logic itself —
│                           #   except the input guards (resolveSkillDir) that
│                           #   must run before any lib/ call, see §1.2.
├── sources.json            # Shared list of skill repos search_all_sources
│                           #   scans. Add one by PR to this file.
├── docs/
│   └── USAGE.md            # End-user walkthrough per tool + troubleshooting
├── lib/                    # All real logic, one file per concern
│   ├── github.js           #   GitHub access via the `gh` CLI (read + write);
│   │                       #     ensureGhReady()/__setGhRunner() live here
│   ├── frontmatter.js       #   SKILL.md frontmatter parsing (name/description)
│   ├── agents.js            #   Agent detection + symlink-or-copy deploy/remove,
│   │                       #     plus findRemainingDeployments()
│   ├── validate.js          #   SKILL.md format validation rules (shared by
│   │                       #     validate_skill and push_skill's fail-closed gate)
│   └── localfs.js           #   Recursive local skill-folder walk + credential
│                           #     sweep (both for push_skill)
└── test/                   # node:test
    ├── github.test.js       #   gh-layer error translation, via __setGhRunner
    └── security.test.js     #   the refusals in §1.2, over a real stdio server
```

Not yet present, worth adding if this package's release process matures:
a `CHANGELOG.md` (version history) and a `LICENSE` file — `package.json`
currently declares `"license": "ISC"` but there is no actual `LICENSE`
file backing that claim.

- Auth: the GitHub CLI (`gh`), installed and logged in (`gh auth login`)
  on the machine running this server — no `GITHUB_TOKEN` or any other
  token is read or accepted anywhere in this codebase. `lib/github.js`
  shells out to `gh api ...` for every GitHub call; `ensureGhReady()`
  checks `gh` is installed and authenticated before the first real call.
  Reading a private skill repo requires the logged-in account to be a
  **collaborator** on it (ask a repo admin to add you) — this is enforced
  by GitHub itself, not by code here. `push_skill` additionally needs
  write access on the target repo.
  Optional env var: `SKILL_LIBRARY_PATH` (default `~/.skill-library`).
- Test suite: `npm test` runs `node --test` against `test/*.test.js`.
  `test/github.test.js` never shells out to a real `gh` — it swaps in a
  fake runner via `__setGhRunner()` (exported from `lib/github.js` for
  this purpose only). Keep using that seam for new GitHub-call tests
  instead of mocking `child_process` directly.
- There is no lint/typecheck script configured. At minimum, run
  `node --check index.js` and `node --check lib/<file>.js` for every
  file you touched before committing — a syntax error must never reach
  `main`.
- Manual verification: register the server locally
  (`claude mcp add --scope user mcp-skill-lib -- node <path-to>/index.js`
  works without publishing) and call each of the 8 tools at least once
  end to end (search / search-all-sources → pull → detect → deploy →
  remove, and validate → push) against a scratch repo/branch — never
  `main` of any real repo — before opening a PR that touches `index.js`
  or `lib/`.

### 1.2 Invariants — don't regress these

This server takes input from two places that must not be trusted: skill
content pulled from outside repos, and tool arguments an agent produced
after reading that content. Each rule below fixed a hole that was
demonstrated working against this server, and each has a test in
`test/security.test.js`. If a change makes one of those fail, the change
is wrong — not the test.

- **Any tool that turns a `skillName` into a path goes through
  `resolveSkillDir()` first**, and returns `BAD_SKILL_NAME_MSG` on null.
  A `skillName` is one folder name directly under `LIBRARY_ROOT`, never a
  path. `remove_skill` with `../important-files` was a recursive delete.
- **`pull_skill` re-checks every repo-provided path** against its
  destination root before writing (zip-slip), and writes the `Buffer`
  from `getBlobBytes()` — never a `getBlobText()` string. A UTF-8 round
  trip silently corrupts every binary a skill ships.
- **`remove_skill` calls `findRemainingDeployments()` across *all*
  detected agents** (not just the filtered ones) before deleting the
  library folder, and reports `librarySkipReason` instead of deleting.
- **`push_skill` runs `findSecretFiles()` before its first GitHub call**
  and fails closed. No override flag — don't add one.
- **`owner`/`repo` reach an API path only via `repoPath()`** in
  `lib/github.js`. Never interpolate them into a `ghApi()` path directly.
- **Caches stay bounded**: `treeCache` (size-capped, TTL) and
  `ensureGhReady`'s `readyCheck` (TTL, so a mid-session `gh auth logout`
  is noticed).

## 2. Commit messages

This subtree follows Conventional Commits — same spirit as the rest of
the repo, with a type list adapted for a published npm package instead
of the app-scope types in the root `CLAUDE.md`.

### 2.1 The format

```
<type>(<scope>): <short description, lower case, imperative>

<Body: what changed and why. Wrap at 72 characters.>
```

Real example:

```
fix(agents): skip already-linked symlinks instead of erroring

deploySkill() was treating a symlink that already points at the right
source directory as a failure. Compare the resolved link target before
deciding pulled/error so re-running deploy_skill after a re-pull is a
no-op instead of a false "skipped-exists".
```

The scope is optional but preferred. Use the part of the system you
touched: `index` (tool definitions/schemas), `github` (`lib/github.js`),
`agents` (`lib/agents.js`), `frontmatter` (`lib/frontmatter.js`),
`validate` (`lib/validate.js`), `localfs` (`lib/localfs.js`),
`docs` (README/AGENTS.md), `config` (package.json, `.npmrc`,
`provision-skill-bridge.ps1`). Omit it for changes that genuinely span
the whole package.

### 2.2 Allowed types

| Type | Use it for |
|---|---|
| `feat` | New behaviour a consuming agent can see (a new tool, a new input/output field) |
| `fix` | Correcting behaviour that was wrong |
| `hotfix` | An urgent fix that needs a patch release published immediately (this is a published npm package — a broken `index.js` breaks every agent that installs it) |
| `docs` | Documentation only — README, AGENTS.md, code comments |
| `chore` | File moves, renames, dependency bumps, housekeeping |
| `refactor` | Restructuring code that leaves behaviour identical |
| `test` | Adding or changing tests, once a real suite exists |

This differs slightly from the root `CLAUDE.md` list (`feat, fix, docs,
style, refactor, test, chore, ci`): `hotfix` is added because this
package ships to other people's machines via npm and a broken release
needs a distinct, urgent commit type; `style` and `ci` are dropped
because there is no code formatter and no CI pipeline configured here
yet. If either gets added to this subtree later, fold this table back
in line with the root one instead of letting them drift further apart.

### 2.3 What a good message says

- State the change, not the activity. `fix(agents): don't overwrite a
  real folder with a symlink`, not `fix bug` or `update code`.
- Say why, if it is not obvious. The diff shows what changed; the
  message explains the reason it needed to change.
- One logical change per commit. If the body needs the word "and"
  twice, it is probably two commits.
- Reference the issue if there is one: `Refs #12`, or `Closes #12`.

### 2.4 What is rejected

`update`, `fix bug`, `wip`, `asdf`, `changes`, `final`, `final2`. Anything
that does not match the format above, or exceeds ~72 characters in the
subject, or says nothing, should not be committed — fix the message
before committing, don't commit first and clean up later.

## 3. Branches, push and pull

### 3.1 Branches

| Branch | Meaning |
|---|---|
| `main` | Always installable via `npx`. Never commit to it directly. |
| `feat/<short-name>` | New behaviour |
| `fix/<short-name>` | A correction |
| `hotfix/<short-name>` | Urgent fix headed for an immediate patch release |
| `docs/<short-name>` | Documentation only |

Branch names are lower-case with hyphens, e.g. `feat/pull-skill-dedupe`.

### 3.2 Before you push

1. Pull first, and rebase — do not merge:
   ```bash
   git pull --rebase origin main
   ```
   This keeps history linear and readable.
2. Run the syntax check on every file you touched:
   ```bash
   node --check index.js
   node --check lib/github.js
   node --check lib/agents.js
   node --check lib/frontmatter.js
   node --check lib/validate.js
   node --check lib/localfs.js
   ```
3. Manually exercise the change (see §1's "Manual verification") — there
   is no automated suite to lean on instead.
4. Read your own diff: `git diff --staged`. Look for a leftover
   `console.log`, a hardcoded token, or accidental reformatting of
   lines you didn't mean to touch.

### 3.3 Pushing

```bash
git push -u origin feat/pull-skill-dedupe
```

Then open a pull request. There is no PR template configured yet in
this subtree — describe what changed and how you verified it manually.

### 3.4 Rules that are not negotiable

- Never `git push --force` to `main`. If you must rewrite a shared
  branch, use `--force-with-lease` and tell the other person first.
- **Never commit any secret** (a token, a key, a `.env` file with real
  values). This codebase itself has no token to guard — auth is entirely
  `gh auth login` on the machine running the server — but the rule still
  applies to anything else that might land in a diff. If a real secret
  ever lands in a commit, say so immediately — do not quietly amend it
  away, since removing it from history means rewriting every commit
  after it.
- Never commit `node_modules/` or any build output.
- Don't commit real skill content pulled from someone else's private
  repo into this repo's own history — `SKILL_LIBRARY_PATH` output is
  local-machine state, not something this package's own repo tracks.
