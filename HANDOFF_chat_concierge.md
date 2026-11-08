# Handoff — Agentic Chat Concierge (2026-11-08)

## Where the work lives

- Real project: `/Users/levg/Workspace/dev-firm`
- This OpenCode session's cwd is a different worktree
  (`/Users/levg/.local/share/opencode/worktree/6cf08b/cosmic-harbor`), but **all
  edits were made in `/Users/levg/Workspace/dev-firm`**.
- The next session should work in `/Users/levg/Workspace/dev-firm`.

## Goal

Replace the old scripted chat intent classifier with a real conversational
tool-calling agent so the user can type free text such as:

- “How does niw-tracker handle authentication?”
- “In career-firm, add a dark mode toggle to the settings page.”
- “What’s blocking the latest build?”
- “Compare the architecture of career-firm and niw-tracker.”

The agent should resolve casual repo names, inspect code, query firm state, and
start delivery runs without a prepared brief.

## Implemented

### New files

1. `src/chat/repos.ts`
   - `RepoCatalog` — local git repository discovery and read-only inspection.
   - `RepoEntry { name, path, description }`.
   - `RepoError`.
   - `list()` scans direct children of `settings.reposDir` for `.git`.
   - `resolve(input)` accepts:
     - exact names (`career-firm`)
     - casual names (`career firm`, `the tracker`, `niw`)
     - `owner/repo` (`levg88/niw-tracker`)
     - paths under `reposDir`
     - throws a helpful error listing available repos
   - `overview()` returns description, top-level layout, package.json metadata,
     README excerpt, `AGENTS.md`/`Context/` presence.
   - `listFiles()`, `readFile()`, `search()` (literal or regex, optional glob,
     line numbers).
   - Security:
     - all reads confined to the resolved repo
     - `safeResolve()` rejects path escapes and symlink escapes
     - absolute paths outside `reposDir` are rejected
     - search capped at 4,000 files, 512 KB/file, 32 MB total
     - skips `.git`, `node_modules`, `dist`, `build`, caches, venvs, etc.

2. `src/chat/agent.ts`
   - `ChatService` — the concierge.
   - `ChatTurnResult { reply, workflowId, metadata }`.
   - Carries conversation history into the model.
   - Uses the existing `Agent` tool loop.
   - Offline/mock fallback returns a useful deterministic message.
   - Tool list registered per turn:
     - `list_repos`
     - `repo_overview`
     - `list_repo_files`
     - `read_repo_file`
     - `search_repo_code`
     - `github_repo_info` (GitHub API metadata; access/description/language)
     - `get_firm_status`
     - `list_builds`
     - `get_build`
     - `read_artifact`
     - `list_tickets`
     - `start_build`
   - `start_build`:
     - resolves the repo if provided
     - allows no repo for a brand-new app in a fresh workspace
     - creates a workflow with `{ brief, repo_path, source: 'chat' }`
     - hands execution to the normal `BuildService`
     - returns `{ workflow_id, url: '/build/<id>', repo, ... }`
     - supports an injectable `startBuildRunner` for tests
   - `metadata` records provider/model, steps, tokens, started builds, repos
     used, and a truncated tool trace.
   - `ChatService.historyFromRows()` converts DB chat rows into model history,
     starting at the first user turn (Anthropic-friendly).

3. `tests/chat.test.ts`
   - Repo listing + casual-name resolution.
   - Read/search/path-escape protection.
   - Chat uses repo tools and carries history into the model call.
   - `start_build` resolves repo, creates workflow, and calls the runner.
   - Offline API reply + `/api/repos` + `/api/chat` persistence.

4. `Context/_inbox/2026-11-08_chat-concierge.md`
   - Domain-knowledge inbox note for the Librarian.

### Modified files

1. `src/agents/base.ts`
   - Added `ToolTraceEntry`.
   - `AgentResult.toolTrace`.
   - Added `AgentHistoryMessage`.
   - `Agent.run(..., { history })` inserts prior user/assistant turns before the
     current user message.
   - Tool executions are captured in `toolTrace`.

