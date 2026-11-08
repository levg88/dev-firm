---
id: knowledge-capture
name: Knowledge Capture
description: Stage new durable domain knowledge in Context/_inbox for the librarian.
agents: "*"
---

- When you learn a durable, reusable fact about the domain, the platform, an
  integration, or a recurring trap, stage it for the knowledge base instead of
  keeping it in the chat or silently changing code.
- Read `Context/ContextMapping.md` first. If the topic already has a `Memory.md`,
  read it so you do not re-stage a known fact.
- Write `Context/_inbox/YYYY-MM-DD_<short-slug>.md` in the format from
  `Context/_inbox/README.md`: one `## [Topic: X]` block per topic, with short
  bullets.
- Every bullet must end with `(provider / OS, YYYY-MM-DD)` or `(General)`. Use
  `(General)` only for verified, scope-independent facts.
- Never edit `Context/**/Memory.md` or `ContextMapping.md` directly; the
  context librarian owns them and merges the inbox.
- Never write secrets, tokens, credentials, or volatile config values into
  `Context/`. Point to the canonical config file instead.
- If there is no durable new fact, write nothing. Do not stage task chatter.
