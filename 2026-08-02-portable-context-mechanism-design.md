# Portable Context Management Mechanism — Design

> Date: 2026-08-02
> Purpose: specify the `Context/` agent knowledge-base mechanism (as built in ESC_CareAutomation4US) in a project-agnostic form, so it can be installed on any repo by an implementer who fills in project-specific values.

## Problem

Agents working in a repo re-learn the same domain facts every session: how the hardware behaves, which environment means what, why a test fails for a non-code reason. That knowledge is not in the code, not in git history, and not in the README. Each session pays to rediscover it, and each session's discovery dies with the session.

A knowledge base alone does not fix this. Two things break it:

1. **Nobody reads it.** Agents grep first. The knowledge base must be forced into the path *before* exploration.
2. **Everybody writes it.** Parallel agents editing the same knowledge files produce duplicates, contradictions, and drift.

This design solves both: a router that injects the relevant knowledge paths on every prompt, and a single-writer curation pipeline.

## Non-goals

- Not a code-structure map. Code relationships belong in a code graph or generated docs.
- Not a config store. Values live in the project's config files.
- Not a secrets store. Never.
- Not a session log or changelog.

## Deliverable

A phased implementation plan. Every artifact is given in full content. Project-specific values appear as `<FILL: ...>` placeholders, declared once and reused throughout. The implementer does not need access to the source repo.

### Placeholder set

| Placeholder | Meaning | Example (this repo) |
|---|---|---|
| `<FILL: PROJECT_NAME>` | Repo/solution name used in agent prompts | `ESC_CareAutomation4US` |
| `<FILL: DOMAIN>` | One line: what knowledge this base holds | "hardware panels, RF peripherals, protocols, lab stations, environments" |
| `<FILL: KB_ROOT>` | Knowledge base root dir | `Context/` |
| `<FILL: SCOPE_AXIS>` | The dimension along which a fact may be true here but not there | `Station / Bin` |
| `<FILL: TOPICS>` | Rows of the topic table: Topic, Aliases, Path | see topic table |
| `<FILL: EXTERNAL_SOURCES>` | Knowledge whose canonical home is NOT the KB | test guidelines, config.json, code graph |

`<FILL: SCOPE_AXIS>` may be set to `none` — see Tagging.

## Architecture

Five parts. Each has one job.

### 1. Router — `<KB_ROOT>/ContextMapping.md`

Single entry point. Contains:

- **How to use** — numbered steps: read the Overview topic first regardless of match; find your topic(s); read those `Memory.md`; write new findings to `_inbox/`; `/context <topic>` for explicit load.
- **Topic table** — `| Topic | Aliases | Path |`. Aliases are the matching surface for both humans and the hook. This table is the *only* place aliases live.
- **External sources table** — `| Topic | Canonical source |`. Tells an agent when to leave the KB.
- **Write rules** — domain knowledge only; never secrets; every fact tagged; supersede don't duplicate; all writes via `_inbox/`.

### 2. Storage — `<KB_ROOT>/<Group>/<Topic>/Memory.md`

One file per topic, grouped into folders by domain area. Every file follows `_TEMPLATE.md`:

```
> Updated: YYYY-MM-DD by <agent/human>

## Facts          — stable verified knowledge, one bullet per fact, tagged
## Gotchas        — traps, false-failure causes, timing quirks
## Pointers       — evidence files, specs, config locations (links, never copies)
## Open Questions — unverified or conflicting, awaiting confirmation
```

`Overview/Memory.md` is mandatory and special: ~30 lines of project orientation, read before any topic file, every session.

Soft size cap ~150 lines per file. Over cap → prune superseded facts, or split into a subtopic and register it.

For auth-gated external sources (SSO wikis, SharePoint), a bare URL is useless to a headless agent. Mirror the volatile content as a dated file next to the topic's `Memory.md`, link it from Pointers, and record the refresh procedure. `Memory.md` keeps the stable facts; the mirror keeps the tables.

