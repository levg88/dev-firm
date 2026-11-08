---
name: learn
description: Learn a knowledge source into the Context/ knowledge base — one command runs the full loop (acquire + extract, then curate). Use when the user types /learn <source>, says "learn this", "learn <URL>", "learn this doc", "ingest this doc", or "add this to the knowledge base". Handles auth-gated docs, public URLs, and local files.
---

# /learn — Acquire a source and fold it into the knowledge base

Argument: a source reference — a URL, a document name or link, a local file path, or pasted text.

## Steps

1. Launch the `context-learner` agent (Agent tool, `subagent_type: context-learner`) with the source and any topic hint. It classifies the source, applies the GATE (`Context/ContextMapping.md`), retrieves the content, condenses it, and stages findings to `Context/_inbox/` — plus a dated mirror next to the topic's `Memory.md` for auth-gated sources.
2. Check `Context/_inbox/` for `.md` files other than `README.md`. If the learner staged nothing (retrieval failed, or the content was already known), relay its report and stop.
3. Otherwise launch the `context-librarian` agent (Agent tool, `subagent_type: context-librarian`) with the prompt: "Process all files in Context/_inbox/ per your procedure. Report merged/flagged items." — same as `/curate-context`.
4. Relay the combined report: what the learner acquired (source, topics, inbox file, mirror path) and what the Librarian merged (facts added/updated, topics created, flagged items).
