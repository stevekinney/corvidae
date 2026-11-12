# Project guidance

Corvidae is a public, pre-release Bun and Turborepo workspace. Libraries are private workspace source packages; applications own their executable toolchains. Corvidae's GitHub Actions run its checks and may release applications from its own GitHub Releases. Keep Git-hook installation out of the workspace; the checked-in Claude Code hooks run inside agent sessions.

The private `stevekinney/corvidae-mirror` repository owns the tooling that transforms Corvidae source for the public package mirrors. The playground's Vercel settings live in `applications/playground/vercel.json`; its ignore command builds only when a change can affect the deployed site.

This file holds the rules every session needs. Mechanics and history live in `documentation/repository/`, and coordinator rules in the chef references (`.agents/skills/chef/references/`).

## Workflow

- Inspect the workspace and nearby conventions before changing code. Plan non-trivial work, implement one complete testable capability at a time, and add a regression test for every defect. Use current official documentation for unfamiliar APIs.
- Run the focused command while working and the focused checks once the change is complete (see **Gate on local checks**). Treat warnings, console errors, and failed checks as defects.
- Treat file length as review guidance. Enforce cyclomatic complexity of at most 100, or 300 under `scripts/`. Keep repository tooling in its owning workspace's `scripts/` directory. Restructure only for a concrete ownership, duplication, or correctness benefit, and prefer platform and Bun primitives over new abstractions or dependencies. Keep correctness, types, tests, and builds enforced.
- Add no compatibility, migration, shim, adapter, or re-export layer while pre-release unless the requirement demands one.
- Never separate pieces of copy with a middle dot (U+00B7) in Cinder, the playground, or Interborough (`lint:root` enforces it).
- A pull request is optional (owner decision, 2026-11-11). By default the worker pushes its branch, and the coordinator verifies it (the focused checks, the revert check, a review where one earns its keep) and squash-merges it into `main` with a message that names its issue without a closing keyword. Open a pull request where pre-merge CI or a reviewer reading the diff earns its keep: the lock and concurrency infrastructure, CI workflows, and one-way doors ([delivery](.agents/skills/chef/references/coordination.md#run-the-team)).
- Update a branch from `main` only with a real merge (`git fetch origin main && git merge FETCH_HEAD`): never `git reset --soft` onto a newer `main`, never `-s ours` or `-X ours`, and never restore a whole tree from a stash or an older commit. Before every push, run `bun scripts/chef/revert-check.ts` and read `git diff --name-only origin/main...HEAD`; a file you did not mean to change means your tree is stale.
- A change to Interborough's interface (`applications/interborough/src/{app,routes,views,styles}`) or to Cinder (`components/cinder/src`) needs a design review before it is ready: capture its screens with `bun scripts/design-review-capture.ts` (in `applications/interborough`) and get a verdict from the read-only `design-reviewer` agent under the `design-review` skill (`.agents/skills/design-review`). A finding a Cinder component, default, or token can carry lands in Cinder, never in the page.
- An agreed design is a requirement: work built from a design canvas carries each design row it implements as a binary acceptance criterion naming its board, or defers the row on the issue with a reason. `scripts/chef/design-ledger.ts` checks the mapping ([design programmes](.agents/skills/chef/references/planning-and-routing.md#design-programmes)).

## Review guidelines

This software is pre-1.0 and still being prototyped: spend review effort where a mistake is expensive to undo, and keep everything else simple. These rules bind human reviewers, review bots, and the agents answering them; `.github/copilot-instructions.md` is the short form, and [review and parallel-run history](documentation/repository/review-and-parallel-run-history.md) holds examples and history.

- Sort by reversibility. A _two-way door_ is internal code or a private source package a later change can cheaply alter; it gets a comment only for a concrete failure under a supported configuration, naming the inputs or interleaving and the wrong durable result. A _one-way door_ is a persisted format or schema, a wire protocol, an exported surface the mirrors publish, or a published spec; review it closely.
- Review the diff, not the repository. Behavior already on `main`, merged dependency branches, and anything a linked COR issue or decision document specifies are out of scope: cite the document and stop. On a re-review, comment only on lines changed since, and never re-raise an answered thread unless the new commits changed whether it can happen. One comment per defect class.
- Check Linear before posting a finding: read the linked COR issues and search the COR backlog, across projects, judging matches by scope, status, criteria, and decisions, never by title. Cite a ticket that already captures a suggestion instead of duplicating it; a ticket never excuses a concrete blocker this diff introduces. If Linear is unavailable, say the overlap check could not be completed, and do not block solely on that lookup.
- Accept breaking changes during pre-release: request no compatibility, deprecation period, or wrapper; update in-repository callers. Persisted data, wire protocols, and published contracts still get one-way-door scrutiny.
- What the bots catch well, and should keep flagging: fields or parts dropped across an adapter, projection, or wire mapping; state written or exposed before its durable commit, or a post-commit failure swallowed with no repair; check-then-act without a fence on the state it read; cleanup or settlement bound to a stale generation, incarnation, or round; a retry or replay that performs a different operation than its receipt records; missing authorization on a new route or lookup; unvalidated input at an exported boundary; caller-owned input read after the first `await` without a snapshot; a published spec or schema contradicting its own text.
- Find root causes: fix a recurring class once with a regression test, lint rule, or type constraint, or decline it as a one-off. A later round that surfaces another instance of an earlier round's class means the causal model was wrong; reassess and add a guard.
- Block on demonstrated correctness risks: a supported input or reachable interleaving, the wrong result, and its consequence. Touching a one-way door is not itself a blocker. Style, naming, optional refactoring, contrived edge cases, and speculative hardening do not block; omit nitpicks. A departure from an agreed design the issue names blocks like a defect.
- Answer every thread before merge: fixed (name the commit), declined (one-line reason), or tracked (name the issue). An unanswered thread blocks the merge.
- Cap review at three rounds. Fix every real finding in round one; in rounds two and three fix only regressions, one-way-door defects, and real defects in changed lines; after round three, collect what is open into one follow-up issue. Push once per round, after the focused checks: Codex reviews every push to an open pull request automatically. A comment the bot re-reports gets no new answer.
- **Gate on local checks** ([mechanics](documentation/repository/test-lanes-and-checks.md#gate-tiers-and-main-ci)). The worker runs focused checks on what it changed, not `bun run check`: `bun scripts/chef/focused-checks.ts` runs prettier on the changed files, `bun run lint:root` (always: its guards scan every workspace's tests), the root type-check when root or `scripts/` files changed, lint and type-check of each changed workspace, and the affected tests. A test file that starts a process, directly or through a helper, is named `*.integration.test.ts`; when the change reaches one or a `*.slow.test.ts` file, the command also runs `bun scripts/affected-tests.ts run --isolated`. Delivery runs no gate and never merges `main` into the branch; a real conflict goes back to the worker. GitHub Actions is the full tier and the source of `main`'s health: it runs the per-change checks on a pull request and the full suite on every push to `main`, and a red latest `main.yml` run on `main` is the warning `merge-gate.ts` reports (never a refusal; `--fixes-main` declares a repair). Fix a red `main` forward. A change that touches a one-way door, the lock or concurrency infrastructure, or `turbo.json` and the root scripts runs the full suite as `gh workflow run main.yml --ref <branch>` and reads the result with `gh run list --workflow main.yml --branch <branch>`, not a local `bun run validate`.

## Workspace and dependencies

- `applications/*` holds deployable applications, `components/*` browser component libraries, `packages/*` other shared libraries, `internal/*` repository configuration, `testing/*` verification tooling (only in libraries' `devDependencies`), and `plugins/*` Interborough plugins (`scripts/plugin-dependency-rules.ts`). Every workspace is named `@lostgradient/*` except `armorer` and `conversationalist`. The full rules are in [workspace layout](documentation/repository/workspace-layout.md).
- Internal dependencies use `workspace:*`; shared tool versions belong in the root Bun `catalog`, runtime dependencies in the workspace that imports them.
- Component source uses the shared browser TypeScript configuration and lint policy; keep Bun and Node APIs in tests or scripts.
- `internal/typescript` exports only `library.json` and `browser.json`; `base.json` is private.
- Shared libraries export TypeScript source that consumers compile at runtime; add no build step without a packaging need. A library another package type-checks against emits declarations with its `types` script, which consumers list under `references`.
- Use Bun commands only. `bun.lock` is authoritative; update it with `bun install`. Keep `typescript` explicit at the root.

## Release intent

Per-change publishing is paused and there is no `.changeset/` directory: release intent is written in `stevekinney/corvidae-mirror` at backport time, and `scripts/published-exports.json` is updated by hand after it. Interborough releases build from a pinned revision and verify the installed artifact on each target before publishing.

## Turborepo

Mechanics: [Turborepo stage mechanics](documentation/repository/turborepo-stage-mechanics.md).

- Only applications have `build` tasks. Lint, test, and development tasks consume library source and never depend on library builds; `typecheck` depends only on its dependencies' `types` tasks.
- Declare an environment variable in `turbo.json` only when it changes the task's result; give tasks that write reusable artifacts outputs, and keep watchers and mutation tasks uncached. `scripts/task-cache.integration.test.ts` enforces the cache rules.
- Use `--filter` for focused work, or `bun run check` for what a change can reach (`bun scripts/affected-tests.ts --explain` says why). Coverage is a report (`bun run coverage`) that never fails on a floor (owner decision, 2026-11-10).
- The heavy root stages (`validate`, `lint`, `typecheck`, `build`, `release:check`, Playwright, `harden`) hold the host lock of `scripts/run-exclusively.ts`; every `bun test` takes slots from a host-wide pool (`scripts/bun-test-pool.ts`). The wrapper installs first; a bare `bunx turbo run` does not, so run `bun install --frozen-lockfile` after changing a manifest.
- `bun run validate` runs every workspace task except application builds; run `bun run build` when a change can affect a deployed application. Nothing is accepted as a rare failure (COR-1736).

## Worktrees and agents

- Treat each worktree as an isolated checkout; from a fresh one, run `bun install --frozen-lockfile` first. Claude Code uses `claude --worktree <name>`; Codex uses its managed Worktree mode with that install.
- Never copy `.env`, credentials, `node_modules`, caches, or other ignored state between worktrees.
- Preserve unrelated worktrees and branches; remove only a clean worktree the current task created, after its branch is merged or retired.
- Agents never run a bare `git stash` or `git stash pop`: the stash stack is shared by every worktree (`scripts/chef/stash-guard.ts`).

### Parallel runs

The coordinator's rules are in [coordination](.agents/skills/chef/references/coordination.md); every brief carries the worker's part.

- Run at most three agent sessions or implementation workers at once on this host, counting every session that edits or tests this repository; a run has at most two implementation workers.
- Every implementation dispatch names the `chef-worker` agent type. A worker stops at about 150K tokens of context: it commits, pushes, and returns needs-decision with what is done and what remains.
- A coordinator whose context is above about 200K tokens restarts from its run log at a batch boundary, as a fresh session, never `hand_off_to_session`.
- End a turn only on a state change: merged, blocked, needs a decision, or ready for review. Wait on a completion (a background command or a notification); never poll.
- An explicit owner instruction in the current scope outranks these process rules and their guards; a guard stops the worker and hands the case to the coordinator ([decisions](.agents/skills/chef/references/decisions.md#owner-instructions-outrank-process-rules)).

## Dev Container

`.devcontainer/` is a local development environment, not CI, in which `bun run validate` passes from a fresh checkout with only Docker on the host ([the dev container](documentation/repository/dev-container-suites.md)).

## Commands

```bash
bun install --frozen-lockfile
bun run dev
bun run check
bun run build
bun run coverage
bun run release:check
bun run format:check
bun run validate
bun run harden
bun run audit
```

Run quality commands explicitly; there are no Git hooks. Details: [guards](documentation/repository/guards.md), [test lanes and checks](documentation/repository/test-lanes-and-checks.md).

- `bun run audit` tolerates an advisory only through an entry in `scripts/audit-exceptions.ts`; never add a bare `--ignore`.
- `bun run lint:guards` runs the `scripts/check-*.ts` text guards alone, without oxlint; `lint:root` calls it.
- A wall-clock or memory target is a `*.bench.ts` measurement; `scripts/check-wall-clock-assertions.ts` fails a `*.test.ts` that bounds a duration.
- Owner decision: tests that can flake under load stay out of the critical path. Everything `bun run check` and `bun run validate` run has one deadline, the awake-time hang guard (`HANG_GUARD_MILLISECONDS`, 120 seconds), never a performance bound; `scripts/bun-test.ts` passes it, so a `package.json` script never starts `bun test` itself. Wait with `waitUntil`, `awakeTurns`, or `quietFor`, never a sleep, a turn count, a wall-clock deadline, or a timer race ([load-sensitive deadlines](documentation/repository/guards.md#load-sensitive-deadlines)).
- Guard an inherited-key read with `Object.hasOwn`, a `Map`, or `Object.create(null)`; allowlists only shrink. `bun run release:check`, run before a backport, checks documentation coverage, Markdown examples, and test durations.
- A test that does seconds of real work becomes fast or moves to a `*.slow.test.ts` file; a test file that starts a process is a `*.integration.test.ts` file. Together they form the isolated lane, which `test` ignores and `test:slow` runs.

Test tiers. The quick tier, `bun run check`, runs in-process tests only; the full tier is `bun run validate`; `bun run harden` runs the isolated lanes under load. A test that fails in the full tier or in `harden` is never rerun until green, retried, or allowlisted: compare it against the base with `bun scripts/chef/gate-run.ts control`, and file a flake's fix (the mechanism, never a longer deadline) as a COR issue ([test tiers](documentation/repository/test-lanes-and-checks.md#test-tiers-and-the-hardening-pass)).
