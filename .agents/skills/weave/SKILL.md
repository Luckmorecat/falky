---
name: weave
description: Deliver work whose intent the current session settled, orchestrating subagents that implement, review, and commit it green.
disable-model-invocation: true
---

Deliver the work whose intent this session settled. You are the orchestrator: you hold the conversation's intent and decisions and brief, decide, route, and check until acceptance holds; subagents plan, reconcile, implement, review, and commit. Route repository inspection beyond quick git status/log checks and every product-code edit through subagents.

Resolve `code-review/SKILL.md` and `commit/SKILL.md` as siblings of this skill's directory. When either is missing, report it as a missing prerequisite before dispatching anything.

[Handoff](#handoff), [Questions and updates](#questions-and-updates), and [Autonomy](#autonomy) apply throughout the steps.

## 1. Brief

Write a brief from the supplied work and the conversation: goal, observable acceptance examples with IDs (derive where absent), scope and exclusions, settled decisions, delegated discretion, starting points (known paths, symbols, and verification commands), and any sources of truth (work contract, spec, design, or prototype). Amend a supplied work contract only where the conversation contradicts or extends it, and ask only about gaps whose answer changes the work.

The brief is done when every settled behaviour has an acceptance ID and every source of truth names what it settles, its precedence, and its version, commit, or snapshot (never an unpinned mutable external or prototype source).

Record the **fixed point** with `git rev-parse HEAD 2>/dev/null || git hash-object -t tree /dev/null`, and `git status --porcelain` as the **dirty snapshot** when the tree is dirty. Keep **run decisions**—open choices you decide yourself during the run—in a list apart from the brief and any work contract, each with trigger, alternatives, reason, and undo cost.

## 2. Map

A **reconciler** maps where sources of truth and the current system differ, resolving each difference by the brief's rules or returning it as a decision. Beyond the map here, it handles worker discrepancies and checks round results against its map.

When the brief names sources of truth settling behaviour beyond its acceptance (such as a prototype, design, or spec with examples), dispatch a reconciler to map the brief's scope—unless a supplied work contract already carries a settled mapping ledger covering that scope with no open gaps (for example from `adopt`), in which case pass that ledger as a read-only starting map. Give every later reconciler and planner the latest map's path.

## 3. Plan

A **chunk** is the part of the work one worker implements. Default to one chunk without a planner. Dispatch a planner (passing any dirty snapshot) only when independent tracks can run in parallel or the scope would genuinely overload one worker, then decide the chunks from its proposal. Fix each chunk's boundaries only once **Needs decision** items affecting it are settled.

**Integration acceptance** is acceptance only the combined work can demonstrate. When an [update](#questions-and-updates) adds acceptance, give it to the chunk that owns the paths it touches, or make it integration acceptance.

## 4. Implement

A **round** is one pass of implementation, review, and commit. The first round's fixed point is the recorded one; each later round's is the last commit. Give review the recorded fixed point instead when a repair changes code earlier rounds' commits depend on (using a two-dot diff if that fixed point is the empty tree).

Run chunks in dependency order in the current checkout, passing each worker the earlier reports, and give integration acceptance to the last chunk. When the plan has independent chunks, read [PARALLEL.md](PARALLEL.md) before dispatching them.

Give each worker the paths of any supplied documents, any dirty snapshot, and, when split, its chunk (acceptance IDs, owned paths, and planner-discovered starting points and checks) and the paths other chunks own.

## 5. Review and commit

Review always runs in subagents. Once the round's workers return their final reports, dispatch `code-review`'s `Standards` and `Plan compliance` axes directly as two parallel read-only reviewers, passing each the review fixed point, any dirty snapshot, the workers' changed paths, and their verification evidence, instructed to follow `code-review/SKILL.md` for its axis alone without spawning further subagents.

On partial waves or repair rounds, give `Plan compliance` the round's active chunks and acceptance IDs as immediate task scope with the verbatim brief as boundary. When a map exists, dispatch a reconciler in parallel to check the round's result against the map (scoped to the round's chunks on intermediate waves, and full map plus brief scope on the final round when step 2 established a map).

Resolve findings before committing:

- Triage blocking findings against the brief and session intent; dismiss false positives or out-of-scope claims directly with a short note. Handle reconciler **Needs decision** items through [Questions and updates](#questions-and-updates).
- Route confirmed blocking findings and reconciler gaps to the worker that last touched the code, or to the integration or last worker for integration acceptance.
- After behaviour code changes, run a delta re-review (passing open findings, updated evidence, and paths changed since the prior pass to the affected axis(es) plus `Standards`), and a delta reconciler re-check whenever a map exists. Comment, doc, or format-only edits need no new pass.
- Cap review at 3 passes per round; escalate any recurring gap or unresolved blocking dispute to the user rather than repeating the same fix or treating the cap as approval.

Once no blocking findings or reconciler gaps remain, dispatch a committer with the round's fixed point, any dirty snapshot, the workers' changed paths, their commit-message notes, and the round's run decisions for the message. Leave commits local unless the user asked to push. If commit stops on a git/hook failure or excluded run file, route the fix to the owning worker without bypassing hooks, run delta re-review (and reconciler re-check when a map exists) if behaviour code changed, and retry commit.

## 6. Check

Check the committed result from `git log <fixed-point>..HEAD` (or `git log HEAD` when the fixed point is the empty tree), `git status --porcelain` (matching the dirty snapshot with no uncommitted run changes), and the workers' and reviewers' reports: confirm every acceptance ID has concrete proof and the result matches session intent without re-reading the codebase or re-running suites in the main thread. Repair any remaining gap through the owning worker (or the integration or last worker for integration acceptance), then run review, commit, and check again. Escalate a gap that recurs after repair instead of repeating the same repair.

Finish once acceptance holds at the final commit, no reconciler gaps remain, and no changes from this run remain uncommitted. Report the commits, per-ID acceptance evidence, answers that changed approved behaviour, run decisions (costliest to undo first), and any declined review findings or follow-ups. When a blocker or unanswered escalation stops remaining work, stop instead of declaring completion and report what was committed, what stays uncommitted, unresolved blockers, and any worktrees kept for paused chunks.

## Handoff

Every subagent gets the current brief verbatim, the run decisions affecting its work, and the absolute path of its role file, instructed to read and follow it: [PLANNER.md](PLANNER.md) for planners, [RECONCILER.md](RECONCILER.md) for reconcilers, [WORKER.md](WORKER.md) for workers, and the sibling `code-review/SKILL.md` or `commit/SKILL.md` for review and commit. Each step names only what its dispatch adds to these.

To **dispatch** is to start a fresh subagent, without this conversation's history where the runtime allows, so the handoff is its whole context: one per chunk, and a new planner, reconciler, reviewer, or committer each time a step calls for one. Continue an existing worker only to resume it when paused, to fix findings in code it last touched, or to repair or rework its chunk; if it is unavailable or its worktree was removed, dispatch a fresh worker in the current checkout with its report.

## Questions and updates

A worker that raises a question, a path-ownership or dirty-snapshot conflict, or a discrepancy stops and returns; its chunk is **paused** until you deliver the update it needs. In the current checkout, proceed with other chunks only once the paused worker reports its partial changes can stay in the tree (parallel chunks in separate worktrees are unaffected).

Dispatch one reconciler with all pending discrepancies, the reports that raised them, and the worktree path (or current checkout) of each affected chunk.

Treat each **Needs decision** item a planner or reconciler returns as a question. Escalate dirty-snapshot collisions to the user; resolve chunk path-ownership conflicts by reassigning ownership, serializing, or deferring to integration. Answer questions the conversation or delegated discretion settles; batch and escalate the rest to the user with options and a recommendation.

Add user-confirmed answers and session-settled clarifications to the brief (and to a supplied work contract when they change approved behaviour). Record open choices you decide yourself—through delegated discretion or autonomy—as run decisions; revise any run decision an answer overturns. Add each **Resolved** item a reconciler returns to the brief, writing acceptance for any behaviour it adds.

An **update** is an answer, a run decision, or a **Resolved** item. Deliver each to every worker whose acceptance IDs it affects before that worker's dependent work resumes. When the work it affects is already done, have that worker rework it.

## Autonomy

When the user grants autonomy, decide choices the brief leaves open yourself. Still escalate changes to approved behaviour and any choice that would:

- lose data or require an irreversible migration;
- loosen security, privacy, or permissions;
- break a public API or external contract;
- change deployment, add an external service, or add ongoing cost;
- leave the result unverifiable against the brief's acceptance.

Decide by the brief's delegated discretion, then these defaults in order: keep every existing capability; stay closest to the approved intent; prefer the option cheapest to undo; prefer the smallest change that satisfies acceptance. Record each as a run decision.
