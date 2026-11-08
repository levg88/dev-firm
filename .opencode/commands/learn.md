---
description: Learn a source into the Context/ knowledge base — acquire + extract, then curate
---

Run the full context learning loop for: $ARGUMENTS

1. Use the `context-learner` subagent with the source above and any topic hint. It classifies the source, reads `Context/ContextMapping.md`, retrieves and condenses the content, stages tagged findings to `Context/_inbox/`, and may write a dated mirror next to a topic's `Memory.md`.
2. Check `Context/_inbox/` for `.md` files other than `README.md`. If the learner staged nothing (retrieval failed or the content was already known), relay its report and stop.
3. Otherwise use the `context-librarian` subagent to process all inbox files, exactly as `/curate-context` does.
4. Relay the combined report: what the learner acquired (source, topics, inbox file, mirror path) and what the librarian merged (facts added/updated, topics created, flagged items).