### 3. Intake — `<KB_ROOT>/_inbox/`

Every agent that learns something writes here. Never to `Memory.md`.

- One file per session: `YYYY-MM-DD_<short-slug>.md`. Parallel agents each write their own file — never append to another's.
- Body is `## [Topic: X]` blocks, each a bullet list. Topic names come from the topic table; aliases are fine, the Librarian resolves them. Unknown topic is fine — the Librarian creates it.
- Every bullet carries a tag.
- `README.md` in this folder is the format spec and is never treated as an inbox item.

### 4. Curator — `context-librarian` agent

**The sole writer of `Memory.md` and `ContextMapping.md`.** This is the invariant that makes the whole mechanism work: no merge conflicts, no drift, dedupe happens in exactly one place.

Procedure: list inbox files → read the router → for each `[Topic: X]` block resolve topic to path (creating and registering the topic if new) → merge each bullet into the correct section → delete processed inbox files → report.

Merge rules:

| Rule | Behavior |
|---|---|
| Tagging | Untagged bullet is **not** merged — it goes to that topic's Open Questions marked `[UNTAGGED]` and is listed in the report |
| Dedupe | Fact already present → update the existing bullet (refresh date, add scope value) — never append a duplicate |
| Contradiction | Newer dated fact supersedes; unresolved conflict → both move to Open Questions with their tags |
| Promotion | Fact confirmed on 2+ distinct scope values may be re-tagged `(General)`, confirming values noted |
| Secrets | Never written; offending fragment dropped and flagged in the report |
| Size cap | Over ~150 lines → prune superseded first, then split into a subtopic and register it |
| Freshness | Update the `> Updated:` line of every file touched |

Hard limits: never runs git; never touches files outside `<KB_ROOT>`.

### 5. Acquirer — `context-learner` agent

Front half of the pipeline for *external* knowledge. Classifies the source (public URL / auth-gated doc / local file / pasted text), reads the router first so it does not re-stage known facts, retrieves via the matching path (web fetch / MCP / local read), condenses doc-type-aware into durable facts, writes a dated mirror for auth-gated sources, and stages tagged bullets to `_inbox/`.

Never writes `Memory.md`. Never runs git. Strips secrets and out-of-scope material.

### Enforcement — the GATE

Two layers, deliberately redundant.

**Instruction layer** — a block in the project's agent instruction file (`CLAUDE.md`/`AGENTS.md`):

> Before ANY other tool call (grep/glob/read on source) for a task touching `<FILL: DOMAIN>`: read `<KB_ROOT>/ContextMapping.md` FIRST. Not optional, not skippable because the question "seems like a quick grep" — grep is exactly what this gate exists to preempt.

Plus: never edit `Memory.md` directly; new findings go to `_inbox/`; at session end, if `_inbox/` is non-empty, suggest `/curate-context`.

**Hook layer** — `UserPromptSubmit` hook `context_router.py`:

Parses the topic table out of `ContextMapping.md` at run time, matches each topic name and alias against the prompt (all words of a term must appear, any order, with light plural/digit stemming), and injects the matched `Topic -> path` list plus the GATE reminder as additional context. Capped at 6 topics. A `NOISE` set suppresses aliases too generic to trigger alone (`account`, `devices`, `pipeline`, …).

Because it parses the table live, adding a topic to `ContextMapping.md` extends the hook automatically. Aliases are never duplicated into code.

### Skills

| Skill | Behavior |
|---|---|
| `/context <topic>` | Read router → resolve argument against topics **and** aliases (case-insensitive, partial) → read that `Memory.md` in full into the conversation → confirm topic/path/size. No argument → print the topic table. No match → show 5 closest. |
| `/curate-context` | Inbox empty → report and stop. Otherwise dispatch `context-librarian`, relay its report. |
| `/learn <source>` | Dispatch `context-learner`; if it staged anything, dispatch `context-librarian`; relay the combined report. |

## Data flow

