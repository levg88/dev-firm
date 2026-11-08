---
id: error-reporting
name: Error Reporting
description: Record failures in the bug inbox so the fixer can reproduce and fix them.
agents: "*"
---

- When a command, tool call, agent run, or gate fails, capture the exact error
  before retrying: command, exit status, stderr/stdout excerpt, ticket or run id,
  and the smallest reproduction.
- Log durable defects and environment failures to `Bugs/_inbox/` using one file
  per session: `YYYY-MM-DD_<short-desc>.md`. Follow the format in
  `Bugs/_inbox/README.md`.
- Every bullet must end with `(provider / OS, YYYY-MM-DD)` or `(General)`. Include
  the evidence inline; do not paste secrets, tokens, or credentials.
- Do not retry the same failing command more than twice. After two identical
  failures, stop, log the issue with the evidence, and report the blocker.
- Never edit `Context/**/Memory.md` directly and never run git as part of error
  reporting. The fixer agent (`/fix-bugs`) owns investigation and fixes.
- If a failure is transient and already recovered, record it only if it reveals a
  real defect or a recurring trap; otherwise note it in the handoff.
