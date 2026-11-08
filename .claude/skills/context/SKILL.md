---
name: context
description: Load a Context/ knowledge topic into the conversation. Use when the user types /context <topic>, says "load context for X", "what do we know about X", or when a task touches a domain topic and its Memory.md is not yet loaded. No argument = list available topics.
---

# /context — Load domain knowledge topic

Argument: a topic name or alias.

## Steps

1. Read `Context/ContextMapping.md`.
2. **No argument given**: print the topic table (Topic + Aliases columns only) and stop.
3. Resolve the argument against the topic table — match topic names AND aliases, case-insensitive, partial match allowed. Multiple matches: list them and ask the user to pick.
4. Read the resolved `Memory.md` in full and summarize nothing — the content itself is now loaded context. Briefly confirm: topic, path, and how many facts and gotchas it holds.
5. If that file's Pointers section references other Memory.md files directly relevant to the current task, offer to load them too.
6. No match anywhere: say so, show the 5 closest topics, and remind the user that new topics are created by writing findings to `Context/_inbox/` (the Librarian registers them).