```
prompt ──hook──> [Context Router] matched topic paths + GATE injected
                        │
                   agent reads ContextMapping.md → Overview/Memory.md → topic Memory.md
                        │
                   does the work; learns something new
                        │
                   writes <KB_ROOT>/_inbox/YYYY-MM-DD_slug.md  (tagged bullets)
                        │
       /curate-context ──> context-librarian ──> Memory.md + ContextMapping.md updated,
                                                 inbox file deleted
external doc ──/learn──> context-learner ──> _inbox/ (+ dated mirror) ──> context-librarian
```

## Tagging

Every bullet in `_inbox/` and every fact in `Memory.md` ends with either:

- `(<SCOPE_AXIS value>, YYYY-MM-DD)` — true in that scope, as of that date, **or**
- `(General)` — verified scope-independent.

`SCOPE_AXIS` is the project's own dimension: environment, service, tenant, OS, hardware rig, customer. If the project has no such dimension, set `<FILL: SCOPE_AXIS>` to `none` and the tag degrades to `(YYYY-MM-DD)` — date stays mandatory, `(General)` is dropped, and the Librarian's promotion rule is omitted.

Untagged is a hard failure, not a warning. The Librarian quarantines rather than merges. Without dates the base silently rots; without scope it asserts local truths as universal.

## Implementation phases

1. **Scaffold** — create `<KB_ROOT>/`, `_TEMPLATE.md`, `_inbox/README.md`, and a `ContextMapping.md` skeleton with an empty topic table.
2. **Seeding** — discovery pass over the target repo (top-level dirs, README and docs, git log subjects, any existing agent-facing docs) proposes a topic list with aliases. Implementer approves and edits. Then: one empty `Memory.md` per topic from the template, the topic table filled, the external-sources table filled, and `Overview/Memory.md` hand-written. Facts start empty on purpose — they accumulate from real sessions rather than being invented up front.
3. **Curator** — install `context-librarian`.
4. **Acquirer** — install `context-learner`.
5. **Skills** — `/context`, `/curate-context`, `/learn`.
6. **Hook** — install `context_router.py` and wire the `UserPromptSubmit` entry, merging into any existing hooks block rather than overwriting it.
7. **GATE** — add the instruction block to the project's agent instruction file.
8. **Smoke test** — see Acceptance.

## Acceptance criteria

1. A prompt containing a topic alias produces a `[Context Router]` line naming that topic's path.
2. `/context <alias>` resolves to the right topic and loads its `Memory.md`.
3. A hand-written inbox file with tagged bullets under two topics → `/curate-context` merges each bullet into the correct section of the correct `Memory.md`, updates the `> Updated:` lines, and deletes the inbox file.
4. An **untagged** bullet in that same file lands in Open Questions marked `[UNTAGGED]` and appears in the Librarian's report — and does **not** appear under Facts.
5. An inbox bullet under a topic absent from the table causes the Librarian to create the folder, the `Memory.md`, and the topic-table row.
6. `/curate-context` on an empty inbox reports "inbox empty" and changes no files.

## Optional extensions (not in scope)

Mentioned in the plan as one-liners only, for projects that need them:

- **Authoritative-source gate** — list source-of-truth files (config, schema registry) whose derivable facts are banned from `Memory.md`; the source wins on conflict.
- **Isolation topics** — quarantine topics for classes of finding that must never merge into a domain topic (e.g. defects found in a legacy codebase while studying a domain).

## Risks

| Risk | Mitigation |
|---|---|
| Topic table grows unmatched by aliases → hook stays silent | Seeding phase requires ≥2 aliases per topic; smoke test 1 checks a real alias |
| Generic aliases fire on every prompt | `NOISE` set, `MAX_TOPICS` cap |
| Agents write to `Memory.md` anyway | Stated in three places: router, template header, GATE block |
| Inbox accumulates unprocessed | Session-end nudge in the GATE block |
| Knowledge base drifts stale | Mandatory dates, supersede-don't-append, size cap forcing periodic prune |
