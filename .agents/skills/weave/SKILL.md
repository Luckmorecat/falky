---
name: weave
description: Land work whose intent the current session settled, orchestrating subagents that implement, review, and commit it green.
disable-model-invocation: true
---

Land the work whose intent this session settled. You are the orchestrator: you hold the conversation's intent and decisions and brief, decide, route, and check until acceptance holds; subagents plan, reconcile, implement, review, and commit.

Resolve `code-review/SKILL.md` and `commit/SKILL.md` as siblings of this skill's directory. When either is missing, report it as a missing prerequisite before dispatching anything.

[Handoff](#handoff), [Questions and updates](#questions-and-updates), and [Autonomy](#autonomy) apply throughout the steps.

## 1. Brief

Write a brief from the supplied work and the conversation: the goal, observable acceptance examples with IDs, scope and exclusions, settled decisions, delegated discretion, and any sources of truth for approved behaviour (a work contract, spec, design, or prototype). Derive acceptance where absent. Amend a supplied work contract only where the conversation contradicts or extends it. Ask only about gaps whose answer changes the work. The brief is done when every behaviour the conversation settled has an acceptance ID and every source of truth has the version to hold it to, what it settles, and its precedence.

Keep **run decisions**, choices the brief leaves open that are made during the run, in a list apart from the brief and any work contract, each with its trigger, alternatives, reason, and undo cost.

## 2. Map

A **reconciler** maps where the sources of truth and the current system differ, so the work neither regresses an existing capability nor drifts from approved behaviour, and resolves each difference by the brief's rules or returns it as a decision. Beyond the map here, it takes worker discrepancies during implementation and checks each committed result against its map.

When the brief names sources of truth that settle behaviour beyond its acceptance, such as a prototype, design, or spec with examples, dispatch a reconciler to map the brief's scope. Give every later reconciler and planner the latest map's path.

## 3. Plan

A **chunk** is the part of the work one worker implements. When the work is plainly one coherent change, run it as one chunk without a planner; otherwise dispatch a planner and decide the chunks from its proposal. Fix each chunk's boundaries only once the **Needs decision** items affecting it are settled.

**Integration acceptance** is acceptance only the combined work can demonstrate. When an [update](#questions-and-updates) adds acceptance, give it to the chunk that owns the paths it touches, or make it integration acceptance.

## 4. Implement

Record the fixed point with `git rev-parse HEAD 2>/dev/null || git hash-object -t tree /dev/null`, and `git status --porcelain` as the dirty snapshot when the tree is already dirty. A **round** is one pass of implementation, review, and commit. The first round's fixed point is the recorded one; each repair round's is the last commit. Give review the recorded fixed point instead when a repair changes code that earlier rounds' commits depend on.

Run chunks in dependency order in the current checkout, passing each worker the earlier reports, and give integration acceptance to the last chunk. When two or more chunks are independent, read [PARALLEL.md](PARALLEL.md) before dispatching them.

Give each worker the paths of any supplied documents, any dirty snapshot, and, when split, its chunk and the paths the other chunks own.

## 5. Review and commit

Review always runs in subagents. Once the round's workers have returned their final reports, dispatch a reviewer with the round's fixed point, any dirty snapshot, and the reports' verification evidence. Where subagents cannot dispatch their own, dispatch `code-review`'s Standards and Plan compliance axes as two reviewers yourself, each following `code-review/SKILL.md` for its axis alone, and combine their findings. Route blocking findings to the worker that last touched the code.

Once no blocking findings remain, dispatch a committer with the round's fixed point, any dirty snapshot, the commit-message notes workers reported, and the round's run decisions for the message.

## 6. Check

Check the committed result against the brief's acceptance and the conversation's intent. When a map exists, dispatch a reconciler to check the result against it, passing the brief's scope if step 2 mapped it. Repair each gap through the worker whose chunk holds its acceptance IDs, then review, commit, and check the new result the same way. Escalate a gap that recurs after repair instead of repeating the same repair.

Finish once acceptance holds at the final commit, the last reconciler check, if one ran, returns no gaps, and no changes from this run remain uncommitted. Report the commits, acceptance evidence, answers that changed approved behaviour, run decisions (costliest to undo first), unresolved blockers, and any worktrees kept for paused chunks.

## Handoff

Every subagent gets the brief, the run decisions affecting its work, and the absolute path of its role file, instructed to read and follow it: [PLANNER.md](PLANNER.md) for planners, [RECONCILER.md](RECONCILER.md) for reconcilers, [WORKER.md](WORKER.md) for workers, and the sibling `code-review/SKILL.md` or `commit/SKILL.md` for review and commit. Each step names only what its dispatch adds to these.

To **dispatch** is to start a fresh subagent, without this conversation's history where the runtime allows, so the handoff is its whole context: one per chunk, and a new planner, reconciler, reviewer, or committer each time a step calls for one. Continue an existing worker only to resume it when paused, to fix findings in code it last touched, or to repair or rework its chunk; when it is unavailable, dispatch a fresh one with its report.

## Questions and updates

A worker that raises a question or a discrepancy stops and returns; its chunk is **paused** until you deliver the update it needs. Proceed with other chunks only once the paused worker reports its partial changes can stay in the tree.

Dispatch one reconciler with all pending discrepancies, the reports that raised them, and the worktree of each affected parallel chunk.

Treat each **Needs decision** item a planner or reconciler returns as a question. Answer questions the conversation or the brief's delegated discretion settles; escalate the rest to the user with options and a recommendation. Add every answer that changes approved behaviour to the brief, and to a supplied work contract; record any other answer as a run decision. Revise any run decision an answer overturns. Add each **Resolved** item a reconciler returns to the brief, writing acceptance for any behaviour it adds.

An **update** is an answer, a run decision, or a **Resolved** item. Deliver each to every worker whose acceptance IDs it affects before that worker's dependent work resumes. When the work it affects is already done, have that worker rework it.

## Autonomy

When the user grants autonomy, decide choices the brief leaves open yourself. Still escalate changes to approved behaviour and any choice that would:

- lose data or require an irreversible migration;
- loosen security, privacy, or permissions;
- break a public API or external contract;
- change deployment, add an external service, or add ongoing cost;
- leave the result unverifiable against the brief's acceptance.

Decide by the brief's delegated discretion, then these defaults in order: keep every existing capability; stay closest to the approved intent; prefer the option cheapest to undo; prefer the smallest change that satisfies acceptance. Record each as a run decision.
