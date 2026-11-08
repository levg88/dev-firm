---
id: quality-gates
name: Quality Gates
description: Mandatory verification before any implementation handoff or release.
agents: backend_developer, frontend_developer, tech_lead, qa, devops
---

- Before handing work to the tech lead, run, in this order:
  1. `npm install` (when dependencies changed)
  2. `npm run typecheck`
  3. `npm test`
  4. `npm run build` when a build script exists
- Report the exact commands and their outcome. If a command cannot run, say why
  and treat the gate as failed. Do not substitute "should work" for evidence.
- Never leave a broken manifest or lockfile. If install fails, fix the
  dependency or version constraint and retry once; then report the exact error.
- No `TODO`, placeholder, mock-only, or commented-out implementation may pass a
  gate unless the acceptance criteria explicitly defer it and the deferral is
  recorded in the report.
- Tests must cover the acceptance criteria, not incidental implementation
  details. A test that only asserts "no error" does not prove the behaviour.
- The tech lead and QA re-run or independently confirm the same gates. A green
  developer claim is not evidence by itself.
