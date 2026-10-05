# Using skill-bridge

A hands-on guide for someone who already has `skill-bridge` registered with
their agent (see the root [`README.md`](../README.md) for installation) and
wants to know what to actually type, and what to expect back. If you hit an
error, jump straight to [Troubleshooting](#troubleshooting) below.

You never call these 6 tools directly — you just tell your agent, in plain
language, what you want, and it picks the right one. This guide shows the
actual input/output shape behind each step, so you can tell whether
something worked and debug it yourself if it didn't.

## Searching without knowing which repo

**"Find me anything about brand guidelines" (no repo named)**
→ agent calls `search_all_sources` instead of
`search_remote_skills`, since you didn't say which repo:
```json
{ "query": "brand", "limit": 10 }
```
Output:
```json
{
  "items": [{ "path": "brand-guidelines", "name": "brand-guidelines", "description": "...", "source": { "owner": "aidev3-web", "repo": "SKILL-LIB" } }],
  "sourcesSearched": [
    { "owner": "aidev3-web", "repo": "SKILL-LIB", "status": "ok", "matched": 1 },
    { "owner": "anthropics", "repo": "skills", "status": "ok", "matched": 0 }
  ],
  "totalMatched": 1
}
```
It only searches the repos listed in `sources.json` (shared) and
`sources.local.json` (your own, optional — see [Configuration](../README.md#configuration))
— a repo not in either list is invisible to this tool. A source with
`status: "error"` (e.g. you're not a collaborator on it) is skipped, not
fatal — the rest still search normally.

## When the curated list has nothing — `find_skills`

`search_all_sources` only ever sees the repos in `sources.json` /
`sources.local.json`. When it comes back empty, `find_skills` searches the wider
ecosystem through the skills.sh registry.

**Phrase it as a sentence.** The registry matches multi-word queries
semantically; a single word falls back to fuzzy name matching.

```json
{ "query": "keep a coding agent from adding features nobody asked for", "limit": 8 }
```
Output:
```json
{
  "searchType": "semantic",
  "totalMatched": 7,
  "unresolved": [],
  "items": [
    {
      "owner": "waynesutton", "repo": "convexskills",
      "path": "skills/avoid-feature-creep",
      "name": "avoid-feature-creep",
      "installs": 1270,
      "description": "Prevent feature creep when building software, apps, and AI-powered products...",
      "htmlUrl": "https://github.com/waynesutton/convexskills/blob/main/skills/avoid-feature-creep/SKILL.md"
    }
  ]
}
```

Why sentences beat keywords here: none of those results contain the phrase
"over-engineering" — they say *"feature creep"* instead. A keyword search misses
them; a semantic one doesn't.

`path` is what `pull_skill` needs, so a hit can be handed straight on:
```json
{ "owner": "waynesutton", "repo": "convexskills", "paths": ["skills/avoid-feature-creep"] }
```

### Reading the output honestly

- **`installs` is popularity, not review.** Nobody audited these. Run
  `validate_skill` and then `benchmark_skill` before using or pushing one.
- **`searchType`** says how the registry read your query. `"fuzzy"` means it
  matched names only — rephrase as a sentence to get `"semantic"`.
- **`unresolved`** lists hits whose folder couldn't be located on GitHub (repo
  private, renamed, or the folder isn't named after the skill). Those come back
  with `path: null` and cannot be pulled directly.
- **Check for an upstream before pulling.** Popular skills are often indexed
  under a redistributor rather than their origin, and the copy may carry no
  license even when the original is MIT. If the skill's frontmatter names an
  `upstream`, pull from there instead.

**Faster, registry-only:** `resolveDetails: false` skips the GitHub lookup
(~1.6s instead of ~5.6s for 8 hits) and returns `path` and `description` as
`null` — useful when you only want names and install counts.

**If it fails**, the error names the cause and reminds you `search_all_sources`
still works, since that one reads GitHub directly and doesn't depend on
skills.sh at all.

## A first walkthrough — pulling and deploying a skill

**1. "Find me skills about code review in anthropics/skills"**
→ agent calls `search_remote_skills`:
```json
{ "owner": "anthropics", "repo": "skills", "query": "review", "limit": 10 }
```
Output:
```json
{
  "items": [{ "path": "code-review", "name": "code-review", "description": "Review a diff for bugs and cleanups" }],
  "totalMatched": 1,
  "nextCursor": null,
  "truncated": false
}
```
`totalMatched` can be higher than the number of `items` returned — check
`nextCursor`; a non-null value means call the tool again with that cursor to
get the next page.

**2. "Pull that one down"**
→ agent calls `pull_skill`:
```json
{ "owner": "anthropics", "repo": "skills", "skillPaths": ["code-review"] }
```
Output:
```json
{ "pulled": [{ "path": "code-review", "name": "code-review", "localPath": "/home/you/.skill-library/code-review", "status": "pulled", "warnings": [] }] }
```
A non-empty `warnings` array here doesn't mean it failed (`status` is still
`"pulled"`) — it flags things like a missing `description`, worth fixing in
the source before others rely on it, but not blocking.

**3. "What agents do I have installed?"**
→ agent calls `detect_agents` (no input needed):
```json
{ "agents": [{ "agent": "claude-code", "scope": "global", "skillsDir": "/home/you/.claude/skills", "agentPresent": true }, { "agent": "cursor", "scope": "global", "skillsDir": "/home/you/.cursor/skills", "agentPresent": false }] }
```

**4. "Deploy it to Claude Code, just for me"**
Your agent should ask which scope you want (`global` vs `project`) before
calling this — if it doesn't, say so explicitly. → calls
`deploy_skill`:
```json
{ "skillName": "code-review", "targets": ["claude-code"], "scopes": ["global"] }
```
Output:
```json
{ "results": [{ "agent": "claude-code", "scope": "global", "skillsDir": "/home/you/.claude/skills", "status": "deployed", "path": "/home/you/.claude/skills/code-review" }] }
```
`status` can also be `deployed-copy` (symlinking wasn't available, it copied
the files instead — check `note`), `skipped-exists` (already there, nothing
changed), or `error` (check the `error` field for why). **Restart your agent**
after this — skill folders are only re-scanned on startup.

## Skills that need other skills — `dependencies.json`

A skill can be a conductor for other skills (for example `technext-sales-proposal`
calls twelve sub-skills by name). Agents load skills only from a skills folder, so
those sub-skills must be installed too. Instead of asking every user to pull them one
by one, the skill's author puts a `dependencies.json` next to its `SKILL.md`:

```json
{
  "requires": ["company-verifier", "officers-lookup"],
  "optional": ["diagram-design"]
}
```

`pull_skill` reads it after pulling the skill and pulls the listed skills as well;
`deploy_skill` then deploys them to the same agent locations, so you choose the scope
once. Your prompt does not change:

> Use technext-mcp-skill-lib to install technext-sales-proposal from aidev3-web/SKILL-LIB, global scope.

- **Where they come from.** The same repo and ref as the skill, as **siblings of its
  folder** (`team/x` needs `team/y`; a skill at the repo root needs a root folder). A
  dependency is never fetched from another repo.
- **`requires` and `optional`** are both installed by default. Pass
  `includeOptional: false` to leave the optional ones out, or `withDependencies: false`
  to pull or deploy only the skill you named.
- **Dependencies of dependencies** are followed, once each (a cycle cannot loop), up to
  25 in total. Something reached only through an optional skill stays optional.
- **What is already in your library is kept.** A dependency you already have is reported
  as `already-present` and not overwritten; its own dependencies are still followed.
- **A dependency that cannot be found** in the repo is reported as an `error` for that
  skill only. The skill you asked for and the other dependencies still install. If a
  dependency is missing from the library at deploy time, `deploy_skill` says so
  (`dependency-missing`) and deploys the rest.
- **Malformed entries are ignored and reported.** Names must be plain folder names:
  anything with a `/`, `\`, `..` or a leading `-` is dropped with a warning and never
  reaches the file system.
- **Agent files** (`agents/*.md`) of every deployed skill are copied to Claude Code's
  agents folder, as for a single skill.
- **Updates.** After `update_skill`, if the new version lists skills that are not in your
  library yet, the result says so; call `pull_skill` for the skill again to fetch them.

To add one to your own skill, list the folder names in `dependencies.json` and keep
each of them a normal skill folder in the same repo (its folder name equal to its
`name`). SKILL-LIB's lint only reads `SKILL.md`, so the extra file is fine.

## Updating skills you already pulled

`pull_skill` now records where each skill came from in a `.source.json` next to
its `SKILL.md`: the repo, branch and folder, plus the git blob id of every file
it wrote. That record is what makes updates possible; it is never pushed back
(`push_skill` skips it). Skills pulled before this feature have no record, so
they are left alone until you pull them again once.

**What you see.** Nothing, most of the time. When an agent is about to use a
skill that has a `.source.json`, the server's instructions tell it to call
`check_skill_update` first, once per session per skill. If the skill is up to
date, or you already declined this version, the agent says nothing. If a newer
version exists, the agent tells you what changed, says whether it looks relevant
to the project you are working on, and asks whether to update:

- **Yes** -> `update_skill` downloads only the files that changed, checks the
  result the same way `validate_skill` does, keeps the old version under
  `<library>/.history/<skill>/<timestamp>-<id>/`, and applies the change in
  place (the folder is never renamed, so the links in your agents' skill
  folders keep working). A skill's `agents/*.md` files are copied into Claude
  Code's `agents/` folder too; an agent file you edited there is left as it is
  and reported.
- **No** -> `decline_update` remembers this exact upstream state. You are asked
  again only when the skill changes further.

**Your own edits are safe.** If you edited a file that upstream also changed,
`update_skill` stops and lists it. Nothing is overwritten unless you agree to
`force`, and even then the previous version is kept in `.history`. A skill that
disappeared upstream is reported, never deleted. `dryRun: true` lists what would
change and touches nothing.

**The skill hook: installed for you when you install this server.** The server's
instructions only ask the agent to check, and an agent can occasionally skip
that. So the first time this server starts on a machine that has Claude Code, it
also registers `hook/skill-update-hook.js` as a Claude Code `PreToolUse` hook
scoped to the `Skill` tool, and the check then always happens. The hook runs only
when a skill is about to be used (a `/slash` command or the model's own choice;
both go through the Skill tool), never at plain session start, and it prints
something only when that skill has a newer version you have not been asked about
this session. It takes effect from your next Claude Code session.

Because this edits `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`),
it is deliberately conservative:

- it only adds its own single entry; every other setting and hook stays exactly
  as it was, and the previous file is copied to `settings.json.bak-<time>` first;
- it says what it did on stderr (`[technext-mcp-skill-lib] installed the skill-update hook
  in …`) together with how to turn it off;
- it is done once: if you remove the hook, it is never put back. It only keeps
  its own entry pointing at the current install if the package moves;
- a settings file that is not valid JSON is never touched, and a machine without
  Claude Code is skipped;
- **opt out** before the first start with `SKILL_LIB_AUTO_HOOK=0` in the
  server's environment (for example in the MCP registration's `env`).

To take the hook out later, or to manage it by hand:

```bash
node hook/install-hook.js                    # shows what it would change, writes nothing
node hook/install-hook.js --apply            # installs it
node hook/install-hook.js --remove --apply   # removes it (and it stays removed)
```

(`--settings <file>` targets another settings file.) The hook reads the skill name from the hook input, ignores skills that were not
pulled through this server, caches its verdict for six hours per skill (so most
uses cost nothing), asks at most once per session, and on any error stays silent
and exits 0. When it does speak, it hands the agent the same "what changed, ask
the user, then `update_skill` or `decline_update`" text as `check_skill_update`,
so the MCP server must also be registered. Set `SKILL_LIBRARY_PATH` for the hook
too if you moved the library.

**Limits.** Without the hook this relies on the agent following the server's
instructions, so an agent can occasionally skip the check. Only skills
pulled through this server are tracked. A skill loaded before the update keeps
running its old text until the next session. Results are cached for six hours
per skill while the server runs, and a failed check (offline, `gh` missing, rate
limited) is silent and never blocks the skill.

## Removing a skill you no longer want

**"Remove code-review, I don't use it anymore"** → agent should confirm
whether to also delete it from `SKILL-LIB/` (not just undeploy it) before
calling — this is permanent, `SKILL_LIBRARY_PATH` isn't git-tracked. →
`remove_skill`:
```json
{ "skillName": "code-review", "targets": ["claude-code"], "scopes": ["global"] }
```
```json
{ "undeployed": [{ "agent": "claude-code", "scope": "global", "skillsDir": "/home/you/.claude/skills", "status": "removed", "path": "/home/you/.claude/skills/code-review" }], "libraryRemoved": true, "libraryPath": "/home/you/.skill-library/code-review" }
```
Pass `keepInLibrary: true` to only remove the deployed symlinks and keep
the copy in `SKILL-LIB/` (e.g. you're switching which agent uses it, not
dropping it entirely). A `status: "skipped-not-symlink"` entry means a real
folder (not a symlink this tool created) is sitting in that agent's skills
directory with the same name — it's left alone on purpose; remove it by
hand only if you're sure it's safe to.

## Publishing a skill you wrote

**"Check if my skill folder is valid"** → `validate_skill`:
```json
{ "skillPath": "/home/you/.skill-library/my-new-skill" }
```
```json
{ "skillPath": "/home/you/.skill-library/my-new-skill", "name": "my-new-skill", "valid": false, "issues": ["frontmatter has an unexpected key: \"version\""] }
```
Fix every item in `issues` before pushing — `push_skill` re-runs this exact
check and refuses to push if it's not clean.

**"Is this skill actually good, before I push it?"** → call `benchmark_skill` TWICE.

*Call 1 — skillPath only:*
```json
{ "skillPath": "/home/you/.skill-library/my-new-skill" }
```
```json
{ "skillPath": "...", "layer0Passed": true, "layer0Issues": [], "moduleCount": 1, "descriptionLength": 143, "testPlan": "..." }
```
`layer0Passed`/`layer0Issues` are computed mechanically (description length,
vague phrasing like "helps with various things", module count against a
2-3-module complexity contract). `testPlan` tells the calling agent exactly
what to do for the rest — this tool has no ability to spawn sessions itself:
- **Layer 1 (Trigger)**: spawn a fresh session and give it a prompt that
  *should* fire the skill, and another fresh session with an adjacent prompt
  that *should not*. Report what actually happened.
- **Layer 2 (Outcome)**: spawn two fresh sessions on the same task, one with
  the skill available, one without, and compare the real results.
- **Layer 3 (Stability)**: run the same scenario 3 separate times and compare.
- **Layers 4-5 (Edge case & guardrail / Scope)**: no session needed — read
  SKILL.md and judge.

A guessed number is not accepted for Layers 1-3 — the agent must actually run
the sessions above and report real evidence.

*Call 2 — skillPath + results, once all 6 layers are done:*
```json
{ "skillPath": "/home/you/.skill-library/my-new-skill", "results": { "layer0Passed": true, "trigger": { "positivePrompt": "...", "positiveRawOutput": "<literal text the positive-prompt session produced>", "positiveFired": true, "negativePrompt": "...", "negativeRawOutput": "<literal text the negative-prompt session produced>", "negativeFired": false, "sessionEvidence": "..." }, "outcome": { "withSkillRawOutput": "<literal with-skill session output>", "withoutSkillRawOutput": "<literal without-skill session output>", "skillHelped": true }, "stability": { "runs": 3, "runOutputs": ["<run 1 literal output>", "<run 2 literal output>", "<run 3 literal output>"], "consistent": true, "notes": "..." }, "edgeCase": { "score": 17, "notes": "..." }, "scope": { "score": 18, "notes": "..." }, "score": 88, "summary": "no concerns" } }
```
```json
{ "skillPath": "...", "layer0Passed": true, "reportPath": "/home/you/.skill-library/my-new-skill.benchmark-report.html", "overallPassed": true }
```
This writes a permanent, human-readable HTML report — a table of all 6 layers
with pass/fail, plus the literal raw output of every Layer 1-3 session
embedded as a terminal-styled block under its row (not a paraphrase — this
server has no screenshot capability, so the raw text is the closest
verifiable substitute: anyone reading the report can check it themselves) —
next to the skill folder (never inside it, so it's never accidentally pushed
as skill content). Pass that same `results` object as `push_skill`'s
`benchmark` argument next.

**"Push it to aidev3-web/SKILL-LIB, I'm <you>"** → `push_skill`:
```json
{ "skillPath": "/home/you/.skill-library/my-new-skill", "owner": "aidev3-web", "repo": "SKILL-LIB", "identity": "your-github-username", "benchmark": { "layer0Passed": true, "trigger": { "...": "..." }, "outcome": { "...": "..." }, "stability": { "...": "..." }, "edgeCase": { "score": 17, "notes": "..." }, "scope": { "score": 18, "notes": "..." }, "score": 88, "summary": "no concerns" } }
```
```json
{
  "status": "pushed", "skillName": "my-new-skill", "isUpdate": false,
  "commitSha": "d8ee30e", "commitUrl": "https://github.com/you/SKILL-LIB/commit/d8ee30e",
  "forkFullName": "you/SKILL-LIB", "forkBranch": "skill/my-new-skill", "forkCreated": true,
  "pullRequestUrl": "https://github.com/aidev3-web/SKILL-LIB/pull/9",
  "pullRequestNumber": 9, "pullRequestAction": "created",
  "filesPushed": ["my-new-skill/SKILL.md", "my-new-skill/.meta.json"],
  "warnings": ["You had no fork of aidev3-web/SKILL-LIB — created you/SKILL-LIB for this push."]
}
```

**Note where the commit landed.** `owner`/`repo` name the *upstream* library,
which is read-only to you — nothing is ever written there. The commit goes to
`forkFullName` (your own fork, created on first use), on one branch per skill,
and reaches upstream only as a pull request for a maintainer to review.

**Pushing the same skill again reuses its PR.** The second push reports
`pullRequestAction: "updated"` and the same `pullRequestNumber`, adding a commit
to the open PR instead of opening a duplicate.

`status` can also come back `validation-failed` (didn't pass the same checks
as above), `benchmark-too-low` (Layer 0 failed, a Layer 1-3 real test failed, or the score is under 70/100 —
see Troubleshooting), `secrets-detected` / `dangerous-instructions-detected`
(see Troubleshooting), `identity-mismatch` (the `identity` you gave doesn't
match the account `gh` is logged in as — see Troubleshooting), `fork-name-conflict`
(you own a same-named repo that isn't a fork of this upstream — see
Troubleshooting), or `conflict` (something else pushed to your fork's branch
while this was running — just retry).

See the root README's ["Recommended workflow for publishing a locally-created
skill"](../README.md#recommended-workflow-for-publishing-a-locally-created-skill)
for the full push → verify → PR → review flow this feeds into.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `GitHub CLI ("gh") is not installed or not on PATH` | `gh` isn't installed, or isn't on the PATH the MCP server's process sees (can differ from your terminal's PATH on some agents) | Install from https://cli.github.com/, restart the agent so it picks up the updated PATH |
| `GitHub CLI is installed but not logged in` | Never ran `gh auth login`, or logged in on a different machine/account | `gh auth login` in a terminal, then restart the agent |
| Error mentions a stale `GITHUB_TOKEN`/`GH_TOKEN` shadowing the login | An old env var from a token-based setup (this project's own past, or an unrelated tool) is still set — `gh` prioritizes it over your real login even when it's expired/invalid | Unset it: PowerShell `Remove-Item Env:\GITHUB_TOKEN` (session-only) or `[Environment]::SetEnvironmentVariable("GITHUB_TOKEN",$null,"User")` (permanent); bash `unset GITHUB_TOKEN`. Close and reopen the terminal/agent afterward — an already-running process keeps the old value in memory |
| `GitHub API GET ... -> 404` when searching/pulling a private repo | You're not a collaborator on that repo — GitHub returns 404 (not 403) for a private repo you can't see, by design | Ask a repo admin to add your GitHub account as a collaborator |
| `GitHub API POST/PATCH ... -> 403` on `push_skill` | A write was attempted against a repo you can't write to. `push_skill` never writes to the upstream library (it forks and opens a PR), so this means the write hit **your own fork** — usually because your `gh` login lost access to it, or the fork was deleted mid-push | Check `gh auth status` is the account that owns the fork, then retry. You do **not** need collaborator rights on the upstream repo |
| `push_skill` returns `fork-name-conflict` | You already own a repo with the library's name, but it isn't a fork of that upstream — committing into it would bury the skill in an unrelated project | Rename or delete that repo, then retry. The tool refuses rather than guessing |
| `push_skill` returns `dangerous-instructions-detected` | `SKILL.md` contains an instruction pattern consistent with data theft or destruction — an unscoped destructive command (`rm -rf ~`), or a credential path (`~/.ssh`, `.env`) named alongside a network-send call in the same file | Read the listed findings and remove the pattern. Scoped commands like `rm -rf dist/` and plain `curl` deploys do not trip this. There is no override flag |
| `find_skills` errors with "Could not reach skills.sh" / "endpoint may have changed" | The registry is down, or its undocumented `/api/search` endpoint moved | Use `search_all_sources` meanwhile — it reads GitHub directly and doesn't depend on skills.sh. Set `SKILLS_REGISTRY_URL` if a mirror exists |
| `find_skills` returns hits with `path: null`, listed in `unresolved` | The skill's repo is private, was renamed, or its folder isn't named after the skill, so its real path couldn't be found on GitHub | Open the repo by hand to find the folder, then call `pull_skill` with that path |
| `find_skills` returns `searchType: "fuzzy"` and poor results | You passed a single word, so the registry matched names only instead of meaning | Rephrase as a sentence describing the job, e.g. "keep a coding agent from adding features nobody asked for" |
| `push_skill` returns `identity-mismatch` | The `identity` value you gave doesn't match the login/name/email of the account `gh` is logged in as | Fix the `identity` value, or pass `confirmMismatch: true` if you're deliberately pushing on someone else's behalf |
| `push_skill` returns `conflict` | Someone else pushed to that branch while this call was running | Just retry the same call — nothing was lost, the unreferenced commit is harmless |
| `push_skill` returns `secrets-detected` | The skill folder holds a file that looks like a credential (`.env`, `*.pem`, `id_rsa`, `credentials.json`, …) and would have been published to a shared repo | Move it out of the skill folder, or rename to `.env.example`/`.sample` if it's a template. There is no override flag — a pushed secret has to be treated as leaked |
| `push_skill` returns `benchmark-too-low` | Layer 0 failed (too-short/vague description, too many supporting files), OR a Layer 1-3 real test failed (skill didn't trigger, triggered when it shouldn't, didn't outperform without it, or wasn't consistent across 3 runs), OR the total score is under 70/100 | Read the specific reason(s) and the `.benchmark-report.html` file, fix the skill, run `benchmark_skill` again (both calls), then retry `push_skill` with the new result. There is no override flag |
| `Invalid skillName — it must be a single folder name…` | `skillName` contained `/`, `\`, `..`, or an absolute path. It names one folder directly under `SKILL_LIBRARY_PATH`, not a path | Pass just the folder name, e.g. `no-emoji-check`, not `SKILL-LIB/no-emoji-check` or a full path |
| `remove_skill` reports `libraryRemoved: false` with a `librarySkipReason` | The skill is still deployed somewhere this call didn't undeploy (usually because `targets`/`scopes` narrowed it), so deleting the folder would leave a dangling symlink | Re-run without the `targets`/`scopes` filter, or remove the listed non-symlink folders by hand |
| `deploy_skill` result has `status: "error"` for one agent | Usually a permissions issue writing to that agent's skills folder | Check the `error` field in that result for the OS-level reason |
| Deployed a skill but the agent still doesn't see it | Agent skill folders are only scanned at startup | Restart the agent (or reload MCP servers, if your agent supports that without a full restart) |
| `Could not read skill sources from …sources.local.json` | That file isn't valid JSON (hand-edited) | Fix the JSON — the message names which of the two files is broken |
