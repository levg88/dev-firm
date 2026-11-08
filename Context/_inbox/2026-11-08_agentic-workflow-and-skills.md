## [Topic: Overview]

- Dev Firm's delivery team has eight roles: Product Manager, Architect, Team Lead, Backend Developer, Frontend Developer, Tech Lead, QA, and DevOps; a separate Fixer agent handles firm-level defects. (General)
- The architecture is documented in `ARCHITECTURE.md` and the stage/trigger/loop contracts in `AGENTIC_WORKFLOW.md`. (General)

## [Topic: Firm Agents]

- Agents are stateless workers; the orchestrator starts each one on a ticket-status trigger and holds workflow state. (General)
- Agents share reusable instructions from `skills/<id>/SKILL.md`; a skill applies via its `agents:` frontmatter (`*` or a list) or an agent's `skills:` frontmatter. (General)
- Skill resolution order is bundled `skills/`, then `<home>/skills`, then `DEV_FIRM_SKILLS_DIR`; later directories override by id. (General)
- `src/agents/skills.ts` loads skills and appends them to the agent system prompt through `systemPromptFor(...)`; `agentFromDefinition` uses it. (General)
- Current shared skills: acceptance-criteria, ticket-handoff, quality-gates, typescript-runtime, clarifying-questions, design-review, error-reporting, knowledge-capture. (General)

## [Topic: Delivery Pipeline]

- Trigger states: workflow created -> PM; spec/design -> architect; `team_review` -> team lead; `in_progress` -> developer; `in_review` -> tech lead; `qa` -> QA; QA pass -> DevOps; QA fail -> team-lead triage. (General)
- Design review is bounded to 2 rounds; delivery is bounded by `DEV_FIRM_MAX_ITERATIONS`; tool steps by `DEV_FIRM_MAX_STEPS`; repeated identical command failures stop after 2 attempts. (General)
- Firm/pipeline errors belong in `Bugs/_inbox/` for the Fixer; product acceptance defects stay as linked tickets in the delivery loop. The orchestrator appends its own stage/fatal failures to the inbox deterministically via `src/orchestrator/buglog.ts`. (General)
