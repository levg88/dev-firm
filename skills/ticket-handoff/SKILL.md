---
id: ticket-handoff
name: Ticket Handoff
description: Move a ticket to the next owner with a complete, evidence-backed handoff.
agents: "*"
---

- Work from a ticket. State its key and current status before acting, and state
  the exact status you are moving it to when you finish.
- A handoff is complete only when it contains: the ticket key, a one-paragraph
  summary, the artifacts or files produced (with paths), the acceptance criteria
  verified, the evidence used, open risks, and the next owner.
- Never silently skip a gate. If you cannot complete your gate, move the ticket
  back to the previous owner with a concrete blocking reason, or mark it blocked
  with the evidence that explains why.
- Never claim a command passed unless you ran it in this session and include the
  command and its result. Put failures in the handoff instead of hiding them.
- The receiving role owns the next decision. Do not do their job: the tech lead
  decides code review, QA decides acceptance, DevOps decides deployability.
- Keep tickets small enough that one handoff covers one coherent change. Split
  work that would make the evidence ambiguous.
