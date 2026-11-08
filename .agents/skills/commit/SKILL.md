---
name: commit
description: Use when committing changes.
---

## Scope

Commit only work done for the current task or changes the user explicitly asked to commit. Use a caller's fixed point and dirty snapshot to identify that scope. Existing staging does not establish ownership; leave unrelated work untouched. If ownership is unclear, leave the change uncommitted and report it.

## Hazards

Do not commit secrets, build output, unexpected binaries, unexplained mass deletions, or changes whose purpose you cannot establish. Report what was excluded.

## Grouping and messages

Split the scoped work into semantic commits whenever reasonable. Keep implementation with its related tests, docs, schema, and config. Split a shared file by hunks only when concerns are independent and stage cleanly; otherwise leave the mixed change uncommitted rather than include unrelated work.

Use imperative subjects under 72 characters: `type(scope): subject`, with types `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `style`, or `chore`. Use a supplied task ID as scope only for related commits. Add supplied rationale in the body and required repository trailers.

## Execution

Inspect fresh `git status --porcelain` and staged/unstaged diffs. Retain already-staged changes in the selected group; stage only its remaining paths or hunks, including tracked deletions. Do not re-add the old path of an already-staged rename. Check `git diff --cached` before each commit; keep unrelated content out without discarding it, preserving its staged and unstaged state. Use `git add -p` or `git apply --cached` for hunk splits. A git or hook failure stops the run.

Report the commits made, excluded changes, and any failure or remaining work.
