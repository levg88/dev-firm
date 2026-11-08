# Context Inbox

Working agents drop raw session findings here. The Librarian agent (`/curate-context`) merges them into the right `Memory.md`, then deletes the inbox file. Never edit `Memory.md` files directly. A 0-byte file is treated as already processed and is ignored by the router.

## File naming

One file per session: `YYYY-MM-DD_<short-session-desc>.md`
Example: `2026-11-08-build-loop-timeout-hunt.md`

Parallel agents each write their OWN file — never append to another session's file.

## Entry format

```markdown
## [Topic: <TopicName>]
- Finding, one per bullet, with evidence (test name, log path, request id). (ollama / macOS, 2026-11-08)
- Another finding. (General)

## [Topic: <OtherTopic>]
- ... (openai / Linux, 2026-11-08)
```

Rules:
- Topic names come from `Context/ContextMapping.md` (aliases OK — the Librarian resolves them).
- **Every bullet MUST carry a `(provider / OS, date)` tag, or `(General)` if scope-independent.** Untagged findings are quarantined by the Librarian, not merged.
- Substantial domain knowledge only — no config values, NEVER secrets or credentials.
- A topic not in the map yet is fine — the Librarian creates the folder and registers it.
