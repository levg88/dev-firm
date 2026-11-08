---
description: Load a Context/ knowledge topic into the conversation, or list available topics
---

Read `Context/ContextMapping.md`.

If `$ARGUMENTS` is empty, print the topic table (Topic and Aliases columns only) and stop.

Otherwise resolve `$ARGUMENTS` against the topic table — match topic names and aliases, case-insensitive, partial match allowed. If multiple topics match, list them and ask the user to pick. Read the resolved `Memory.md` in full into the conversation, then briefly confirm the topic, path, and the number of Facts and Gotchas it contains. If no topic matches, show the 5 closest topics and explain that new topics are created by writing findings to `Context/_inbox/` and running `/curate-context`.
