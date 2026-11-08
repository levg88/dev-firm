---
id: acceptance-criteria
name: Acceptance Criteria Discipline
description: Write, groom, and verify small testable acceptance criteria.
agents: "*"
---

- Never accept a vague request. Restate it as a concrete outcome for a named
  user, then derive acceptance criteria a tester can execute.
- Every story, task, or bug you touch must have at least one acceptance
  criterion in Given/When/Then or a numbered, observable form. Reject or rewrite
  criteria such as "works well", "fast", or "handles errors" unless they state
  the trigger, the observable result, and the boundary.
- Keep criteria independent, small, and verifiable by a command, an API call, or
  a UI action. One criterion = one behaviour.
- Preserve traceability: task -> story -> epic -> product requirement. If you
  cannot point to the parent requirement, flag the gap instead of inventing it.
- When you verify, check each criterion individually and cite the evidence
  (command, output, test name, or file). A pass without evidence is not a pass.
- If a criterion is ambiguous, record the assumption you chose and the question
  that would remove the ambiguity.
