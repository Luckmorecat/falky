# Parallel chunks

Run independent chunks in parallel only when all hold:

- isolated worktrees are available;
- the tree is clean and the fixed point is a commit, not the empty tree;
- the chunks own disjoint paths and none depends on another;
- each chunk can be assigned its own instances of the resources its verification needs, such as a port, database, or cache.

Create each worktree on its own branch from the round's fixed point, or let the harness isolate the worker. Give each parallel worker its assigned resources and, when known, its worktree's absolute path and branch.

After parallel chunks, dispatch an integration worker with each parallel worker's report and the integration acceptance, instructing it to apply their changes to the current checkout uncommitted and resolve conflicts within the brief. Deliver every update to the integration worker too. Once integration is green, have a subagent remove the integrated worktrees, their branches, and their resource instances, keeping those of paused chunks.
