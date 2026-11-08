---
name: curate-context
description: Run the Context Librarian — merge Context/_inbox/ findings into the Memory.md knowledge base. Use when the user types /curate-context, says "curate the context", "run the librarian", "merge the inbox", or at session end when Context/_inbox/ contains unprocessed findings.
---

# /curate-context — Dispatch the Context Librarian

1. Check `Context/_inbox/` for `.md` files other than `README.md`. None → report "inbox empty, nothing to curate" and stop.
2. Launch the `context-librarian` agent (Agent tool, `subagent_type: context-librarian`) with the prompt: "Process all files in Context/_inbox/ per your procedure. Report merged/flagged items."
3. Relay the Librarian's final report to the user: what was merged where, contradictions resolved, new topics created, and flagged items (untagged or secrets).
