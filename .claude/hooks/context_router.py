#!/usr/bin/env python3
"""UserPromptSubmit hook: match the user prompt against Context/ContextMapping.md
topics + aliases and inject the resolved Memory.md paths as context.
Keeps aliases in ONE place (ContextMapping.md) - new topics are covered automatically.
Also nudges the agent when Context/_inbox/ holds unprocessed findings."""
import json
import os
import re
import sys

MAX_TOPICS = 6
# Aliases too generic to trigger on their own (they match only inside a longer phrase).
NOISE = {"agents", "cli", "providers", "settings", "tests", "tickets"}
INBOX_DIR = "Context/_inbox"
BUG_INBOX_DIR = "Bugs/_inbox"


def inbox_files():
    """Unprocessed finding files: .md, not README.md, not empty."""
    try:
        names = os.listdir(INBOX_DIR)
    except OSError:
        return []
    out = []
    for name in sorted(names):
        if not name.endswith(".md") or name == "README.md":
            continue
        try:
            if os.path.getsize(os.path.join(INBOX_DIR, name)) > 0:
                out.append(name)
        except OSError:
            continue
    return out

def bug_inbox_files():
    """Unprocessed bug files: .md, not README.md, not empty."""
    try:
        names = os.listdir(BUG_INBOX_DIR)
    except OSError:
        return []
    out = []
    for name in sorted(names):
        if not name.endswith(".md") or name == "README.md":
            continue
        try:
            if os.path.getsize(os.path.join(BUG_INBOX_DIR, name)) > 0:
                out.append(name)
        except OSError:
            continue
    return out


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    prompt = (data.get("prompt") or "").strip()

    try:
        with open("Context/ContextMapping.md", encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        lines = []

    matches = []
    if len(prompt) >= 4:
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

    parts = []
    if matches:
        listing = "; ".join(f"{t} -> {p}" for t, p in matches[:MAX_TOPICS])
        parts.append(
            "[Context Router] Domain topics matched in Context/ContextMapping.md: "
            + listing
            + ". GATE: read these Memory.md files (and any mirror file they point to) "
            "BEFORE grepping code or searching external sources. "
            "New domain findings go to Context/_inbox/ tagged (provider / OS, date) or (General)."
        )

    inbox = inbox_files()
    if inbox:
        shown = ", ".join(inbox[:3]) + (", …" if len(inbox) > 3 else "")
        parts.append(
            f"[Context Inbox] {len(inbox)} unprocessed finding file(s) in {INBOX_DIR}/: "
            f"{shown}. Run /curate-context when the current task is done; "
            "do not edit Memory.md directly."
        )

    bug_inbox = bug_inbox_files()
    if bug_inbox:
        shown = ", ".join(bug_inbox[:3]) + (", …" if len(bug_inbox) > 3 else "")
        parts.append(
            f"[Bug Inbox] {len(bug_inbox)} unprocessed bug file(s) in {BUG_INBOX_DIR}/: "
            f"{shown}. Run /fix-bugs when the current task is done."
        )

    if not parts:
        return
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": "\n\n".join(parts),
        }
    }))


if __name__ == "__main__":
    main()
