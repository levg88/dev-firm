# Dev Firm

A small, local-first **boutique software development firm run by agents**. Describe an
application and an eight-role delivery team plus a fixer takes it from brief to deployed,
monitored code through a real delivery flow:

**Product Manager → Architect → Team Lead → Backend / Frontend Developers → Tech Lead → QA → DevOps**

The firm first validates the target project (typecheck, build, tests), then the product
manager writes the PRD and a task breakdown, the architect writes the design documents,
and the team lead reviews the design and routes every task to the right developer. The
developers implement and hand off to the tech lead, who rejects back to the developer or
approves to QA. QA either sends the tickets to DevOps with evidence or opens linked bugs
for another loop. DevOps owns CI/CD, deployment, monitoring, and logging. The delivery
loop repeats until QA passes or the iteration limit is reached. A separate **fixer** agent
consumes logged pipeline defects from `Bugs/_inbox/`.

The full role and autonomy model is documented in [`ARCHITECTURE.md`](ARCHITECTURE.md),
and the stage-by-stage contracts, triggers, and loops in
[`AGENTIC_WORKFLOW.md`](AGENTIC_WORKFLOW.md). Reusable cross-team instructions live in
[`skills/`](skills/README.md).

Every task and bug lives on a local **ticket board** and is mirrored to **GitHub Issues +
a GitHub Project** when sync is enabled. Every agent call and artifact is recorded in a
local SQLite database, and the produced documents and code are committed to git along the
way with a distinct author identity for each role.

