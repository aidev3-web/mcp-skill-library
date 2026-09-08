# AGENTS.md — mcp-skill-library

Instructions for any AI agent (Claude Code, Codex, OpenCode...) making
changes inside this directory (`mcp-skill-library/`). This file governs
this subtree specifically; the repository root's `CLAUDE.md` governs
everything else in the monorepo. Where the two disagree (see §2.2), the
file closer to the code you're editing wins — that's this one, for
anything under `mcp-skill-library/`.

## 1. What this project is, and how to run/check it

- A single MCP server (`skill-bridge`), published as
  `@aidev3-web/mcp-skill-library`. Plain Node ESM, no build step.
- Layout: `index.js` (the 6 registered tools) · `lib/github.js` (GitHub
  REST calls, read AND write) · `lib/frontmatter.js` (SKILL.md frontmatter
  parsing) · `lib/agents.js` (agent detection + symlink deploy) ·
  `lib/validate.js` (SKILL.md frontmatter rule-checking, shared by
  `validate_skill` and `push_skill`) · `lib/localfs.js` (recursive local
  skill-folder walk for `push_skill`).
- Required env var: `GITHUB_TOKEN` (Contents:Read on the target repo;
  Contents:Read **and Write** if `push_skill` will be used).
  Optional: `SKILL_LIBRARY_PATH` (default `~/.skill-library`).
- No automated test suite exists yet (`npm test` is a placeholder that
  always fails — don't try to make it pass, and don't delete the
  placeholder without replacing it with a real suite).
- There is no lint/typecheck script configured. At minimum, run
  `node --check index.js` and `node --check lib/<file>.js` for every
  file you touched before committing — a syntax error must never reach
  `main`.
- Manual verification: register the server locally
  (`claude mcp add --scope user skill-bridge -- node <path-to>/index.js`
  works without publishing) and call each of the 6 tools at least once
  end to end (search → pull → detect → deploy, and validate → push)
  against a scratch repo/branch — never `main` of any real repo — before
  opening a PR that touches `index.js` or `lib/`.

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
- **Never commit a real `GITHUB_TOKEN` value, or any other secret.**
  `.npmrc` and every config example in the README use the literal
  placeholder `${GITHUB_TOKEN}` — it must stay a placeholder resolved
  from the environment at read-time, never a real token string. If a
  real token ever lands in a commit, say so immediately — do not
  quietly amend it away, since removing it from history means
  rewriting every commit after it.
- Never commit `node_modules/` or any build output.
- Don't commit real skill content pulled from someone else's private
  repo into this repo's own history — `SKILL_LIBRARY_PATH` output is
  local-machine state, not something this package's own repo tracks.