2. `src/api/app.ts`
   - Removed the old single-shot JSON intent classifier and its hardcoded
     actions (`check_repo_access`, `compare_repos`, `start_build`,
     `get_status`, `converse`).
   - `/api/chat` now:
     - loads history before saving the new user message
     - saves the user message
     - calls `new ChatService(settings).run(content, history)`
     - saves the assistant message with `agentRole: 'concierge'`
     - returns `{ user_message, assistant_message, workflow_id, metadata }`
     - catches agent failures and saves a human-readable error reply
   - Added `GET /api/repos`.
   - `/chat` page route passes `repos`, `repos_root`.
   - Settings POST accepts `repos_dir`.

3. `src/config.ts`
   - Added `Settings.reposDir`.
   - Added `defaultReposDir(home)`:
     - `DEV_FIRM_REPOS_DIR` wins
     - else `path.resolve(process.cwd(), '..')` if it contains git checkouts
     - else `~/Workspace` if it contains git checkouts
     - else `<home>/repos`
   - Added `repos_dir` to `applyConfig`, `configValues`, `publicDict`.

4. `views/chat.ejs`
   - Rewritten copy around natural language.
   - Repository chips (data attributes, no inline unsafe JS).
   - Examples for feature work, code questions, status, tickets, comparisons.
   - Markdown rendering in the browser:
     - fenced code blocks
     - inline code
     - bold
     - safe http(s)/relative links
     - newlines
   - Keeps polling but preserves scroll position when the user has scrolled up.

5. `views/setup.ejs`
   - New **Repositories** section with a “Local repositories folder” field.

6. `public/style.css`
   - Chat markdown styles (`code`, `pre`, links).

7. `.env.example`
   - Documented `DEV_FIRM_REPOS_DIR`.

8. `README.md`
   - New “Chat with the firm” section.
   - `DEV_FIRM_REPOS_DIR` in the environment table.

9. `ARCHITECTURE.md`
   - Presentation layer mentions the chat concierge.
   - New “Chat concierge” subsection explaining the tool agent and
     `start_build` handoff to `BuildService`.

10. `tests/api.test.ts`
    - `/chat` added to the page-render smoke test.

11. `tests/helpers.ts`
    - `DEV_FIRM_REPOS_DIR` added to managed test env and pointed at
      `<temp-home>/repos` for deterministic tests.

## Current verification status

All pass:

```bash
cd /Users/levg/Workspace/dev-firm
npm run typecheck
npm test          # 14 files, 60 tests
npm run build
```

`dist/` is gitignored and was rebuilt locally.

## Important: unrelated working-tree changes

`git status` in `/Users/levg/Workspace/dev-firm` also shows modifications that
were NOT made by this chat work:

- `agents/devops.md`
- `src/models.ts`
- `src/orchestrator/build.ts`

They appeared during the session (likely another agent/session). They were
investigated and left untouched. **Do not revert them.**

## Critical known issue / next step

### Text-emitted tool calls — FIXED (2026-11-08 follow-up)

Previously, the real-model smoke test against the configured Ollama model
(`qwen2.5-coder:14b`) returned a `repo_overview` call as final text instead of
executing it, because `src/agents/base.ts` only recovered names from a hardcoded
`KNOWN_TOOLS` set.

Fix applied:

1. Added `ToolRegistry.names()` in `src/agents/base.ts`.
2. `collectTextToolCalls()` and `extractTextToolCalls()` now accept a
   `knownTools: Set<string>` (defaulting to the legacy set for compatibility).
3. `Agent.run` derives `knownTools` from `this.tools.names()` and passes it
   through.
4. Added a regression test in `tests/chat.test.ts`
   (`recovers a text-emitted repo_overview tool call and executes it`).

Verification: real Ollama (`qwen2.5-coder:14b`) now calls `repo_overview` and
`search_repo_code` and returns a grounded answer instead of echoing JSON. All
61 tests pass; typecheck and build pass.

Recommended fix:

1. Add a `names()` method to `ToolRegistry`, e.g.:

