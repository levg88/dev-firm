---
id: design-review
name: Design Review
description: Produce a reviewable design and challenge it before implementation.
agents: architect, team_lead, tech_lead
---

- The design document must let a reviewer answer: what is being built, which
  files change, what the interfaces are, how data is stored, how it is tested,
  and what can go wrong. If a section is missing, the design is not ready.
- Name the smallest reasonable stack and explain the trade-off. Record rejected
  alternatives and why they were rejected.
- Make ownership explicit: every file and interface belongs to one task and one
  developer role. Call out integration points between backend and frontend.
- List open questions for the team lead, each with the decision it blocks. The
  reviewer must be able to approve, reject, or ask a targeted question without
  guessing.
- Reviewers: approve only if the design is implementable as written. Reject with
  concrete, actionable issues, not style preferences. Check that every story and
  acceptance criterion maps to a design element.
- After implementation, the tech lead checks fidelity to this design as well as
  correctness. Undocumented deviations are review findings.
