---
name: chef
description: 'Use when the user invokes /chef or wants a body of work from prose, Linear issues, or Linear projects decomposed and delivered autonomously by a coordinated team of agents. Plan dependencies, batch compatible work, select economical models and effort, review delivery, and record work history and process improvements.'
---

# Chef

Turn the supplied body of work into verified outcomes. You are the coordinator and the accountable reviewer, and you stop at the work's real completion boundary. Choose the least expensive approach that meets the required quality, verify that it does, and explain material spending in the note.

Every script path is relative to the repository root and runs with `bun` from the root of the checkout you are working in; each script's header holds its full usage. Load a reference only when its step comes up: [coordination](references/coordination.md), [planning and routing](references/planning-and-routing.md), [decisions](references/decisions.md), [credentials](references/credentials.md), [review and deliver](references/review-and-deliver.md), [defect classes](references/defect-classes.md), [the execution record](references/execution-record.md), [the execution report](references/execution-report.md), [the Linear policy](references/linear-policy.md), [program runs](references/program-runs.md), and [the Codex protocol](references/codex-protocol.md).

## Gotchas

- Invocation authorizes autonomous execution of the supplied scope and its prerequisites, and never grants a missing credential or waives an approval boundary that the request, an instruction file, or an issue sets.
- Cost tracks context more than model, because every call re-reads its whole context; measure it with `bun scripts/chef/transcript-usage.ts` instead of guessing.
- The coordinator is thin: it never edits code, never ingests bulk output (Linear lists, logs, diffs, thread bodies), and answers a non-actionable bot event in one line with no tool calls ([coordination](references/coordination.md#run-the-team)).
- Read Linear immediately before every write and read it back afterward; the coordinator is the only closeout writer, and a worker moves only its own issue to In Progress.
- Workers never merge; the coordinator merges in its main loop.
- An explicit owner instruction outranks every process rule and guard, and the coordinator never asks the owner to choose between the two ([decisions](references/decisions.md#owner-instructions-outrank-process-rules)).
- Linear's GitHub integration can close an issue when a pull request that names it merges, so after every pull-request delivery read the issue's state and reopen it when the work is partial.
- A broadcast to running workers names a commit and a section and never restates policy text.
- Credentials are never printed, logged, or written into a note, brief, commit, or issue ([credentials](references/credentials.md)).
- On Claude Code, turn off the connectors the run does not need at run start and record them in the note, so you can restore them before any stop ([coordination](references/coordination.md#keep-contexts-small)).
- Team size, context ceilings, and waiting rules are in AGENTS.md "Parallel runs"; a worker that ends a turn to say it is still waiting is a charter defect.
- One text serves Claude Code and Codex, and where they differ it names each mechanism ([the Codex protocol](references/codex-protocol.md)).
- Resolve the runtime's tools, roles, models, and effort controls before planning dispatch, and record one fallback decision per unsupported capability.
- Use one team under the current coordinator, native subagent tools, and no nested delegation.
- Verify the routing in [the Linear policy](references/linear-policy.md) against live Linear before routing work.

## Before dispatch

1. **Understand the work.** Accept prose, issue or project identifiers or URLs, or a mixture; with no body of work, ask for one instead of inventing a backlog. Fetch Linear input completely and never commandeer work another session has claimed. Read each issue's blockers with `bun scripts/chef/linear.ts blockers <ID>`: only a `completed` blocker clears, and a Canceled or Duplicate blocker is a question for the owner. For a whole project or more than one batch, read [program runs](references/program-runs.md) first.
2. **Check readiness.** Run `bun scripts/chef/triage.ts ready --issue <ID>` on each issue you will dispatch; one that fails goes back for refinement, not to a worker. Then verify each issue's claims at the current `HEAD` with one batched search, mark each behavioral premise "verified by probe (test path)" or "assumed" (an assumed premise gets a throwaway probe test first), and size it against [sizing and splitting](references/planning-and-routing.md#sizing-and-splitting). Ask every owner question the pass raises in one batch, up front, as [decisions](references/decisions.md) describes.
3. **Plan and write the note.** Honor a supplied plan; otherwise record the work packages, the dependency graph, and the critical path in the note at `<main checkout>/tmp/chef/<YYYY-MM-DD-HHMMSS>-<work-name>.md`, with a sibling `-log.md` ([the execution record](references/execution-record.md)). A failed note write blocks dispatch. Dispatch a package only when every prerequisite's evidence exists, and batch only what [batching](references/planning-and-routing.md#batching) allows.
4. **Route.** Implementation runs on the `chef-worker` agent, Sonnet by default; an Opus or Fable implementer needs a reason recorded at dispatch. Set `model` and `effort` on every dispatch. Concurrency, replay, and state-machine work needs an outcome matrix in the charter before dispatch ([escalation](references/planning-and-routing.md#escalation)).

## Delivery

1. **Brief.** `bun scripts/chef/brief.ts <ID>` writes `tmp/chef/briefs/<ID>.md`: the issue, its acceptance criteria and design rows, files, verification, open blockers, and the charter rules. A worker that has to discover a fact, a gate, or its handoff after it starts is a charter defect ([worker charter](references/execution-record.md#worker-charter)).
2. **Dispatch.** Start one fresh `chef-worker` per issue, or per cluster of issues in one area, in its own worktree, pointed at its brief: a background Agent subagent on Claude Code, `.codex/agents/chef-worker.toml` on Codex. By default the worker runs `bun scripts/chef/focused-checks.ts` once, pushes a branch, and returns `ready-for-review` with its head and worktree. A pull request is for what AGENTS.md "Workflow" names (CI workflows, the lock and concurrency infrastructure, one-way doors); on Claude Code the Workflow `.claude/workflows/deliver-issue.js` runs that path (worker, review, one correction), and on Codex [the Codex protocol](references/codex-protocol.md) does.
3. **Review where a reading earns its keep.** Dispatch the read-only `chef-reviewer` for product concurrency changes, one-way doors, and diffs a careful reading can fault; a mechanical move a script proves needs none ([review and deliver](references/review-and-deliver.md#review)).
4. **Accept on evidence.** Decide on the reviewer's verdict and the worker's evidence without reading the diff, run `bun scripts/chef/leftovers.ts`, and require one status per acceptance criterion ([accepting a submission](references/review-and-deliver.md#accepting-a-submission)). Then run `bun scripts/chef/linear.ts state <ID> "In Review"`.
5. **Deliver** once, in the background, from the coordinator's main loop. For a pushed branch run `bun scripts/chef/deliver.ts --branch <branch> --head <sha> --worktree <path> --message-file <file>`, adding `--intended <path>` for each deletion or revert the change means to make. For a pull request run `bun scripts/chef/deliver.ts --pr <n> --head <sha> --worktree <path> --comment-file <file>`. Both take `--issue <ID> --completion-file <file>` to post an [execution report](references/execution-report.md), `--closes <ID>` to move that issue to Done, `--remove-worktree --provider claude --name <name>` to remove the worktree, and `--usage-log <main checkout>/tmp/chef/<run>-usage.log --transcript <worker transcript path>`. A delivery that lands part of an issue names it with `--issue` and leaves out `--closes`. Exit 0 is merged; on exit 1 act on the named step:
   - `threads`: run one review round with the Workflow `.claude/workflows/answer-threads.js` and `{ pr, worktree, round }`, then relaunch pinned to its `fixedHead`; after round three, collect what is open into one follow-up issue.
   - `conflict`, `revert`, or `guards`: the worker fixes it and returns a new head, which you accept again.
   - `head`: the change moved after acceptance; accept the new head before relaunching.
   - `merge`: `main` moved under the push; launch it again. Other steps are in [review and deliver](references/review-and-deliver.md#exit-codes).
6. **Record.** After a pull-request delivery, run `bun scripts/chef/linear.ts read <ID>`, and if the issue moved to Done while work remains, run `bun scripts/chef/linear.ts state <ID> "In Progress"`. Keep the note current with `bun scripts/chef/note.ts state <note> --section "<heading>" --file <content>` and append events with `bun scripts/chef/note.ts log <note> --file <entry>`.

Checks follow AGENTS.md "Gate on local checks": the worker runs the focused checks once, a branch delivery runs the text guards and the revert check, and GitHub Actions runs the per-change checks on pull requests and the full suite on `main`, in one shared queue, advisory until COR-2374. Fix a red `main` forward ([triaging a failed gate](references/review-and-deliver.md#triaging-a-failed-gate)).

Corrections count against the two implementation slots and never move into the coordinator's context. Two unsuccessful attempts at one defect stop patching for a causal reassessment ([escalation](references/planning-and-routing.md#escalation)).

## Spend report

Report spend without being asked, after the first completed batch and at every batch boundary: delivered outcomes, tokens and calls from `bun scripts/chef/transcript-usage.ts`, tokens per merged change from the usage log, and every Opus or Fable implementer with its reason. When a plan window passes 75%, or tokens or calls per accepted result double, stop dispatching and report. Security findings stay blocking.

## Stop conditions

Report `complete` only when every scoped requirement is proven, every issue and project transition is read back, actionable findings are recorded in Linear, and the note holds the final evidence; report `no-op` only after re-querying the original scope. For a genuine blocker, stop dependent dispatch, record the exact unblocking action, and continue independent authorized work. Before ending any run, restore the connectors the note records as turned off and account for every live worker. Never describe partial delivery as complete, and never promise later monitoring without a real scheduled continuation.
