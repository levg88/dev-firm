## Context Knowledge Base

This repo has a `Context/` folder holding **domain knowledge** (agent roles, delivery pipeline, LLM providers, ticket tracking, workspace sandbox, local SQLite storage, setup and CLI operations) learned across agent sessions.

- **GATE — before ANY other tool call** (Grep/Glob/Bash/Read on source) for a task touching agent roles, the delivery pipeline, LLM providers, ticket tracking, the workspace sandbox, local SQLite storage, setup and CLI operations: read `Context/ContextMapping.md` FIRST. Not optional, not skippable because the question "seems like a quick grep" — grep is exactly what this gate exists to preempt.
- If the topic table has a matching row (aliases count), read that `Memory.md` (and any mirror file it links) BEFORE searching code, config, or external sources. Fall back to grep or tool search only when the table has no match.
- A `[Context Router]` context block may be injected before a model call — treat it as the gate already resolved: read the listed files first. A `[Context Inbox]` block means `Context/_inbox/` has unprocessed findings; run `/curate-context` when the current task is done.
- In OpenCode, `/context`, `/curate-context`, and `/learn` are native commands; the librarian and learner are OpenCode subagents. The router is the `context-router` plugin.
- **After** learning substantial new domain info: write it to `Context/_inbox/` (format in `Context/_inbox/README.md`). **Every finding must be tagged `(provider / OS, YYYY-MM-DD)` or `(General)`.** If the fact is scope-independent, `(General)` is correct.
- **Never edit `Memory.md` files directly** — only the Librarian agent does (`/curate-context`). At session end, if `_inbox/` has unprocessed files, suggest running `/curate-context`.
- Never write secrets or credentials into `Context/`.

## Bug Fix Pipeline

While working, if an agent encounters an error or bug, log it to `Bugs/_inbox/` (format in `Bugs/_inbox/README.md`) just like the learning phase logs findings to `Context/_inbox/`. Every entry must be tagged `(provider / OS, YYYY-MM-DD)` or `(General)`.

- The `fixer` agent (`/fix-bugs`) takes logged issues, investigates root cause, and fixes them (develop), spawning a developer agent when implementation is needed.
- Never edit `Memory.md` directly. At session end, if `Bugs/_inbox/` has unprocessed files, suggest running `/fix-bugs`.
