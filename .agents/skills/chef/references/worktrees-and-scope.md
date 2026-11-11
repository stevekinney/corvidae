# Worktrees and scope

Read this when creating a worktree, bootstrapping one by hand, cleaning up after an install, or dispatching a worker into a checkout that is not a fresh dedicated worktree. It holds the mutation protocol for each risk tier.

## Creating worktrees

Create manually managed worktrees only under the provider's root in `scripts/chef/repository.json` (`worktreeRoots`), and let `scripts/chef/worktree.ts create` do it. Check `git worktree list --porcelain` first, parsing it by block, and preserve the checkout that owns `main`; `worktree.ts` does this, and never attaches `main` to a second worktree. Follow repository rules for synchronization and product-managed worktrees. For a non-Git artifact, use explicit file ownership instead.

Remove a worktree with `worktree.ts remove` once its branch is delivered, after `leftovers.ts` shows nothing running inside it. It removes a worktree under the provider's root or under `<main checkout>/.claude/worktrees` (where the Agent tool makes them), by name or by absolute path. It refuses a dirty or busy worktree, a worktree Git reports as locked, and a branch whose work is not delivered: its tip is not in `origin/<default>` and no pull request for it is `MERGED` at exactly that tip. `--retired` states that the branch is deliberately abandoned and skips the delivery check.

## Bootstrapping by hand

When bootstrapping a worktree without `worktree.ts`, issue the source-copy/template step and the dependency-install step as two separate tool calls—never chain them so install runs regardless of copy's outcome. After the copy call, capture its exact exit status and inspect the destination's actual manifest identity (e.g. the destination `package.json`'s name/version against the intended template) before dispatching install. Exit zero on the copy _and_ a manifest identity that matches the intended destination are both required prerequisites for install; record the copy status and the inspected manifest identity in the work-history note before dispatching install. A nonzero copy status, or a manifest identity that doesn't match, prohibits the install call—stop and report instead of installing against whatever happens to be on disk.

## Hook cleanup

Git hooks live in the repository's shared `.git` directory and apply across every worktree, not just the one being bootstrapped—an install run against a stale or wrong template can install hooks (e.g. via a `prepare` script) that affect other worktrees' commits and pulls too. If hook cleanup is ever needed, restrict removal to artifacts proven created by the current run (matched by this run's own install timestamp or manifest fingerprint); never delete an unfamiliar hook file on the assumption it came from this run—it may belong to another worktree's legitimate setup.

## Mutation protocol, tiered by risk

Two rules apply in every tier. Every worker charter names its assigned absolute mutation root. An `exec` `workdir` binds only that `exec` call; it does not change another tool's working directory. Before using a mutation tool, inspect its schema if its path resolution is unknown. For `apply_patch` or any file-edit tool without a working-directory parameter, every file target must be an absolute path under the assigned root. For an `exec` command that writes, set its `workdir` explicitly to the assigned root and use only paths contained by that root. Do not use a mutation tool whose path binding cannot be established.

If a canonical change appears in any tier, stop the worker, preserve evidence and ownership, and recover only proven run-owned edits; never reset or automatically clean a checkout.

### Fresh dedicated worktree

A worktree that `worktree.ts create` made for this package, from a clean base, with no other writer. The worker owns everything in it, so the stop-after-first-mutation round trip buys little and costs a coordinator wake each.

- The worker edits freely inside its root. It does not stop after its first mutation.
- Before acceptance, re-read the canonical checkout's status. Review removals from the diff itself (`git diff --name-status --diff-filter=DR <base>...HEAD`): every deleted or renamed path needs a reason in the worker's return, and a rename or split still needs its test cases and assertions reviewed for equivalence.

### Shared, canonical, or production checkout

Any checkout that another owner, the user, or a deployment also uses, or one that held changes before dispatch. Keep the full protocol.

Before the first mutation, the coordinator records `git -C <canonical> status --porcelain` and `git -C <assigned> status --porcelain` in the work-history note. The disposable control requires both to be empty; a production checkout with existing changes requires a recorded baseline comparison that preserves them. The worker's first mutation may change only one explicitly authorized file under its assigned root. It must then return the exact mutation target and both actual status reads, and stop for coordinator verification before any further mutation. The coordinator independently verifies that the changed path is confined to the assigned boundary and that the canonical checkout has no unexpected change.
