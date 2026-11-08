# Portable Context Management Mechanism — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install a durable agent knowledge base on any repo — a router that forces the knowledge into the agent's path before it explores, and a single-writer curation pipeline that keeps the knowledge from drifting.

**Architecture:** Five parts. A router file (`ContextMapping.md`) holds one topic→aliases→path table. Per-topic `Memory.md` files hold the knowledge. An `_inbox/` folder receives raw findings from any agent. One curator agent (`context-librarian`) is the sole writer of `Memory.md` and the router. One acquirer agent (`context-learner`) pulls outside documents into the inbox. Enforcement is two redundant layers: an instruction block in the repo's agent instruction file, and a `UserPromptSubmit` hook that parses the topic table live and injects matched paths.

**Tech Stack:** Markdown files, Claude Code subagent definitions (`.claude/agents/*.md`), Claude Code skills (`.claude/skills/*/SKILL.md`), one Python 3 hook script (stdlib only — `json`, `re`, `sys`), `.claude/settings.json`.

**Source spec:** `docs/superpowers/specs/2026-08-02-portable-context-mechanism-design.md`

---

## Global Constraints

- **Placeholders.** Six values are project-specific and appear as `<FILL: NAME>` throughout. Task 1 records the decided values in one place; every later task substitutes them. Never ship a file with a literal `<FILL:` string in it.
  - `<FILL: PROJECT_NAME>` — repo or solution name, used inside agent prompts. Example: `AcmePayments`.
  - `<FILL: DOMAIN>` — one line naming the knowledge this base holds. Example: `payment rails, PSP integrations, sandbox environments, release trains`.
  - `<FILL: KB_ROOT>` — knowledge base root directory, trailing slash. Default and recommended: `Context/`.
  - `<FILL: SCOPE_AXIS>` — the axis along which a fact may be true here but not there. Example: `Env / Service`. Set to the literal word `none` if the project has no such axis.
  - `<FILL: TOPICS>` — the topic table rows. Decided in Task 2.
  - `<FILL: AGENT_INSTRUCTION_FILE>` — the repo's agent instruction file. `CLAUDE.md` for Claude Code, `AGENTS.md` for others.
- **Tag format.** Every knowledge bullet ends with `(<scope value>, YYYY-MM-DD)` or `(General)`. When `<FILL: SCOPE_AXIS>` is `none`, the format is `(YYYY-MM-DD)` only, `(General)` is not used, and the librarian's promotion rule is omitted. Pick one form in Task 1 and use it verbatim everywhere.
- **Single writer.** Only `context-librarian` writes `Memory.md` files and `ContextMapping.md`. Every other actor writes to `<FILL: KB_ROOT>_inbox/` only. No task may weaken this.
- **No secrets.** No passwords, tokens, connection strings, or credentials anywhere under `<FILL: KB_ROOT>`.
- **Python.** The hook uses Python 3 standard library only. No third-party imports, no network access, no file writes.
- **Git.** Neither agent runs git. The hook never runs git.
- **Commits.** Commit at the end of every task. Never commit a `.claude/settings.local.json`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `<FILL: KB_ROOT>ContextMapping.md` | Router: how-to-use steps, topic table, external-sources table, write rules |
| `<FILL: KB_ROOT>_TEMPLATE.md` | The four-section skeleton every `Memory.md` copies |
| `<FILL: KB_ROOT>_inbox/README.md` | Intake format spec; never treated as an inbox item |
| `<FILL: KB_ROOT>Overview/Memory.md` | Project orientation, read every session regardless of topic match |
| `<FILL: KB_ROOT><Group>/<Topic>/Memory.md` | One knowledge file per topic |
| `.claude/agents/context-librarian.md` | Sole writer. Merge rules live here |
| `.claude/agents/context-learner.md` | Outside-source acquirer. Writes inbox + mirrors only |
| `.claude/skills/context/SKILL.md` | `/context <topic>` — load one topic |
| `.claude/skills/curate-context/SKILL.md` | `/curate-context` — dispatch the librarian |
| `.claude/skills/learn/SKILL.md` | `/learn <source>` — learner then librarian |
| `.claude/hooks/context_router.py` | Parses the topic table, matches the prompt, injects paths |
| `.claude/settings.json` | Wires the `UserPromptSubmit` hook |
| `<FILL: AGENT_INSTRUCTION_FILE>` | The instruction-layer GATE block |

Ordering constraint: the hook (Task 6) needs a populated topic table, and the table needs seeded topics (Task 2). Do not reorder Tasks 1, 2, 6.

---

### Task 1: Scaffold and decide the placeholders

**Files:**
- Create: `<FILL: KB_ROOT>_TEMPLATE.md`
- Create: `<FILL: KB_ROOT>_inbox/README.md`
- Create: `<FILL: KB_ROOT>ContextMapping.md` (skeleton, table filled in Task 2)

