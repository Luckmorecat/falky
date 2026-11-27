---
name: define
description: Explore and grill an idea or feature until its purpose, experience, scope, and consequential decisions are clear.
disable-model-invocation: true
---

Explore and grill the requested idea or feature, with or without a repository. Keep the session read-only and conversational: explore and settle decisions, leaving any file edits or implementation for a later step.

Build on what the conversation and supplied docs already settle. When direction is uncertain, propose concrete possibilities and help choose one. Grill assumptions with concrete scenarios to uncover missing behavior, contradictions, failure cases, and tradeoffs.

## Fact-checking

Verify facts from the codebase, docs, or web instead of asking the user. Do targeted reads and searches inline. Dispatch subagents only for broad, multi-file exploration or external research that would bloat this conversation; give each a bounded question and ask for concise findings with evidence. Finish relevant discovery before asking questions whose options depend on it.

## Questions and decisions

Treat decisions as a tree: batch independent questions whose prerequisites are settled, and defer branches that depend on unanswered choices. Wait for the user's reply before treating recommendations as decisions. When the user delegates a choice, make it and explain why.

Write every question directly in your chat reply as numbered markdown (`Q1`, `Q2`, unique across rounds): give choice questions lettered options restarting at `A` per question and a recommendation naming the letter and its main tradeoff; ask open-ended questions as plain numbered questions when choices would be artificial.

```markdown
❓ **Q1 — Who can invite members?**

- **A.** Any member
- **B.** Only the owner

➡️ **Recommended: A** — The group can grow without waiting on
its owner, at the cost of less control over who gets invited.
```

Resolve in-scope choices that affect user-visible behavior, public interfaces, persistent data, security or privacy, deployment, external dependencies, ongoing cost, ownership between components, or anything hard to reverse. Surface these consequences even when a choice looks like an implementation detail. Leave cheaply reversible implementation details open, and follow clear existing codebase precedent unless changing it is in scope.

Distinguish settled decisions, proposals, and claims that still need evidence. User agreement settles intent; it does not prove feasibility or demand.

## Done

Continue until concrete scenarios cover the main experience and meaningful boundaries, scope and exclusions are explicit, and every known consequential choice is resolved or explicitly left open with its implications understood.

Finish with a conversational recap, then stop so the user chooses what happens next:

- **Purpose, scope, and exclusions**
- **Key scenarios**
- **Settled decisions** (with rationale, noting delegated choices)
- **Open choices and unverified claims** (blocking vs non-blocking, implications, and what would resolve each)
