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
→ agent calls `mcpskilllib_search_all_sources` instead of
`mcpskilllib_search_remote_skills`, since you didn't say which repo:
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

## A first walkthrough — pulling and deploying a skill

**1. "Find me skills about code review in anthropics/skills"**
→ agent calls `mcpskilllib_search_remote_skills`:
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
→ agent calls `mcpskilllib_pull_skill`:
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
→ agent calls `mcpskilllib_detect_agents` (no input needed):
```json
{ "agents": [{ "agent": "claude-code", "scope": "global", "skillsDir": "/home/you/.claude/skills", "agentPresent": true }, { "agent": "cursor", "scope": "global", "skillsDir": "/home/you/.cursor/skills", "agentPresent": false }] }
```

**4. "Deploy it to Claude Code, just for me"**
Your agent should ask which scope you want (`global` vs `project`) before
calling this — if it doesn't, say so explicitly. → calls
`mcpskilllib_deploy_skill`:
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

## Removing a skill you no longer want

**"Remove code-review, I don't use it anymore"** → agent should confirm
whether to also delete it from `SKILL-LIB/` (not just undeploy it) before
calling — this is permanent, `SKILL_LIBRARY_PATH` isn't git-tracked. →
`mcpskilllib_remove_skill`:
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

**"Check if my skill folder is valid"** → `mcpskilllib_validate_skill`:
```json
{ "skillPath": "/home/you/.skill-library/my-new-skill" }
```
```json
{ "skillPath": "/home/you/.skill-library/my-new-skill", "name": "my-new-skill", "valid": false, "issues": ["frontmatter has an unexpected key: \"version\""] }
```
Fix every item in `issues` before pushing — `push_skill` re-runs this exact
check and refuses to push if it's not clean.

**"Push it to aidev3-web/SKILL-LIB, I'm <you>"** → `mcpskilllib_push_skill`:
```json
{ "skillPath": "/home/you/.skill-library/my-new-skill", "owner": "aidev3-web", "repo": "SKILL-LIB", "identity": "your-github-username" }
```
```json
{ "status": "pushed", "skillName": "my-new-skill", "isUpdate": false, "commitSha": "a1b2c3d", "commitUrl": "https://github.com/aidev3-web/SKILL-LIB/commit/a1b2c3d", "filesPushed": ["my-new-skill/SKILL.md", "my-new-skill/.meta.json"], "warnings": [] }
```
`status` can also come back `validation-failed` (didn't pass the same checks
as above), `identity-mismatch` (the `identity` you gave doesn't match the
account `gh` is logged in as — see Troubleshooting), or `conflict` (someone
else pushed to that branch while this was running — just retry).

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
| `GitHub API POST/PATCH ... -> 403` on `push_skill` | You're a collaborator with only Read access, not Write | Ask a repo admin to upgrade your role to Write (or Contents: Write on the specific repo) |
| `push_skill` returns `identity-mismatch` | The `identity` value you gave doesn't match the login/name/email of the account `gh` is logged in as | Fix the `identity` value, or pass `confirmMismatch: true` if you're deliberately pushing on someone else's behalf |
| `push_skill` returns `conflict` | Someone else pushed to that branch while this call was running | Just retry the same call — nothing was lost, the unreferenced commit is harmless |
| `push_skill` returns `secrets-detected` | The skill folder holds a file that looks like a credential (`.env`, `*.pem`, `id_rsa`, `credentials.json`, …) and would have been published to a shared repo | Move it out of the skill folder, or rename to `.env.example`/`.sample` if it's a template. There is no override flag — a pushed secret has to be treated as leaked |
| `Invalid skillName — it must be a single folder name…` | `skillName` contained `/`, `\`, `..`, or an absolute path. It names one folder directly under `SKILL_LIBRARY_PATH`, not a path | Pass just the folder name, e.g. `no-emoji-check`, not `SKILL-LIB/no-emoji-check` or a full path |
| `remove_skill` reports `libraryRemoved: false` with a `librarySkipReason` | The skill is still deployed somewhere this call didn't undeploy (usually because `targets`/`scopes` narrowed it), so deleting the folder would leave a dangling symlink | Re-run without the `targets`/`scopes` filter, or remove the listed non-symlink folders by hand |
| `deploy_skill` result has `status: "error"` for one agent | Usually a permissions issue writing to that agent's skills folder | Check the `error` field in that result for the OS-level reason |
| Deployed a skill but the agent still doesn't see it | Agent skill folders are only scanned at startup | Restart the agent (or reload MCP servers, if your agent supports that without a full restart) |
| `Could not read skill sources from …sources.local.json` | That file isn't valid JSON (hand-edited) | Fix the JSON — the message names which of the two files is broken |
