# Firm agent definitions

These Markdown files define the dev firm's agents. They are loaded at runtime by
`src/agents/definitions.ts`; editing one changes the next agent run without a
rebuild or restart.

## Format

```md
---
id: product_manager
name: Product Manager
role: product_manager
description: Turns a brief into a build-ready product spec.
schema: product_spec
workflow: build
temperature: 0.3
max_tokens: null
---

# System Prompt

You are ...

# Task

Turn this brief into a build-ready product specification:

{{brief}}
```

## Frontmatter

| Key | Required | Meaning |
|---|---|---|
| `id` | no | Unique agent id; defaults to the filename. |
| `name` | no | Human-readable name; defaults to `id`. |
| `role` | no | Audit role written to `agent_runs`; defaults to `id`. |
| `description` | no | One-line summary shown by `dev-firm agents`. |
| `schema` | no | `product_spec`, `architecture`, `design_review`, `bug_triage`, `developer_report`, `tech_lead_review`, `qa_report`, `devops_report`, or `none` (default). |
| `workflow` | no | Workflow label written to `agent_runs`; defaults to `id`. |
| `temperature` | no | Sampling temperature; defaults to `0.2`. |
| `max_tokens` | no | Per-call token cap; `null` uses the global setting. |
| `skills` | no | Comma-separated shared skill ids to opt into, in addition to skills whose `agents` field targets this agent. |

## Shared skills

Reusable instructions live in `skills/<id>/SKILL.md` and are appended to the
agent's system prompt at load time. A skill applies when its `agents` field lists
the agent id (or `*`), or when the agent's `skills` frontmatter lists the skill.
See [`skills/README.md`](../skills/README.md) for the format, resolution order,
and the current skill matrix. Editing a skill changes the next agent run without
a rebuild or restart.

## Sections

- `# System Prompt` — the role prompt. Required.
- `# Task` — the user task template. `{{name}}` placeholders are replaced with the
  values supplied by the calling agent; objects are pretty-printed as JSON. Keep
  subsection headings at `###` or deeper so they do not split the sections.

## Overrides

The loader searches the bundled `agents/` directory first, then `<home>/agents`
(default `data/agents`). A file in a later directory with the same `id` replaces the
bundled definition. `DEV_FIRM_AGENTS_DIR` changes the override directory.

## Agents

| Id | Role | Output schema |
|---|---|---|
| `product_manager` | `product_manager` | `product_spec` |
| `architect` | `architect` | `architecture` |
| `team_lead` | `team_lead` | `design_review` |
| `team_lead_triage` | `team_lead` | `bug_triage` |
| `backend_developer` | `backend_developer` | `developer_report` |
| `frontend_developer` | `frontend_developer` | `developer_report` |
| `tech_lead` | `tech_lead` | `tech_lead_review` |
| `qa` | `qa` | `qa_report` |
| `devops` | `devops` | `none` (free text) |
| `fixer` | `fixer` | `none` (free text) |

The build pipeline invokes `product_manager`, `architect`, `team_lead`,
`backend_developer`, `frontend_developer`, `tech_lead`, `qa`, and `devops`
automatically on the corresponding ticket transition. `team_lead_triage` runs
when QA opens bugs. `fixer` is a harness agent invoked by `/fix-bugs` against
`Bugs/_inbox/`.
