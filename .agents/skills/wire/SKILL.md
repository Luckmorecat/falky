---
name: wire
description: Use when the user tells you to "wire" work (e.g. "wire it", "wire this", "wire up X").
---

Implement the supplied or requested work.

## 1. Ground

Honour agreed scope, exclusions, and decisions; derive concrete scenarios where absent. Before editing:

- Verify assumptions that affect the change.
- Ask on any open choice or ambiguity that changes the outcome.
- In a git repo, check `git status --porcelain` so unrelated dirty paths stay untouched; ask before editing an already-dirty path.

## 2. Execute

Make the smallest changes that satisfy the scenarios. Ask before changing agreed behavior or triggering irreversible, destructive, or external side effects (live infrastructure or services, global state, persistent data, security or permissions, public contracts, ongoing cost, or pushing).

## 3. Prove and finish

Prove every scenario after the final edit with the lightest concrete check that demonstrates it: validation, dry-run, build, smoke run, live check, or a focused test where logic warrants one. Mark any check you could not run as unproven.

Audit the final diff for scope, stray files, and secrets, and leave changes uncommitted.

Report:
- Changed paths (and any non-repo state touched)
- Proof per scenario (commands and outcomes, plus anything unproven)
- Discoveries, open items, or blockers (preserving partial work if blocked)
