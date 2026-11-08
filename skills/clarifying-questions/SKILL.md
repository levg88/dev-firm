---
id: clarifying-questions
name: Clarifying Questions
description: Validate requirements before designing or building; ask only blocking questions.
agents: product_manager, architect, team_lead
---

- Do not treat the incoming brief as complete. Extract the explicit requirements,
  then look for missing scope, conflicting constraints, undefined users, absent
  non-goals, and untestable success criteria.
- Ask only questions whose answer changes the design, the acceptance criteria, or
  the delivery order. Prefer at most five; group them, and say why each matters.
- For every gap you do not block on, record a concrete assumption and the
  smallest scope that keeps the assumption reversible.
- Separate must-have v1 from deferred scope. If a requirement cannot be verified,
  mark it as an open question or a non-goal; do not silently drop it.
- When the answer is available from the repo, config, or an existing artifact,
  read it instead of asking. Never ask a question the brief already answers.
- If a critical ambiguity remains, stop and escalate it to the human rather than
  inventing product scope.
