---
name: code-review
description: Review changes since a fixed point against repository standards and an optional approved plan. Use for branch, pull-request, work-in-progress, or post-implementation review, including requests to review since a commit, branch, tag, or merge base.
---

# Code review

Review a pinned change along two independent axes:

- Standards: conformance to repository rules and the smell baseline.
- Plan compliance: conformance to the work contract plus current task. The task sets immediate scope; the contract remains its boundary.

The **work contract** is whatever approved document the caller supplies, and its shape is the caller's business: a plan, a brief, a single slice plus the boundary it runs under. Use only what was supplied and never reconstruct one from the diff. Without one, skip Plan compliance and report `No plan available; axis skipped.`

## 1. Pin the change

Require a fixed point, in this order: the revision the caller supplies; the merge base against the default branch; otherwise ask the user for a commit, branch, tag, or merge base. Resolve it with `git rev-parse` and require a non-empty review target. A fixed point with no commits behind it, the empty tree of a repository whose first commit has not landed, has no commit log: review the diff alone.

Review committed changes with `git diff <fixed-point>...HEAD` and `git log <fixed-point>..HEAD --oneline`. Add staged, unstaged, and untracked changes. Exclude paths in the caller's pre-existing dirty snapshot and any later unrelated changes they identify. Path exclusions do not separate hunks: stop when target work overlaps an excluded path and cannot be separated safely.

## 2. Collect standards

Find repository guidance that applies to the changed files, including coding standards, contribution docs, and agent or rule files. Report only problems introduced by the review target, not unchanged code shown as context. Repository rules override this baseline. Skip checks already enforced by tooling.

Treat these smells as advisory unless one exposes a concrete defect: Mysterious Name, Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, Refused Bequest.

## 3. Run isolated reviews

Spawn both sub-agents in parallel when the runtime provides them. If no work contract exists, spawn only Standards.

Give Standards the exact review target, commit list, applicable rule files, and smell baseline. Ask for every documented-rule breach and material smell.

Give Plan compliance the exact review target, whole work contract, and supplied verification evidence. Check acceptance examples and relevant constraints against implementation and evidence; passing commands alone do not prove acceptance. Ask for missing or partial requirements, incorrect behavior, scope creep, and task-plan conflicts. Identify missing evidence and the smallest check needed to obtain it.

Each finding carries a severity of `blocking` or `advisory`, its file and line, the violated rule or plan clause, and a short fix. A mandatory rule breach is blocking. A smell is advisory unless it proves a defect. Every confirmed plan-compliance finding is blocking. Return findings only, under 300 words per axis. Omit praise and unchanged requirements.

Without sub-agents, work the two axes as separate passes over the diff and supplied contract/evidence, rereading every file you cite. State that the review ran without isolation; an author reviewing their own work is not an isolated reviewer.

## 4. Report

Keep the reports separate under `## Standards` and `## Plan compliance`. Lightly clean them without merging or reranking findings. End with finding counts for each axis, blocking before advisory.