**Interfaces:**
- Consumes: nothing.
- Produces: the decided placeholder values (recorded in the commit message and in `ContextMapping.md`'s header); the tag format string used by every later task; `_TEMPLATE.md` as the copy source for every `Memory.md`.

- [ ] **Step 1: Decide and write down the six placeholder values**

Answer these in one place before touching a file. Put the answers in a scratch note — you will paste them into files repeatedly.

```
PROJECT_NAME            = ?      # repo/solution name
DOMAIN                  = ?      # one line: what knowledge this base holds
KB_ROOT                 = Context/
SCOPE_AXIS              = ?      # e.g. "Env / Service", or the word: none
AGENT_INSTRUCTION_FILE  = ?      # CLAUDE.md or AGENTS.md
TOPICS                  = (Task 2)
```

Then derive the tag format string, and use exactly this string for the rest of the plan:

- `SCOPE_AXIS` is a real axis → tag format is `(<scope value>, YYYY-MM-DD)` or `(General)`.
- `SCOPE_AXIS` is `none` → tag format is `(YYYY-MM-DD)`. Drop `(General)` and drop the promotion rule wherever this plan mentions them.

- [ ] **Step 2: Create the directories**

```bash
mkdir -p Context/_inbox Context/Overview
```

If `KB_ROOT` is not `Context/`, substitute it here and in every path below.

- [ ] **Step 3: Write the memory template**

Create `Context/_TEMPLATE.md`:

```markdown
# <Topic> — Memory

> Updated: YYYY-MM-DD by <agent/human>.
> Read via `Context/ContextMapping.md`. Do NOT edit this file directly — drop findings in `Context/_inbox/` and let the Librarian merge them.
> Every fact MUST end with a tag: `(<FILL: SCOPE_AXIS> value, YYYY-MM-DD)` — e.g. `(prod / billing-api, 2026-08-03)` — or `(General)` if verified scope-independent.

## Facts
<!-- Stable, verified knowledge. One bullet per fact. Tagged. -->

## Gotchas
<!-- Traps, false-failure causes, timing quirks. Tagged. -->

## Pointers
<!-- Evidence files, specs, config locations. Links, never copies of config values. -->

## Open Questions
<!-- Unverified or conflicting info awaiting confirmation. Tagged. -->
```

Substitute `<FILL: SCOPE_AXIS>` and replace the example with one from your own project. If `SCOPE_AXIS` is `none`, the third line reads: `> Every fact MUST end with a date tag: (YYYY-MM-DD).`

- [ ] **Step 4: Write the inbox format spec**

Create `Context/_inbox/README.md`:

```markdown
# Context Inbox

Working agents drop raw session findings here. The Librarian agent (`/curate-context`) merges them into the right `Memory.md`, then deletes the inbox file. Never edit `Memory.md` files directly.

## File naming

One file per session: `YYYY-MM-DD_<short-session-desc>.md`
Example: `2026-08-03_billing-api-timeout-hunt.md`

Parallel agents each write their OWN file — never append to another session's file.

## Entry format

```markdown
## [Topic: <TopicName>]
- Finding, one per bullet, with evidence (test name, log path, request id). (prod / billing-api, 2026-08-03)
- Another finding. (General)

## [Topic: <OtherTopic>]
- ... (staging / ledger, 2026-08-03)
```

Rules:
- Topic names come from `Context/ContextMapping.md` (aliases OK — the Librarian resolves them).
- **Every bullet MUST carry a `(<FILL: SCOPE_AXIS> value, date)` tag, or `(General)` if scope-independent.** Untagged findings are quarantined by the Librarian, not merged.
- Substantial domain knowledge only — no config values, NEVER secrets or credentials.
- A topic not in the map yet is fine — the Librarian creates the folder and registers it.
```

Substitute the placeholder and the examples. If `SCOPE_AXIS` is `none`, the tag rule reads: **Every bullet MUST carry a `(YYYY-MM-DD)` tag.**

- [ ] **Step 5: Write the router skeleton**

Create `Context/ContextMapping.md`. The topic table has headers and no rows yet — Task 2 fills it.

```markdown
# ContextMapping — Agent Knowledge Router

> Single entry point for domain knowledge in this repo. Read this FIRST, then read the `Memory.md` files for the topics your task touches.

## How to use

0. **Always first — project orientation**: read `Context/Overview/Memory.md` before anything else, regardless of topic match. It says what this project is and how it is organized. Skip only if it is already in your context this session.
1. **Before a task**: find your topic(s) in the table below (aliases count). Read those `Memory.md` files.
2. **During/after a task**: learned substantial new domain info? Write it to `Context/_inbox/` (format: `_inbox/README.md`). Do NOT edit `Memory.md` directly — the Librarian agent (`/curate-context`) owns those files.
3. **Explicit load**: `/context <topic>` loads a topic's Memory.md into the conversation.

## Topic table

| Topic | Aliases | Path |
|---|---|---|

## External sources (canonical home is NOT Context/)

| Topic | Canonical source |
|---|---|

## Write rules

1. Domain knowledge only — knowledge about the code's structure belongs in generated docs or a code graph, not here.
2. **NEVER secrets or credentials** (passwords, tokens, connection strings).
3. **Every fact tagged** `(<FILL: SCOPE_AXIS> value, YYYY-MM-DD)` or `(General)`.
4. Supersede, don't append duplicates — a newer dated fact replaces an older one.
5. All writes go through `_inbox/` → Librarian. New topics: the Librarian creates the folder and registers it here.
6. **Auth-gated external sources** (SSO wikis, SharePoint): a URL pointer alone is useless to a headless agent. Mirror the content as a dated snapshot file NEXT TO the topic's `Memory.md`, link it from that file's Pointers section, and note the refresh procedure. `Memory.md` keeps the stable facts; the mirror holds the volatile tables.
```

Substitute `<FILL: SCOPE_AXIS>`. If it is `none`, rule 3 reads: **Every fact tagged** `(YYYY-MM-DD)`.

- [ ] **Step 6: Verify the scaffold**

Run:

```bash
ls -R Context
```

Expected: `ContextMapping.md`, `_TEMPLATE.md`, `_inbox/README.md`, and an empty `Overview/` directory. Then confirm no placeholder leaked:

```bash
grep -rn "FILL:" Context/
```

Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add Context/
git commit -m "feat(context): scaffold knowledge base root, template, and inbox format"
```

---

### Task 2: Seed the topic list and write the Overview

**Files:**
- Create: `<FILL: KB_ROOT>Overview/Memory.md`
- Create: one `<FILL: KB_ROOT><Group>/<Topic>/Memory.md` per seeded topic
- Modify: `<FILL: KB_ROOT>ContextMapping.md` — the topic table and external-sources table

**Interfaces:**
- Consumes: `_TEMPLATE.md` and the router skeleton from Task 1.
- Produces: a populated topic table with `| Topic | Aliases | Path |` rows — the data structure Task 6's hook parses, and the resolution table Tasks 3, 4, and 5 all read. Every topic has ≥2 aliases.

- [ ] **Step 1: Run the discovery pass**

Gather candidate topics from the repo. Facts are NOT collected here — only topic names.

```bash
ls -d */ | head -40
find . -maxdepth 2 -iname "README*" -o -maxdepth 2 -iname "*.md" | grep -iv node_modules | head -40
git log --format=%s -n 200 | sort | uniq -c | sort -rn | head -40
```

Read the top-level README and any existing agent-facing docs. From that material, write a candidate list. A good topic is a thing an agent needs *durable non-code knowledge* about: an external system, a protocol, a device, an environment, a business concept, a recurring operational process. A bad topic is a code module — that knowledge belongs in generated docs.

- [ ] **Step 2: Get the topic list approved**

Present the candidate list to the user as `Topic — aliases — proposed path`. Ask them to add, remove, and rename. Do not proceed on your own judgement: they know which topics carry knowledge that is not in the code.

Requirement: **every topic needs at least two aliases**, and at least one alias must be a phrase a person would actually type. A topic whose only alias is its own name will rarely fire the hook in Task 6.

- [ ] **Step 3: Write the Overview memory file**

Create `Context/Overview/Memory.md`. This is the one file written by hand rather than derived. Aim for 20–40 lines. It answers: what is this project, what does it produce, how is it organized, what are the three things a newcomer always gets wrong.

```markdown
# Overview — Memory

> Updated: 2026-08-03 by human.
> Read via `Context/ContextMapping.md`. Do NOT edit this file directly — drop findings in `Context/_inbox/`.

## Facts
- <FILL: PROJECT_NAME> is <one sentence: what it is and what it produces>. (General)
- It is organized as <the top-level layout an agent needs: which directory holds what>. (General)
- The knowledge in this base covers <FILL: DOMAIN>. (General)

## Gotchas
- <the thing every newcomer gets wrong>. (General)

## Pointers
- Router: `Context/ContextMapping.md`
- <canonical doc or config an agent needs early>

## Open Questions
```

Replace every angle-bracket prompt with real content. An Overview left as prompts fails the review.

- [ ] **Step 4: Create one memory file per approved topic**

For each approved topic, copy the template and set its heading:

```bash
mkdir -p Context/<Group>/<Topic>
cp Context/_TEMPLATE.md Context/<Group>/<Topic>/Memory.md
```

Then edit each new file: replace `# <Topic> — Memory` with the real topic name, and set the `> Updated:` date. Leave Facts, Gotchas, Pointers, and Open Questions empty — facts accumulate from real sessions. Seeding invented facts is how a knowledge base earns distrust.

- [ ] **Step 5: Fill the topic table**

Edit `Context/ContextMapping.md`. Add one row per topic, Overview first:

```markdown
| Topic | Aliases | Path |
|---|---|---|
| Overview | project overview, what this project is, orientation | `Context/Overview/Memory.md` |
| <Topic> | <alias>, <alias>, <alias> | `Context/<Group>/<Topic>/Memory.md` |
```

- [ ] **Step 6: Fill the external-sources table**

Same file. One row per body of knowledge whose canonical home is elsewhere — the point is to tell an agent when to *leave* the knowledge base:

```markdown
| Topic | Canonical source |
|---|---|
| Config values | `<path to the project's config file>` — the single source of truth |
| Code structure | `<generated docs or code graph, if the project has one>` |
| <other> | <path or system> |
```

Drop rows that do not apply. Do not invent a code graph the project does not have.

- [ ] **Step 7: Verify every table row resolves to a real file**

Run:

```bash
grep -oP '(?<=`)Context/[^`]+Memory\.md(?=`)' Context/ContextMapping.md | while read -r f; do
  test -f "$f" && echo "OK   $f" || echo "MISS $f"
done
```

Expected: every line starts with `OK`. Any `MISS` is a typo in the table or a missing file — fix before committing.

Then confirm the alias rule:

```bash
awk -F'|' '/^\| *Context|^\|---/ {next} /Memory\.md/ {n=split($3,a,","); if (n<2) print "TOO FEW ALIASES:" $2}' Context/ContextMapping.md
```

Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add Context/
git commit -m "feat(context): seed topic table, per-topic memory files, and project overview"
```

---

### Task 3: Install the librarian — the sole writer

**Files:**
- Create: `.claude/agents/context-librarian.md`

**Interfaces:**
- Consumes: the topic table and write rules from Task 2; the inbox format from Task 1; `_TEMPLATE.md` as the source for topics it creates.
- Produces: the `context-librarian` subagent type, dispatched by name from Task 5's `/curate-context` and `/learn` skills. Its report format (files merged, facts added/updated/superseded, new topics created, quarantined items) is what those skills relay.

- [ ] **Step 1: Write the agent definition**

Create `.claude/agents/context-librarian.md`:

```markdown
---
name: context-librarian
description: Curates the Context/ knowledge base — merges Context/_inbox/ findings into the correct Memory.md files, dedupes, resolves contradictions, prunes, and maintains ContextMapping.md. Invoke via /curate-context, or when the user says "curate the context", "run the librarian", "merge the inbox".
tools: Read, Write, Edit, Glob, Grep
---

You are the Context Librarian for <FILL: PROJECT_NAME>. You are the ONLY writer of `Context/**/Memory.md` files and `Context/ContextMapping.md`. Working agents only write to `Context/_inbox/`.

## Procedure

1. List `Context/_inbox/*.md` (skip `README.md`). If empty, report "inbox empty" and stop.
2. Read `Context/ContextMapping.md` (topic table + aliases + write rules).
3. For each inbox file, for each `## [Topic: X]` block:
   a. Resolve X to a Memory.md path via the topic table (aliases count, case-insensitive).
   b. Topic unknown? Create `Context/<best-fitting-group>/<Topic>/Memory.md` from `Context/_TEMPLATE.md` and register it in ContextMapping.md's topic table with at least two sensible aliases.
   c. Merge each bullet into the right section of that Memory.md: stable verified knowledge → Facts; traps, timing quirks, and false-failure causes → Gotchas; file/spec references → Pointers; unverified or conflicting → Open Questions.

## Merge rules (strict)

- **Tagging**: every bullet must end with `(<FILL: SCOPE_AXIS> value, YYYY-MM-DD)` or `(General)`. Untagged finding → do NOT merge; move it to that Memory.md's Open Questions with the note `[UNTAGGED — needs scope/date]` and list it in your final report.
- **Dedupe**: if the fact already exists, update the existing bullet (refresh the date, add the new scope value if a new one confirms it) — never append a duplicate.
- **Contradictions**: the newer dated fact supersedes; delete the older bullet. If the conflict is genuinely unresolved, move BOTH to Open Questions with their tags.
- **Promotion**: a fact confirmed on 2+ different scope values may be re-tagged `(General)` with the confirming values noted.
- **No secrets**: never write passwords, tokens, or connection strings. If an inbox entry contains one, drop that part and flag it in your report.
- **Size cap**: any Memory.md exceeding ~150 lines — prune stale and superseded facts first; if it is genuinely large, split it into a subtopic folder and register the subtopic in the map.
- Update the `> Updated:` line of every Memory.md you touch.

## Cleanup & report

4. Delete each fully processed inbox file. A partially processed file (one containing untagged findings you quarantined) is deleted anyway — the quarantined items now live in Open Questions.
5. Never run git. Never touch files outside `Context/`.
6. Final report: files merged, facts added / updated / superseded, new topics created, untagged or secret items flagged, size-cap actions taken.
```

Substitute `<FILL: PROJECT_NAME>` and `<FILL: SCOPE_AXIS>`. If `SCOPE_AXIS` is `none`: the tagging rule reads `(YYYY-MM-DD)`, the note becomes `[UNTAGGED — needs date]`, and **delete the Promotion rule entirely**.

- [ ] **Step 2: Verify the frontmatter and the single-writer claim**

Run:

```bash
head -5 .claude/agents/context-librarian.md
grep -c "ONLY writer" .claude/agents/context-librarian.md
grep -n "FILL:" .claude/agents/context-librarian.md
```

Expected: valid `---` frontmatter with `name: context-librarian` and a `tools:` line; the count is `1`; no `FILL:` output.

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/context-librarian.md
git commit -m "feat(context): add context-librarian, sole writer of the knowledge base"
```

---

### Task 4: Install the learner — the outside-source path

**Files:**
- Create: `.claude/agents/context-learner.md`

**Interfaces:**
- Consumes: the router's topic table (to avoid re-staging known facts); the inbox format from Task 1.
- Produces: the `context-learner` subagent type, dispatched by name from Task 5's `/learn` skill. It writes only `Context/_inbox/YYYY-MM-DD_<slug>.md` and, for auth-gated sources, a dated mirror beside the topic's `Memory.md` — the librarian from Task 3 consumes both.

- [ ] **Step 1: Write the agent definition**

Create `.claude/agents/context-learner.md`:

```markdown
---
name: context-learner
description: Acquires an external or internal knowledge source (auth-gated doc, public URL, local file, or pasted text), extracts condensed domain knowledge, and STAGES it to Context/_inbox/ (plus a dated mirror for auth-gated sources) for the Librarian to merge. Invoke via /learn, or when the user says "learn X", "learn this URL/doc", "ingest this doc", "add this to the knowledge base". Never writes Memory.md.
tools: Read, Write, Glob, Grep, WebFetch, WebSearch, ToolSearch
---

You are the Context Learner for <FILL: PROJECT_NAME>. You are the *acquire + extract* front half of the knowledge pipeline. Your only outputs are files in `Context/_inbox/` and, for auth-gated sources, a dated mirror file next to the topic's `Memory.md`. You NEVER edit any `Memory.md` or `ContextMapping.md` — the `context-librarian` agent is the sole writer of those. You never run git.

Input: a source reference (URL, doc name or link, local file path, or pasted text) plus any topic hint the caller gives.

## Procedure

1. **Classify the source**: (a) public URL, (b) auth-gated doc behind SSO, (c) local repo file, (d) pasted text. This picks the retrieval path in step 3.

2. **GATE (topic map first)**: read `Context/ContextMapping.md`. Map the source to topic(s) via the topic table (aliases count, case-insensitive). Read each matched topic's `Memory.md` so you do not re-stage facts already recorded. An unknown topic is fine — the Librarian creates it; still stage the finding under a sensible `## [Topic: X]` name.

3. **Retrieve the content**:
   - Public URL → `WebFetch`.
   - Auth-gated doc → load the relevant MCP tools via `ToolSearch`, resolve the document, and read it through that server. If `WebFetch` was attempted first and failed on auth, fall back to this.
   - Local repo file → `Read`.
   - Pasted text → use as-is.
   - **Multiple versions** of the same document: pick the newest canonical one by filename, revision, or date; state in your report which older copies you ignored.

4. **Extract — doc-type-aware and condensed.** Distill durable knowledge, not prose. Match the shape to the document: a protocol doc yields a token/command table, response semantics, message structure, and timing constants; a release doc yields version tables and dates; a hardware or integration doc yields setup, identifiers, thresholds, and traps. Otherwise: the stable facts, traps, and pointers a future agent would need. **Strip secrets, credentials, and verbatim confidential dumps** — keep the distilled facts. Do not record values that the project's own config file is the source of truth for; point to that file instead.

5. **Auth-gated source → write a dated MIRROR** next to the topic's `Memory.md`: `Context/<Group>/<Topic>/<Slug>_<version-or-date>.md`. The mirror holds the volatile tables and reference content, and MUST open with a header giving: the source URL, the retrieval method used, the capture date, and a short **refresh procedure**. Public or local sources: mirror only if the content is volatile or the source may disappear.

6. **Stage to inbox**: write `Context/_inbox/YYYY-MM-DD_<short-slug>.md` in the format from `Context/_inbox/README.md`:
   - One `## [Topic: X]` block per topic.
   - **Every bullet tagged** `(General)` or `(<FILL: SCOPE_AXIS> value, YYYY-MM-DD)`. Reference and protocol facts are usually `(General)`. Untagged bullets get quarantined by the Librarian — always tag.
   - Keep bullets stable and durable; push volatile tables into the mirror and reference it (`see mirror: <path>`).

7. **Report** to the caller: how the source was classified and which retrieval path was used, topics touched, the inbox file written, the mirror path if any, older versions ignored, and anything dropped (secrets, config-derivable values, out-of-scope material). End by stating the findings are staged and ready for the `context-librarian` to merge (`/curate-context`).

## Hard rules
- Never edit `Memory.md` or `ContextMapping.md`; never delete inbox files; never run git.
- No secrets or credentials in anything you write under `Context/`.
- Every inbox bullet carries a tag. Auth-gated content is mirrored, never left as a bare URL.
```

Substitute `<FILL: PROJECT_NAME>` and `<FILL: SCOPE_AXIS>`. If `SCOPE_AXIS` is `none`, the step-6 tag rule reads: **Every bullet tagged** `(YYYY-MM-DD)`.

- [ ] **Step 2: Verify it cannot write memory files**

Run:

```bash
grep -n "NEVER edit any \`Memory.md\`" .claude/agents/context-learner.md
grep -n "^tools:" .claude/agents/context-learner.md
grep -n "FILL:" .claude/agents/context-learner.md
```

Expected: the prohibition line is present; the `tools:` line exists; no `FILL:` output.

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/context-learner.md
git commit -m "feat(context): add context-learner for outside knowledge sources"
```

---

### Task 5: Install the three skills

**Files:**
- Create: `.claude/skills/context/SKILL.md`
- Create: `.claude/skills/curate-context/SKILL.md`
- Create: `.claude/skills/learn/SKILL.md`

**Interfaces:**
- Consumes: `context-librarian` (Task 3) and `context-learner` (Task 4) by exact subagent name; the router's topic table (Task 2) for resolution.
- Produces: the three user-facing commands `/context <topic>`, `/curate-context`, `/learn <source>`. Task 7's GATE block references `/curate-context` by name, and Task 8 smoke-tests `/context` and `/curate-context`.

- [ ] **Step 1: Write the topic-load skill**

Create `.claude/skills/context/SKILL.md`:

```markdown
---
name: context
description: Load a Context/ knowledge topic into the conversation. Use when the user types /context <topic>, says "load context for X", "what do we know about X", or when a task touches a domain topic and its Memory.md is not yet loaded. No argument = list available topics.
---

# /context — Load domain knowledge topic

Argument: a topic name or alias.

## Steps

1. Read `Context/ContextMapping.md`.
2. **No argument given**: print the topic table (Topic + Aliases columns only) and stop.
3. Resolve the argument against the topic table — match topic names AND aliases, case-insensitive, partial match allowed. Multiple matches: list them and ask the user to pick.
4. Read the resolved `Memory.md` in full and summarize nothing — the content itself is now loaded context. Briefly confirm: topic, path, and how many facts and gotchas it holds.
5. If that file's Pointers section references other Memory.md files directly relevant to the current task, offer to load them too.
6. No match anywhere: say so, show the 5 closest topics, and remind the user that new topics are created by writing findings to `Context/_inbox/` (the Librarian registers them).
```

- [ ] **Step 2: Write the curate skill**

Create `.claude/skills/curate-context/SKILL.md`:

```markdown
---
name: curate-context
description: Run the Context Librarian — merge Context/_inbox/ findings into the Memory.md knowledge base. Use when the user types /curate-context, says "curate the context", "run the librarian", "merge the inbox", or at session end when Context/_inbox/ contains unprocessed findings.
---

# /curate-context — Dispatch the Context Librarian

1. Check `Context/_inbox/` for `.md` files other than `README.md`. None → report "inbox empty, nothing to curate" and stop.
2. Launch the `context-librarian` agent (Agent tool, `subagent_type: context-librarian`) with the prompt: "Process all files in Context/_inbox/ per your procedure. Report merged/flagged items."
3. Relay the Librarian's final report to the user: what was merged where, contradictions resolved, new topics created, and flagged items (untagged or secrets).
```

- [ ] **Step 3: Write the learn skill**

Create `.claude/skills/learn/SKILL.md`:

```markdown
---
name: learn
description: Learn a knowledge source into the Context/ knowledge base — one command runs the full loop (acquire + extract, then curate). Use when the user types /learn <source>, says "learn this", "learn <URL>", "learn this doc", "ingest this doc", or "add this to the knowledge base". Handles auth-gated docs, public URLs, and local files.
---

# /learn — Acquire a source and fold it into the knowledge base

Argument: a source reference — a URL, a document name or link, a local file path, or pasted text.

## Steps

1. Launch the `context-learner` agent (Agent tool, `subagent_type: context-learner`) with the source and any topic hint. It classifies the source, applies the GATE (`Context/ContextMapping.md`), retrieves the content, condenses it, and stages findings to `Context/_inbox/` — plus a dated mirror next to the topic's `Memory.md` for auth-gated sources.
2. Check `Context/_inbox/` for `.md` files other than `README.md`. If the learner staged nothing (retrieval failed, or the content was already known), relay its report and stop.
3. Otherwise launch the `context-librarian` agent (Agent tool, `subagent_type: context-librarian`) with the prompt: "Process all files in Context/_inbox/ per your procedure. Report merged/flagged items." — same as `/curate-context`.
4. Relay the combined report: what the learner acquired (source, topics, inbox file, mirror path) and what the Librarian merged (facts added/updated, topics created, flagged items).
```

- [ ] **Step 4: Verify the agent names referenced by the skills exist**

Run:

```bash
for a in context-librarian context-learner; do
  test -f ".claude/agents/$a.md" && echo "OK   $a" || echo "MISS $a"
done
grep -rn "subagent_type" .claude/skills/curate-context/SKILL.md .claude/skills/learn/SKILL.md
```

Expected: both `OK`; the `subagent_type` values are exactly `context-librarian` and `context-learner`.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/context .claude/skills/curate-context .claude/skills/learn
git commit -m "feat(context): add /context, /curate-context, and /learn skills"
```

---

### Task 6: Install the router hook

**Files:**
- Create: `.claude/hooks/context_router.py`
- Modify: `.claude/settings.json` — add a `UserPromptSubmit` hook entry
- Test: manual stdin fixtures (the hook is a stdin→stdout filter, so its test is piping JSON at it)

**Interfaces:**
- Consumes: the `| Topic | Aliases | Path |` table under the `## Topic table` heading in `Context/ContextMapping.md` (Task 2). It parses that table at run time — it holds no alias list of its own.
- Produces: a single line of JSON on stdout, `{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "..."}}`, whose `additionalContext` names the matched `Topic -> path` pairs and restates the GATE. Silence (no output) when nothing matches.

- [ ] **Step 1: Write the failing test fixture**

Create the fixture files (temporary, not committed):

```bash
mkdir -p /tmp/ctxhook
cat > /tmp/ctxhook/match.json <<'EOF'
{"prompt": "why did the alert time out on the billing API"}
EOF
cat > /tmp/ctxhook/nomatch.json <<'EOF'
{"prompt": "reformat this yaml file please"}
EOF
cat > /tmp/ctxhook/short.json <<'EOF'
{"prompt": "hi"}
EOF
```

Edit `match.json` so its prompt contains a real alias from your own topic table.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
python3 .claude/hooks/context_router.py < /tmp/ctxhook/match.json
```

Expected: FAIL — `can't open file ... context_router.py: No such file or directory`.

- [ ] **Step 3: Write the hook**

Create `.claude/hooks/context_router.py`:

```python
#!/usr/bin/env python3
"""UserPromptSubmit hook: match the user prompt against Context/ContextMapping.md
topics + aliases and inject the resolved Memory.md paths as context.
Keeps aliases in ONE place (ContextMapping.md) - new topics are covered automatically."""
import json
import re
import sys

MAX_TOPICS = 6
# Aliases too generic to trigger on their own (they match only inside a longer phrase).
NOISE = {"api", "config", "data", "service", "test"}


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    prompt = (data.get("prompt") or "").strip()
    if len(prompt) < 4:
        return

    try:
        with open("Context/ContextMapping.md", encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return

    matches = []
    in_topic_table = False
    for line in lines:
        if line.startswith("## "):
            in_topic_table = line.startswith("## Topic table")
            continue
        if not in_topic_table or not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 3 or cells[0] in ("Topic", ":---", "---") or cells[0].startswith("-"):
            continue
        topic, aliases, path = cells[0], cells[1], cells[2].strip("`")
        terms = [topic] + [a.strip() for a in aliases.split(",") if a.strip()]
        for term in terms:
            if term.lower() in NOISE:
                continue
            # Every word of the term must appear in the prompt (any order, any
            # distance), allowing a trailing plural 's' or digits - so
            # "released versions" matches "list all released project versions".
            words = term.split()
            if all(
                re.search(
                    r"\b"
                    + re.escape(w[:-1] if len(w) > 3 and w.endswith("s") else w)
                    + r"(s|\d+)?\b",
                    prompt,
                    re.IGNORECASE,
                )
                for w in words
            ):
                matches.append((topic, path))
                break

    if not matches:
        return
    listing = "; ".join(f"{t} -> {p}" for t, p in matches[:MAX_TOPICS])
    ctx = (
        "[Context Router] Domain topics matched in Context/ContextMapping.md: "
        + listing
        + ". GATE: read these Memory.md files (and any mirror file they point to) "
        "BEFORE grepping code or searching external sources. "
        "New domain findings go to Context/_inbox/ tagged (scope, date) or (General)."
    )
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": ctx,
        }
    }))


if __name__ == "__main__":
    main()
```

Two edits before moving on. First, replace the `NOISE` set with the generic aliases from your own topic table — a single word that appears in ordinary prompts about anything belongs here. Second, if `SCOPE_AXIS` is `none`, change the last sentence of `ctx` to end `tagged (date)`.

- [ ] **Step 4: Run the tests to verify they pass**

All three run from the repo root, because the hook opens `Context/ContextMapping.md` by relative path.

```bash
python3 .claude/hooks/context_router.py < /tmp/ctxhook/match.json
```

Expected: one line of JSON containing `[Context Router]` and the matched topic's path.

```bash
python3 .claude/hooks/context_router.py < /tmp/ctxhook/nomatch.json
python3 .claude/hooks/context_router.py < /tmp/ctxhook/short.json
echo "not json" | python3 .claude/hooks/context_router.py
```

Expected: no output from any of the three, and exit status 0 each time — a hook that crashes or chatters on every unrelated prompt is worse than no hook.

```bash
cd /tmp && python3 "$OLDPWD/.claude/hooks/context_router.py" < /tmp/ctxhook/match.json; cd "$OLDPWD"
```

Expected: no output. Run from the wrong directory, the hook stays silent rather than erroring.

- [ ] **Step 5: Wire the hook into settings**

If `.claude/settings.json` does not exist, create it with exactly this content:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 .claude/hooks/context_router.py 2>/dev/null || true"
          }
        ]
      }
    ]
  }
}
```

If it already exists, **merge** — add the `UserPromptSubmit` array to the existing `hooks` object, or append this entry to an existing `UserPromptSubmit` array. Do not overwrite the file and do not disturb unrelated keys.

On a system where `python3` is not on PATH (some Windows installs), use `python` instead. The `2>/dev/null || true` tail is deliberate: a broken hook must never block a prompt.

- [ ] **Step 6: Verify the settings file is valid JSON and the hook is registered**

Run:

```bash
python3 -c "import json;d=json.load(open('.claude/settings.json'));print(json.dumps(d['hooks']['UserPromptSubmit'],indent=2))"
```

Expected: the entry prints, containing the `context_router.py` command. A `JSONDecodeError` means the merge in Step 5 broke the file — fix it before committing.

- [ ] **Step 7: Clean up the fixtures and commit**

```bash
rm -rf /tmp/ctxhook
git add .claude/hooks/context_router.py .claude/settings.json
git commit -m "feat(context): add UserPromptSubmit router hook, parsed live from the topic table"
```

---

### Task 7: Install the instruction-layer GATE

**Files:**
- Modify: `<FILL: AGENT_INSTRUCTION_FILE>` — add the Context Knowledge Base section

**Interfaces:**
- Consumes: the router path from Task 1, the inbox format from Task 1, the tag format from Task 1, and the `/context` and `/curate-context` command names from Task 5.
- Produces: the instruction layer of the GATE — the half that covers judgement, where Task 6's hook covers habit. This is the last artifact; Task 8 verifies the assembled whole.

- [ ] **Step 1: Add the section**

Append to `<FILL: AGENT_INSTRUCTION_FILE>` (or insert near the top, if that file leads with project overview material):

```markdown
## Context Knowledge Base

This repo has a `Context/` folder holding **domain knowledge** (<FILL: DOMAIN>) learned across agent sessions.

- **GATE — before ANY other tool call** (Grep/Glob/Bash/Read on source) for a task touching <FILL: DOMAIN>: read `Context/ContextMapping.md` FIRST. Not optional, not skippable because the question "seems like a quick grep" — grep is exactly what this gate exists to preempt.
- If the topic table has a matching row (aliases count), read that `Memory.md` (and any mirror file it links) BEFORE searching code, config, or external sources. Fall back to grep or tool search only when the table has no match.
- A `[Context Router]` hook message listing matched topics may appear with the user prompt — treat it as the gate already resolved: read the listed files first.
- Explicit load: `/context <topic>`.
- **After** learning substantial new domain info: write it to `Context/_inbox/` (format in `Context/_inbox/README.md`). **Every finding must be tagged `(<FILL: SCOPE_AXIS> value, YYYY-MM-DD)` or `(General)`.**
- **Never edit `Memory.md` files directly** — only the Librarian agent does (`/curate-context`). At session end, if `_inbox/` has unprocessed files, suggest running `/curate-context`.
- Never write secrets or credentials into `Context/`.
```

Substitute `<FILL: DOMAIN>` in both places and `<FILL: SCOPE_AXIS>`. If `SCOPE_AXIS` is `none`, the tag sentence reads: **Every finding must be tagged `(YYYY-MM-DD)`.**

- [ ] **Step 2: Verify the block is present and complete**

Run, substituting your instruction file name:

```bash
grep -n "Context Knowledge Base" CLAUDE.md
grep -n "GATE — before ANY other tool call" CLAUDE.md
grep -n "Never edit \`Memory.md\` files directly" CLAUDE.md
grep -n "FILL:" CLAUDE.md
```

Expected: the first three each return a line; the last returns nothing.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(context): add the knowledge-base GATE to the agent instruction file"
```

---

### Task 8: Smoke-test the assembled mechanism

**Files:**
- Create (then delete): `<FILL: KB_ROOT>_inbox/YYYY-MM-DD_smoke-test.md`
- Modify (as a side effect of the test): two `Memory.md` files and, in check 5, `ContextMapping.md` plus one new topic folder

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: a pass/fail verdict on all six acceptance criteria. All six pass or the install is not done.

- [ ] **Step 1: Check 1 — the hook fires on a real alias**

In a fresh Claude Code session in this repo, send a prompt containing an alias from your topic table, phrased as an ordinary question.

Expected: a `[Context Router]` line appears with the prompt, naming that topic and its `Memory.md` path.

If nothing appears: the alias words are not all present in the prompt, the alias is in the `NOISE` set, or `python3` is not resolvable. Re-run Task 6 Step 4 with a fixture containing the exact prompt text to isolate which.

- [ ] **Step 2: Check 2 — `/context` resolves an alias**

Run `/context <an alias, not the topic name>`.

Expected: the skill names the resolved topic and path and loads that `Memory.md`. Then run `/context` with no argument and confirm it prints the topic table.

- [ ] **Step 3: Check 3 and 4 — a tagged file merges, an untagged bullet quarantines**

Create `Context/_inbox/2026-08-03_smoke-test.md`, substituting two real topic names and a real scope value:

```markdown
## [Topic: <FirstRealTopic>]
- Smoke test: this bullet is correctly tagged and must land in Facts. (<real scope value>, 2026-08-03)
- Smoke test: this bullet has no tag and must NOT land in Facts.

## [Topic: <SecondRealTopic>]
- Smoke test: retries double the observed latency under load, which reads as a timeout. (<real scope value>, 2026-08-03)
```

The second bullet is deliberately untagged. If `SCOPE_AXIS` is `none`, use `(2026-08-03)` as the tag form.

Run `/curate-context`. Then verify:

```bash
grep -n "correctly tagged" Context/<Group>/<FirstRealTopic>/Memory.md
grep -n "has no tag" Context/<Group>/<FirstRealTopic>/Memory.md
grep -n "reads as a timeout" Context/<Group>/<SecondRealTopic>/Memory.md
ls Context/_inbox/
```

Expected, in order: the tagged bullet is under `## Facts`; the untagged bullet is under `## Open Questions` marked `[UNTAGGED`, and **not** under Facts; the second topic's bullet landed in its own file (Gotchas is the right section for that one); `_inbox/` contains only `README.md`. Confirm the `> Updated:` line changed in both touched files.

A merge that puts the untagged bullet in Facts is a **failure**: re-read the tagging rule in `.claude/agents/context-librarian.md` and make it more emphatic, then re-run.

- [ ] **Step 4: Check 5 — an unknown topic auto-registers**

Create `Context/_inbox/2026-08-03_smoke-newtopic.md`:

```markdown
## [Topic: SmokeTestTopic]
- Smoke test: a topic absent from the table must be created and registered. (<real scope value>, 2026-08-03)
```

Run `/curate-context`. Then:

```bash
find Context -ipath "*SmokeTestTopic*"
grep -n "SmokeTestTopic" Context/ContextMapping.md
```

Expected: a new `Context/<Group>/SmokeTestTopic/Memory.md` exists holding the bullet, and a matching row with at least two aliases was added to the topic table.

- [ ] **Step 5: Check 6 — an empty inbox is a no-op**

Run `/curate-context` again with only `README.md` in the inbox.

Expected: it reports "inbox empty" and changes no files. Confirm with:

```bash
git status --porcelain
```

Expected: no new modifications beyond what the earlier checks produced.

- [ ] **Step 6: Remove the smoke-test artifacts**

The smoke facts are fiction and must not survive in the knowledge base.

```bash
rm -rf Context/<Group>/SmokeTestTopic
```

Then, by hand: delete the `SmokeTestTopic` row from `Context/ContextMapping.md`, and delete the three smoke bullets from the two real `Memory.md` files (including the quarantined one in Open Questions). Verify:

```bash
grep -rn "Smoke test" Context/ || echo "clean"
```

Expected: `clean`.

- [ ] **Step 7: Commit the verified install**

```bash
git status --porcelain
git add -A Context .claude
git commit -m "test(context): verify all six acceptance checks pass on the installed mechanism"
```

If `git status` shows leftover smoke content, go back to Step 6 — do not commit fictional facts.

---

## Optional extensions

Not part of this install. Add either one only when the project actually needs it.

- **Authoritative-source gate.** If the project has a file that is the single source of truth for configuration, add a merge gate to the librarian: any fact derivable from that file is dropped rather than recorded, the topic's Pointers section references the file instead, and on any conflict the file wins. Prevents the knowledge base from becoming a stale second copy of config.
- **Isolation topics.** If some class of finding must never mix with domain knowledge — defects found in a legacy codebase while studying a domain, for instance — create a dedicated topic for it and add a content-based routing gate to the librarian: bullets of that class route to the isolation topic regardless of the `[Topic: X]` header they arrived under.

## Self-review

Checked against the spec:

- Problem, non-goals — context for the implementer, no task needed.
- Deliverable + placeholder set — Task 1 Step 1, and the Global Constraints table.
- Router (`ContextMapping.md`) — Task 1 Step 5 (skeleton), Task 2 Steps 5–6 (tables).
- Storage + `_TEMPLATE.md` + Overview + mirrors — Task 1 Step 3, Task 2 Steps 3–4; mirrors specified in Task 1 Step 5 write rule 6 and Task 4 Step 1 procedure step 5.
- Intake (`_inbox/`) — Task 1 Step 4.
- Curator, all seven merge rules — Task 3 Step 1.
- Acquirer — Task 4 Step 1.
- GATE, both layers — Task 6 (hook), Task 7 (instruction).
- Skills, all three — Task 5.
- Data flow — realized across Tasks 1–7; exercised end to end in Task 8.
- Tagging, including the `none` variant — Global Constraints, plus a `none` note in Tasks 1, 3, 4, 6, 7.
- Phases 1–8 — Tasks 1–8, same order.
- Acceptance criteria 1–6 — Task 8 Steps 1–5.
- Optional extensions — recorded as one-liners, out of scope.
- Risks — mitigations landed as concrete steps: the ≥2-alias rule is enforced in Task 2 Step 7; the `NOISE` set and `MAX_TOPICS` in Task 6 Step 3; the never-edit-directly rule appears in the template header, the router, and the GATE block; the session-end nudge in Task 7.

Naming consistency: `context-librarian` and `context-learner` are used identically in Tasks 3, 4, 5, and 8. `Context/ContextMapping.md`, `Context/_TEMPLATE.md`, and `Context/_inbox/README.md` are spelled identically throughout. The `## Topic table` heading text is what Task 6's parser keys on and matches Task 1 Step 5 exactly — renaming that heading breaks the hook.
