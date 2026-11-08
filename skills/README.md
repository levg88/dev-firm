# Shared skills

Skills are small, reusable instruction modules shared by several firm agents.
They keep role prompts short and make cross-team standards (acceptance criteria,
handoffs, quality gates, runtime rules, error reporting) consistent.

A skill is loaded at runtime and appended to the system prompt of every agent it
targets. No rebuild or restart is needed after editing a skill.

## Layout

```text
skills/
  acceptance-criteria/
    SKILL.md
  ticket-handoff/
    SKILL.md
  ...
```

## Format

```md
---
id: acceptance-criteria
name: Acceptance Criteria Discipline
description: How to write and verify testable acceptance criteria.
agents: "*"
---

Instructions the agent must follow.
```

| Key | Required | Meaning |
|---|---|---|
| `id` | no | Unique skill id; defaults to the folder name. |
| `name` | no | Human-readable name; defaults to `id`. |
| `description` | no | One-line summary. |
| `agents` | no | `*` (default) for every agent, or a comma-separated list of agent ids. |

The body is plain Markdown. Keep it short, imperative, and testable. Skills are
injected into the **system prompt**, so they must not contain secrets, volatile
facts, or project-specific credentials.

## How a skill is selected

A skill applies to an agent when either condition is true:

1. the skill's `agents` field contains `*` or the agent id; or
2. the agent definition lists the skill in its `skills:` frontmatter.

Agent frontmatter example:

```md
---
id: backend_developer
skills: deployment-verification
---
```

## Resolution order

Later directories override earlier ones by skill id:

1. bundled `skills/` in this repo
2. `<home>/skills` (default `data/skills`)
3. `DEV_FIRM_SKILLS_DIR` (highest priority)

The same pattern as agent overrides: copy a skill folder into an override
directory, keep the same `id`, and edit it for your installation.

## Current shared skills

| Skill | Applies to | Purpose |
|---|---|---|
| `acceptance-criteria` | all | Write and verify testable acceptance criteria. |
| `ticket-handoff` | all | Move a ticket with a complete, evidence-backed handoff. |
| `quality-gates` | developers, tech lead, QA, DevOps | Run and report the mandatory verification gates. |
| `typescript-runtime` | architect, developers, tech lead, QA, DevOps | Current Node/TypeScript/runtime constraints. |
| `clarifying-questions` | PM, architect, team lead | Ask only blocking questions; record assumptions. |
| `design-review` | architect, team lead, tech lead | Produce and challenge design documents. |
| `error-reporting` | all, including fixer | Log errors to the bug inbox for the fixer. |
| `knowledge-capture` | all | Stage durable new domain facts in `Context/_inbox/`. |

## Adding a skill

1. Create `skills/<id>/SKILL.md` with the frontmatter above.
2. Target the agents that need it (`agents: "*"` for a firm-wide standard).
3. Keep it under ~250 words and free of project-specific values.
4. Run `npm run cli -- agents --prompt <agent>` to confirm the skill appears in
   the effective system prompt.
5. Run `npm test`; `tests/skills.test.ts` covers parsing, targeting, overrides,
   and prompt injection.
