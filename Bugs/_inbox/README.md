# Bug Inbox

Working agents log errors/bugs here while they work, analogous to `Context/_inbox/`.
The Fixer agent (`/fix-bugs`) investigates and fixes them, then cleans processed files.
Never edit `Memory.md` files directly.

## File naming

One file per session: `YYYY-MM-DD_<short-desc>.md`

Parallel agents each write their OWN file — never append to another session's file.

## Entry format

```markdown
## [Issue: <short title>]
- Error/bug description, with evidence (test name, log path, request id, stack trace). (provider / OS, YYYY-MM-DD)
- Reproduction steps or context. (General)
```

Rules:
- Every bullet MUST carry a `(provider / OS, date)` tag, or `(General)`.
- Include enough evidence to investigate.
- A 0-byte file is treated as already processed.
