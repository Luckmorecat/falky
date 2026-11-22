# Parallel chunks

Run independent chunks in parallel only when all hold; otherwise run them sequentially in the current checkout without stashing pre-existing changes:

- isolated worktrees are available;
- the tree is clean and the fixed point is a commit, not the empty tree;
- the chunks own disjoint paths and none depends on another;
- each chunk can be assigned its own instances of the resources its verification needs, such as a port, database, or cache.

Create each worktree outside the repository (for example under `mktemp -d`) on its own branch from the round's fixed point, or let the harness isolate the worker. Give each parallel worker its assigned resources and, when known, its worktree's absolute path and branch.

After the wave's non-paused parallel chunks return—and again once any paused chunk later completes—dispatch an integration worker with only the completed parallel workers' reports and any integration acceptance reachable at that wave (deferring final integration acceptance if downstream chunks remain). Deliver every update to the integration worker too. Instruct it to:

- own the combined paths of the integrated chunks and apply each completed worktree's WIP commit into the current checkout uncommitted (`git cherry-pick --no-commit <branch-or-sha>`);
- on conflict, resolve within the brief, stage, and clear cherry-pick state without committing (`git cherry-pick --quit`) so no `CHERRY_PICK_HEAD` or sequencer state remains;
- verify the combined result green, then force-remove the integrated worktrees (`git worktree remove --force`), any unmerged WIP branches (`git branch -D`), and their resource instances, keeping those of paused chunks.

Once integrated and removed, route any review fixes, repairs, or rework for those chunks to a fresh worker in the current checkout. If a later wave also needs parallel worktrees, run step 5 (review and commit) first so the tree is clean again.
