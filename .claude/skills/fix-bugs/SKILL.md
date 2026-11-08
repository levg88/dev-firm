---
name: fix-bugs
description: Run the Fixer — investigate and fix logged bugs. Use when the user types /fix-bugs, says "fix bugs", "fix logged issues", or at session end when Bugs/_inbox/ contains unprocessed findings.
---

# /fix-bugs — Dispatch the Fixer

1. Check `Bugs/_inbox/` for `.md` files other than `README.md`. None → report "bug inbox empty, nothing to fix" and stop.
2. Launch the `fixer` agent (Agent tool, `subagent_type: fixer`) with the prompt: "Process all files in Bugs/_inbox/ per your procedure. Report fixed and remaining items."
3. Relay the Fixer's final report to the user.
