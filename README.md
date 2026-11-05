# Dev Firm

A small, local-first **boutique software development firm run by agents**. Describe an
application and a four-role team takes it from brief to tested code:

**Product Manager → Architect → Developer → QA**

The developer writes real files into an isolated workspace, QA runs the test suite, and
every agent call and artifact is recorded in a local SQLite database.

> This is the development firm. The career firm (Office Manager, Headhunter, Resume
> Writer) lives separately at
> [levg88/career-firm](https://github.com/levg88/career-firm).

---

## What it does

```text
                         YOUR BRIEF
                             │
                    ┌────────▼─────────┐
                    │  Product Manager │  product spec, user stories,
                    │      agent       │  acceptance criteria, non-goals, risks
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │    Architect     │  stack, file plan, data model,
                    │      agent       │  interfaces, test plan
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │    Developer     │  real files written to the
                    │      agent       │  run workspace, tests run
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │       QA         │  acceptance check, test run,
                    │      agent       │  pass/fail report + feedback loop
                    └────────┬─────────┘
                             │
                 ┌───────────▼────────────┐
                 │ SQLite + workspace     │  workflows, agent calls,
                 │ local storage          │  artifacts, generated files
                 └────────────────────────┘
```

### The team

| Agent | Responsibility | Output |
|---|---|---|
| **Product Manager** | Turns a rough brief into a scoped, build-ready product specification. | Spec, user stories, acceptance criteria, non-goals, risks |
| **Architect** | Designs the smallest implementable architecture and a concrete file plan. | Stack, file plan, data model, interfaces, test plan |
| **Developer** | Implements the app with real file and command tools inside a sandboxed workspace. | Working files, tests run, implementation report |
| **QA** | Reviews the result against the acceptance criteria and runs the test suite. | Pass/fail report, issues, recommendation |

If QA fails, the developer gets one feedback pass to fix the implementation before the
workflow finishes.

---

## Quickstart

Requirements: **Python 3.11+** (tested on 3.14), no Node, no Docker.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

dev-firm serve
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
dev-firm build "A local CLI that manages a reading list with tags and JSON export" \
  --title "Reading list"
```

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
dev-firm init                         Initialise the database and data directories
dev-firm config                       Print effective config (no secrets)
dev-firm doctor                       Check provider, dependencies, and DB stats
dev-firm build "BRIEF" [--title T]    Run PM → architect → developer → QA
dev-firm serve [--host H] [--port P]
dev-firm agents [--prompt ROLE]       List roles / print a role prompt
```

`--home DIR` overrides the data directory for any command.

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
| `DEV_FIRM_PROVIDER` | auto | `openai`, `anthropic`, `ollama`, or `mock` |
| `DEV_FIRM_MODEL` | provider-specific | Model ID |
| `DEV_FIRM_SETUP_COMPLETE` | auto | Set `false` to force the wizard on next start |
| `OPENAI_API_KEY` | — | OpenAI or compatible provider |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint |
| `ANTHROPIC_API_KEY` | — | Native Anthropic adapter |
| `OLLAMA_BASE_URL` | `http://localhost:11434/v1` | Ollama’s OpenAI-compatible endpoint |
| `DEV_FIRM_TEMPERATURE` | `0.2` | Generation temperature |
| `DEV_FIRM_MAX_TOKENS` | `8192` | Per-call limit |
| `DEV_FIRM_TIMEOUT` | `180` | Provider request timeout (seconds) |
| `DEV_FIRM_MAX_STEPS` | `16` | Tool-calling loop cap |
| `DEV_FIRM_HEURISTIC_FALLBACK` | `true` | Fall back to offline output if a model call fails |
| `DEV_FIRM_HOME` | `./data` | Database, workspaces, run artifacts |
| `DEV_FIRM_HOST` | `127.0.0.1` | Bind address |
| `DEV_FIRM_PORT` | `8766` | Bind port |

Provider behaviour:

- **OpenAI-compatible** covers OpenAI, Ollama, OpenRouter, vLLM, and similar.
- **Anthropic** uses the native Messages API with tool use.
- **Ollama** uses its OpenAI-compatible endpoint; no API key is required.
- **Offline mode** is fully local and deterministic.
- If a provider is selected but its key is missing, the app degrades to offline mode with
  a visible banner instead of crashing.

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
| `artifacts` | Product specs, architecture, developer reports, QA reports |
| `app_settings` | Provider, model, base URLs, keys, defaults saved by the setup wizard |

Artifacts are also linked to the files in each run workspace. Files never leave your
machine unless your configured model provider receives the prompt.

---

## Extending

Each agent lives in its own package under `src/dev_firm/agents/`:

```text
agents/
  product_manager/  agent.py
  architect/        agent.py
  developer/        agent.py
  qa/               agent.py
  build_team.py     facade used by the pipeline
  build_schemas.py  Pydantic contracts between roles
  base.py           shared Agent / AgentSpec runtime
  runner.py         schema validation, retries, audit logging
  tools.py          sandboxed file and command tools
  prompts.py        system prompts for every role
```

To add a role:

1. Add a prompt in `src/dev_firm/agents/prompts.py`.
2. Create `src/dev_firm/agents/<name>/agent.py` with a class that wraps
   `Agent` + `run_agent(...)`.
3. Export it from the package `__init__.py` and from `agents/__init__.py`.
4. Wire it into `BuildAgents` and `BuildService`.

### Add a provider

Implement `LLMClient.complete(...)` in `src/dev_firm/llm/`, normalize tool calls to
`ToolCall`, and register it in `build_llm`.

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
pytest -q
```

Covered: the build pipeline, the agent tool-calling loop, JSON repair, sandbox guards,
SQLite round-trips, the QA report model, the startup setup wizard and config persistence,
and the web routes (build creation, status polling, and audit pages).

---

## Limitations

- **Single user:** no authentication or multi-tenant isolation. Do not expose the server
  to untrusted networks.
- **Model quality matters:** with a small or offline model, expect partial implementations.
  The QA pass and test run are the safety net; always review the generated code.
- **No deployment:** the firm writes code and runs tests. Building containers, deploying,
  or provisioning infrastructure is out of scope.
- **Workspace size:** builds are intended for small local-first applications.

---

## License

MIT.