> This is the development firm. The career firm (Office Manager, Headhunter, Resume
> Writer) lives separately at
> [levg88/career-firm](https://github.com/levg88/career-firm).

---

## What it does

```text
                         YOUR BRIEF
                             │
                    ┌────────▼─────────┐
                    │  Product Manager │  PRD, user stories, acceptance
                    │      agent       │  criteria + task breakdown
                    └────────┬─────────┘
                             │  creates epic + tasks, assigns architect
                    ┌────────▼─────────┐
                    │    Architect     │  stack, file plan, data model,
                    │      agent       │  interfaces, test plan
                    └────────┬─────────┘
                             │  design attached to every task
                    ┌────────▼─────────┐
                    │    Team Lead     │  design review + per-task routing
                    │      agent       │  (rejects back to architect)
                    └────────┬─────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
     ┌────────▼─────────┐          ┌────────▼─────────┐
     │ Backend Developer│          │Frontend Developer│  real files written
     │      agent       │          │      agent       │  to the workspace
     └────────┬─────────┘          └────────┬─────────┘
              └──────────────┬──────────────┘
                    ┌────────▼─────────┐
                    │     Tech Lead    │  code review against PRD/design
                    │      agent       │  reject → developer loop
                    └────────┬─────────┘
                             │ approve
                    ┌────────▼─────────┐
                    │       QA         │  acceptance checks + tests
                    │      agent       │  pass → DevOps; fail → bugs
                    └────────┬─────────┘  → team lead → developer loop
                             │ pass
                    ┌────────▼─────────┐
                    │      DevOps      │  CI/CD, deploy, health check,
                    │      agent       │  monitoring + logging
                    └────────┬─────────┘
                             │
                 ┌───────────▼────────────┐
                 │ SQLite + ticket board  │  workflows, tickets, events,
                 │ + GitHub Projects sync │  artifacts, generated files
                 └────────────────────────┘
```

### The team

| Agent | Responsibility | Output |
|---|---|---|
| **Product Manager** | Turns a rough brief into a scoped, build-ready product specification and task breakdown. | Spec, user stories, acceptance criteria, non-goals, risks, tasks |
| **Architect** | Designs the smallest implementable architecture and a concrete file plan. | Stack, file plan, data model, interfaces, test plan |
| **Team Lead** | Reviews the design, routes every task to a developer, and triages QA bugs. | Design verdict, assignments, triage notes |
| **Backend Developer** | Implements the server, data layer, API, CLI, and persistence. | Working files, tests run, implementation report |
| **Frontend Developer** | Implements the UI, templates, components, client behaviour, and styling. | Working files, tests run, implementation report |
| **Tech Lead** | Reviews delivered code against the PRD and design. Rejections go back to the developer. | Review verdict, summary, blocking issues |
| **QA** | Verifies acceptance criteria, runs the test suite, and opens structured bugs. | Pass/fail report, bugs, evidence, recommendation |
| **DevOps** | Checks build instructions, owns CI/CD, deploys verified builds, and starts monitoring/logging from app startup. | Pipeline status, deployments, health evidence, known issues |
| **Fixer** | Investigates defects logged in `Bugs/_inbox/`, finds root cause, fixes or spawns a developer, and re-runs tests. | Root cause, fixes, tests run, follow-ups |

### Delivery flow

```text
PM creates epic + tasks            → assign architect
Architect design                   → attach to tasks, assign team lead
Team lead review                   → approve + route tasks; reject → architect (max 2 rounds)
Developer implements               → assign tech lead
Tech lead review                   → reject → developer; approve → QA
QA verifies                        → pass → assign DevOps
                                   → fail → open linked bugs → team lead triage
                                             → developer → tech lead → QA ...
DevOps deploys                     → final typecheck/build/test, health check,
                                     monitoring + logging, close with evidence
```

The loop is bounded by **Max delivery iterations** (`DEV_FIRM_MAX_ITERATIONS`, default
`5`). When the limit is reached the epic is marked `blocked`, the open tickets remain on
the board, and a `blocked_report.md` is written. Bug tickets use the same delivery loop as
feature tasks.

### Ticket statuses

```text
todo → design → team_review → in_progress → in_review → qa → done
                                                   └→ blocked
```

Every transition and comment is recorded in `ticket_events`. When GitHub sync is
enabled, the same tickets are created as GitHub issues, added to a GitHub Project,
linked, commented on, moved across the project board, and closed with the evidence.

---

## Quickstart

Requirements: **Node.js 20+** and npm. No Python, no Docker.

```bash
npm install

npm run dev    # development server with auto-reload
npm start      # production server (runs the TypeScript build first)
```

Open <http://127.0.0.1:8766>. On first run a local **setup wizard** asks for your model
provider and API key. There is no config file to edit — everything is stored inside
`data/dev.db` on your machine.

Choose **Offline mode** to try the pipeline without a key. It records placeholder
artifacts instead of writing real code. A real provider gives you the full team.

### Run a build

From the web UI: **Build lab** → describe the app → **Run the build team**.

From the CLI:

```bash
npm run cli -- build "A local CLI that manages a reading list with tags and JSON export" \
  --title "Reading list" --max-iterations 5
```

The web UI adds **Max delivery iterations** and an optional **Existing repository** path to
the build form. The **Tickets** page shows the board and the full history of every task
and bug.

Each run gets its own workspace:

```text
data/
  dev.db
  runs/
    build_1/
      workspace/        # the developer writes here
  storage/
  artifacts...
```

The build page shows every agent call, token count, and artifact. The workflow runs in
the background, so the page refreshes itself until the team is done.

---

## CLI reference

```text
npm run cli -- init                          Initialise the database and data directories
npm run cli -- config                      Print effective config (no secrets)
npm run cli -- doctor                      Check provider, dependencies, and DB stats
npm run cli -- build "BRIEF" --title "T" --repo PATH --max-iterations 5
                                            Run validate → PM → architect → team lead →
                                            developers → tech lead → QA (loops until pass)
npm run cli -- serve --host 127.0.0.1 --port 8766
npm run cli -- agents --prompt team_lead   List agents / print an agent's system prompt
npm run cli -- github status               Show GitHub Projects config and verify the project
npm run cli -- github init --owner levg88 --repo career-firm --title "Career Team"
                                            Create/verify the project and enable sync
npm run cli -- github sync --run 10       Re-apply existing tickets to GitHub
```

`--home DIR` overrides the data directory for any command.

### Building out the career firm repo

Pass a repository path to run the team against an existing codebase instead of a fresh
workspace:

```bash
npm run cli -- build "Add dark mode to the career firm" \
  --title "Career firm dark mode" \
  --repo /Users/levg/Workspace/career-firm
```

The pipeline then validates the target project (typecheck, build, tests), the product
manager writes the PRD and commits it, the architect writes the design documents, the team
lead reviews and routes the tasks, the developers write the code, the tech lead reviews
against the PRD and design, QA runs the tests, and the final commit captures the new
agents, documents, code, and ticket history.

---

## Configuration

Runtime configuration lives in the local SQLite database (`app_settings` table) and is
managed from the web UI:

- **First run:** the app redirects to `/setup`.
- **Later changes:** open **Settings** in the navigation bar.

API keys are stored only in `data/dev.db`. The database is created with file mode `0600`,
and keys are sent only to the provider you select.

### Environment overrides (optional)

Environment variables are supported for headless use, CI, and tests. Once you finish the
wizard, the stored configuration takes precedence.

| Variable | Default | Purpose |
|---|---|---|
| `DEV_FIRM_PROVIDER` | auto | `openai`, `anthropic`, `ollama`, `opencode`, or `mock` |
| `DEV_FIRM_MODEL` | provider-specific | Model ID |
| `DEV_FIRM_SETUP_COMPLETE` | auto | Set `false` to force the wizard on next start |
| `OPENAI_API_KEY` | — | OpenAI or compatible provider |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint |
| `ANTHROPIC_API_KEY` | — | Native Anthropic adapter |
| `OLLAMA_BASE_URL` | `http://localhost:11434/v1` | Ollama’s OpenAI-compatible endpoint |
| `OPENCODE_API_KEY` | — | OpenCode Console API key |
| `OPENCODE_BASE_URL` | `https://opencode.ai/inference/openai/v1` | OpenCode OpenAI-compatible endpoint |
| `DEV_FIRM_TEMPERATURE` | `0.2` | Generation temperature |
| `DEV_FIRM_MAX_TOKENS` | `8192` | Per-call limit |
| `DEV_FIRM_TIMEOUT` | `600` | Provider request timeout (seconds) |
| `DEV_FIRM_MAX_STEPS` | `40` | Tool-calling loop cap |
| `DEV_FIRM_DEBUG` | — | Set to `1` to log every agent tool step to stderr |
| `DEV_FIRM_MAX_ITERATIONS` | `5` | Max delivery loops before the epic is blocked |
| `DEV_FIRM_HEURISTIC_FALLBACK` | `true` | Fall back to offline output if a model call fails |
| `DEV_FIRM_HOME` | `./data` | Database, workspaces, run artifacts |
| `DEV_FIRM_AGENTS_DIR` | `<home>/agents` | Directory of Markdown agent overrides |
| `DEV_FIRM_SKILLS_DIR` | — | Extra shared-skill override directory (highest priority) |
| `DEV_FIRM_HOST` | `127.0.0.1` | Bind address |
| `DEV_FIRM_PORT` | `8766` | Bind port |
| `DEV_FIRM_TICKET_PREFIX` | `CAREER` | Prefix for local ticket keys |
| `DEV_FIRM_GITHUB_ENABLED` | `false` | Set `true` to mirror tickets to GitHub Projects |
| `GITHUB_OWNER` | `levg88` | GitHub user or organisation that owns the project |
| `GITHUB_REPO` | `career-firm` | Repository that receives issues |
| `GITHUB_PROJECT_TITLE` | `Career Team` | Project title looked up or created |
| `GITHUB_PROJECT_NUMBER` | `0` | Project number; `0` finds it by title |
| `GITHUB_DEFAULT_ASSIGNEE` | — | Optional GitHub login for issue assignment |
| `GITHUB_ASSIGNEES_JSON` | `{}` | Optional role → GitHub login map |
| `GITHUB_TOKEN` | — | Optional token; otherwise the logged-in `gh` CLI is used |
| `DEV_FIRM_GITHUB_AUTO_CREATE` | `true` | Create the project if it does not exist |

Provider behaviour:

- **OpenAI-compatible** covers OpenAI, Ollama, OpenRouter, vLLM, and similar.
- **Anthropic** uses the native Messages API with tool use.
- **Ollama** uses its OpenAI-compatible endpoint; no API key is required.
- **OpenCode** uses `https://opencode.ai/inference/openai/v1` with an `OPENCODE_API_KEY`.
  It works with paid models and the free chat models listed on
  [OpenCode Console](https://opencode.ai/console/org_01M6P7F9TJB9G4V26SYSZZ1J8Z/models)
  (e.g. `deepseek-v4.1-flash-free`, `glm-5.3-flash-free`, `big-pickle`,
  `nemotron-3.5-super-vl-free`). Free-tier chat models may be restricted to the
  OpenCode client; if a free model rejects requests from here, switch to a paid model
  or Ollama.
- **Offline mode** is fully local and deterministic.
- If a provider is selected but its key is missing, the app degrades to offline mode with
  a visible banner instead of crashing.

### GitHub Projects task tracking

The local ticket board is always available. To mirror it to GitHub Issues and a GitHub
Project, authenticate the `gh` CLI with project access, then enable sync:

```bash
gh auth refresh -s project
npm run cli -- github init --owner levg88 --repo career-firm --title "Career Team"
```

`github init` verifies the project or creates it if it is missing, links it to the
repository, and saves the configuration. During a build the firm:

- creates an issue for the epic and one issue per product task;
- adds every issue to the project and moves its **Status** field through
  `Todo → In Progress → Done`;
- attaches the design as issue comments and records every assignment, review, bug, and
  QA transition as a role-prefixed comment;
- links QA bugs to their parent task;
- closes issues with the QA evidence when the build passes.

GitHub sync is best-effort: a failure is recorded on the ticket as a sync warning and
never blocks the local delivery loop. The local SQLite board remains the source of truth.

**Token note:** a fine-grained token can create issues and comments but may not have
access to user-owned Projects v2 (GitHub returns `user.projectV2` or
`createProjectV2`). In that case the firm keeps using the supplied token for issue work
and falls back to the authenticated `gh` CLI login for project-only commands. A classic
token with the `project` scope can be stored instead if you want one credential for
everything.

#### Identity model

Agents are not GitHub users, so the firm avoids impersonation:

- **Commits** use a distinct local git author and committer per role
  (`Dev Firm Architect <architect@dev-firm.local>`, `Dev Firm QA <qa@dev-firm.local>`,
  and so on) via `git -c user.name=... -c user.email=...`.
- **Issues** carry `type:<type>`, `role:<assignee>`, and `area:<area>` labels plus
  `**Reported by:**` / `**Assignee:**` lines in the body.
- **Comments** are prefixed with the actor role, e.g. `**qa**` or `**team_lead**`.
- **Assignment** is optional. Set `GITHUB_DEFAULT_ASSIGNEE` or `GITHUB_ASSIGNEES_JSON`
  (for example `{"backend_developer":"levg88"}`) only if you want real GitHub accounts
  assigned. Otherwise the issue stays unassigned and the role labels carry ownership.

---

## Workspace and tools

The developer and QA agents receive four workspace-scoped tools:

- `write_file` / `read_file` / `list_files`
- `run_command` with a small allowlist (`pytest`, `python`, `pip`, `ls`, `cat`, `grep`,
  `rg`, `find`, `node`, `npm`, `pnpm`, `yarn`)

Paths are resolved inside the run workspace; `..` escapes are rejected. This is an
**isolation convenience, not a hardened security boundary** — it keeps agents from
touching the rest of your machine, but run only code you trust.

---

## Data model

SQLite (`data/dev.db`):

| Table | Contents |
|---|---|
| `workflow_runs` | Build runs, status, brief, workspace path, error |
| `agent_runs` | Role, provider, model, tokens, input/output audit |
| `artifacts` | Product specs, architecture, design reviews, bug triage, developer/QA reports, ticket snapshots |
| `tickets` | Local mirror of tasks, bugs, epics, statuses, assignees, links, GitHub issue keys/URLs, evidence |
| `ticket_events` | Every transition, assignment, comment, link, and closing evidence |
| `app_settings` | Provider, model, base URLs, keys, GitHub config, iteration limit, defaults |

Artifacts are also linked to the files in each run workspace. Files never leave your
machine unless your configured model provider receives the prompt.

---

## Extending

Agent identity, prompts, task templates, and sampling parameters live in Markdown
files under `agents/`. They are loaded at runtime, so editing one changes the next
agent run without a rebuild. The TypeScript modules under `src/agents/` only build
each task and wire the runtime.

```text
agents/
  product-manager.md      PM (spec + task breakdown)
  architect.md            design
  team-lead.md            design review + task routing
  team-lead-triage.md     QA bug triage
  backend-developer.md    backend developer
  frontend-developer.md   frontend developer
  tech-lead.md            code review
  qa.md                   verification
  devops.md               CI/CD + deployment
  fixer.md                bug investigation + fix
  README.md               file format and override rules

skills/
  <id>/SKILL.md           reusable instructions shared by agents
  README.md               format, targeting, resolution, current matrix
src/agents/
  definitions.ts      Markdown loader (frontmatter, sections, overrides)
  skills.ts           shared-skill loader + system-prompt injection
  schema.ts           maps `schema:` names to Zod contracts
  product_manager.ts  PM wrapper
  architect.ts        design wrapper
  team_lead.ts        design review, task routing, bug triage
  developer.ts        backend/frontend developer wrapper (parameterised)
  tech_lead.ts        code review wrapper
  qa.ts               verification wrapper
  devops.ts           deployment wrapper
  build_team.ts       facade used by the pipeline
  build_schemas.ts    zod contracts between roles
  base.ts             shared Agent / AgentSpec runtime
  runner.ts           schema validation, retries, audit logging
  tools.ts            sandboxed file and command tools

tracker/
  types.ts            tracker interface and ticket types
  local.ts            SQLite ticket mirror, transitions, events
  github.ts           GitHub Issues + Projects sync adapter (gh CLI)
  index.ts            createTracker(settings)
```

To add a role:

1. Add `agents/<name>.md` with frontmatter and `# System Prompt` / `# Task` sections
   (see `agents/README.md`).
2. Create `src/agents/<name>.ts` with a class that loads the definition, renders its
   task template, and calls `runAgent(...)`.
3. Export it from `src/agents/index.ts`.
4. Wire it into `BuildAgents` and `BuildService`.

To change a prompt without touching code, edit the `.md` file. To override an agent
per installation, drop a same-named file in `<home>/agents` (or set
`DEV_FIRM_AGENTS_DIR`); it replaces the bundled definition by `id`.

To add a shared skill, create `skills/<id>/SKILL.md` and target agents with its
`agents:` frontmatter (or opt in from an agent's `skills:` field). Skills are
resolved at load time and appended to the system prompt. Override a skill by
dropping a same-id folder in `<home>/skills` or `DEV_FIRM_SKILLS_DIR`.

### Add a provider

Implement `complete(...)` on an `LLMClient` subclass in `src/llm/`, normalize tool calls to
`ToolCall`, and register it in `buildLlm` (`src/llm/index.ts`).

---

## Security and privacy

- Local-only by default: binds to `127.0.0.1`.
- No telemetry, no analytics, no external asset CDNs.
- Provider keys live only in the local SQLite database (`data/dev.db`, mode `0600`) and
  are sent only to the provider you configure. The UI masks them after saving.
- The sandbox rejects path escapes and restricts commands to an allowlist.
- Data at rest is otherwise unencrypted. Use full-disk encryption and back up `data/` if
  needed.
- Sending prompts to a cloud model provider is your choice; use Ollama for a fully local
  setup.

---

## Tests

```bash
npm test
```

Covered: the mock SDLC pipeline (epic/task creation through closing evidence), the local
ticket tracker (transitions, bug links, event history), the agent tool-calling loop, JSON
repair, loose schema coercion for tasks/bugs/design reviews, sandbox guards, SQLite
round-trips, the startup setup wizard and config persistence, and the web routes (build
creation, status polling, audit pages, ticket board, and ticket detail).

---

## Limitations

- **Single user:** no authentication or multi-tenant isolation. Do not expose the server
  to untrusted networks.
- **Model quality matters:** with a small or offline model, expect partial implementations.
  The QA pass and test run are the safety net; always review the generated code.
- **Bounded loops:** the delivery loop stops at the configured iteration limit and leaves
  a `blocked` epic plus open tickets for a human to inspect. It does not retry forever.
- **GitHub sync is best-effort:** local tickets are the source of truth during a run; a
  GitHub outage or missing `project` scope shows as a sync warning rather than failing the
  build. Run `gh auth refresh -s project` once to grant access.
- **No deployment:** the firm writes code and runs tests. Building containers, deploying,
  or provisioning infrastructure is out of scope.
- **Workspace size:** builds are intended for small local-first applications.

---

## License

MIT.