```ts
names(): string[] {
  return [...this.tools.keys()];
}
```

2. In `Agent.run`, derive the set from the registry:

```ts
const knownTools = new Set(this.tools.names());
```

3. Pass it through:
   - `extractTextToolCalls(text, knownTools)`
   - `collectTextToolCalls(text, knownTools)`
   - `KNOWN_TOOLS.has(name)` → `knownTools.has(name)`

4. Keep the old default set for compatibility if needed.

5. Add a test where a scripted LLM returns a text tool call
   (`{"name":"repo_overview","arguments":{"repo":"career-firm"}}`) followed by a
   final answer, and assert the tool actually ran.

This is the highest-value next fix. Until then, models that use the native
function-calling API work; models that emit tool calls as text (like
`qwen2.5-coder:14b` under Ollama) will echo the JSON instead of acting.

### Clarification guard (2026-11-08 follow-up)

Observed that the model would call `start_build` (and even guess a repo) for an
ambiguous request like "Add dark mode" without asking first. Added two
protections in `src/chat/agent.ts`:

- `ChatTurnState.userMentionedRepo` records whether the user's message
  explicitly names a repo or asks for a new app.
- `start_build` now refuses (throws `RepoError`) when the user did not name a
  repo/new-app and the brief doesn't clearly signal a new app. The tool result
  tells the model to ask the user instead of guessing.
- Strengthened the system prompt (step 5) and `start_build` description to
  require clarity before acting, with an explicit ambiguous example.
- Real-model test: "Add dark mode" now yields a clarifying question instead of
  a started build.

### Secondary polish ideas

- Limit incoming chat message length before storing/sending.
- Optionally stream tool activity to the UI.
- Consider a `resume_build` or `continue_build` tool if that workflow becomes
  common.
- Consider a `clone_repo` tool if remote-only repos should be usable for builds.
  Right now `github_repo_info` only reads metadata; code/build requires a local
  checkout under `reposDir`.

## Environment knowledge cached

- Local repos:
  - `/Users/levg/Workspace/career-firm`
  - `/Users/levg/Workspace/dev-firm`
  - `/Users/levg/Workspace/niw-tracker`
- `RepoCatalog('/Users/levg/Workspace').list()` correctly returns all three with
  descriptions.
- `resolve('the career repo')` → `career-firm`.
- `search('career firm', 'headhunter')` works.
- Runtime DB: `/Users/levg/Workspace/dev-firm/data/dev.db`
  - provider in DB: `ollama`
  - model in DB: `qwen2.5-coder:14b`
  - `setup_complete = true`
- Ollama is running at `http://localhost:11434`.
- Installed tool-capable models include `qwen2.5-coder:14b`,
  `deepseek-v4.1-flash-free:latest`, `beam-free:latest`.
- `Settings.load()` alone does **not** apply stored DB settings. In the app,
  `createApp()` calls `applyStoredSettings(settings)`. If writing a standalone
  script, call `applyStoredSettings(s)` before using the provider.
- There is a `.env` in the repo that can set `DEV_FIRM_PROVIDER`; CLI/standalone
  scripts that skip `applyStoredSettings` may see offline mode because of it.

## API / DB notes

- Chat messages are in `chat_messages`; `metadata` is JSON.
- New assistant rows use `agent_role = 'concierge'`.
- `start_build` creates a normal `workflow_runs` row with
  `input.source = 'chat'` and `input.repo_path`.
- `ChatService` does not persist messages itself; `src/api/app.ts` does.
- `GET /api/repos` returns `{ root, repositories }`.
- `POST /api/chat` returns:
  ```json
  {
    "user_message": {},
    "assistant_message": "...",
    "workflow_id": 12,
    "metadata": {}
  }
  ```

## How to run

```bash
cd /Users/levg/Workspace/dev-firm
npm run dev
# open http://127.0.0.1:8766/chat
```

Settings → Repositories should show `/Users/levg/Workspace` (or whatever
`DEV_FIRM_REPOS_DIR` resolves to).
