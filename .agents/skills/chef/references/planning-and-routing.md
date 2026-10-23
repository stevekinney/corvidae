# Planning and routing

Read this when writing the work-package table, deciding how much grooming the work needs, choosing a model or effort outside the defaults in `SKILL.md`, or escalating a failing package.

## Grooming

Choose how much grooming the work needs. When the `intake-curmudgeon` and `junior-engineer` agents are installed, you may use either or both up front to interrogate unclear tickets, dependencies, and acceptance criteria. You may instead supply precise context and decisions to the team as needed. Do not run both reviewers by habit or make exhaustive grooming a prerequisite for clear work. Record the chosen approach and its cost/quality rationale; provide context before a worker makes a dependent decision, and update the saved charter when that context changes. This discretion does not waive intake gates required for actual Linear creation or edits. Without those agents, apply the Definition of Ready in [the Linear policy](linear-policy.md) yourself and record the result.

Grooming is discretionary; the readiness pass in `SKILL.md` "Understand the work" is not. It runs on every issue before dispatch, however clear the issue reads.

## Work packages

Every package needs:

- A stable identifier, binary outcome, owner, repository or artifact boundary, and concrete files or shared interfaces it may change.
- Dependencies with evidence required to release each edge, including package publication, deployment, and downstream adoption where applicable.
- Batch and parallel-wave membership, agent role, requested model and effort, rationale, and escalation trigger.
- Exact working directory and verification commands, expected exit status or external result, review owner, and completion evidence.
- Its mutation tier: a fresh dedicated worktree, or a shared, canonical, or production checkout (see [worktrees and scope](worktrees-and-scope.md)).

Build an acyclic dependency graph and name the critical path. Diagnose cycles before dispatching affected packages. Dispatch only when every prerequisite's required evidence exists. An implementation merge does not satisfy a publication edge.

Distinguish the gate that starts a package from the gate it produces. When implementation and publication are separate packages, verified implementation completion can release the publication package; the registry artifact produced by publication then releases adoption. Reconcile the implementation issue's state against its own acceptance criteria. Do not make publication wait for its own output or keep a satisfied predecessor open merely because downstream delivery remains incomplete.

Give each batch its own binary acceptance criteria, required verification, integration boundary, and tracking closeout. Close independently completed issues as their gates pass even if another batch remains unfinished; preserve real dependencies and explicit user-required whole-program gates.

For Linear work, maintain native blocker relations. When the `scope-work`, `linear-create-issue`, or `linear-create-project` skills are installed, use them for required new execution boundaries; otherwise write the issue yourself with `scripts/chef/linear.ts create`, which refuses a duplicate title and reads the issue back, after checking the draft against the Definition of Ready in [the Linear policy](linear-policy.md). Reuse existing issues rather than cloning them into worker tickets. Run required intake gates for new or materially revised Linear payloads before writing. Coordinator approval within the user's authorized scope does not require asking the user again.

## Zero-worker plans

A zero-worker plan records why direct coordinator execution costs less without compromising review, plus the coordinator's settings and gates. If delegation is unavailable and direct execution can satisfy the request, record that limitation and proceed; if a required independent review or explicit team requirement cannot be met, report it as blocked. Do not change global agent configuration to force a preferred routing choice.

## Models and effort in detail

Optimize total cost of accepted work, including context, review, retries, and reasoning. Do not equate a fast model or low effort with the cheapest successful result. Use current runtime availability and authoritative pricing if making monetary comparisons; otherwise record relative cost assumptions without inventing prices or token savings.

The table in `SKILL.md` gives starting choices, not a price ranking. At the cached list prices Opus 5.5 costs 40% of Fable 5.1 per token, so reserve Fable for the cases `SKILL.md` names. Haiku 5.5's listed price applies to prompts up to 100K tokens; longer prompts cost $0.50/$2.50. Recheck prices before any monetary comparison.

An implementation dispatch on Opus or Fable instead of Sonnet records its reason in the note at dispatch: a named escalation trigger from the table, or a fixed role that cannot be overridden. The spend report flags every such dispatch with that reason, so a missing reason is visible.

Opus 5.5 is the default coordinator and primary reviewer and suits most agent workloads; Sonnet 5.5 is the implementer for packages with known interfaces, binary acceptance criteria, and tests. Fable's premium buys demanding reasoning, not faster execution of a plan that is already specified. A one-way door is a change that is expensive to undo once it ships; a two-way door is internal code a later change can cheaply alter (AGENTS.md "Review guidelines").

Effort runs low through max, and `xhigh` is the usual sweet spot for capability-sensitive coding. Set effort on every dispatch instead of inheriting a default, because Opus 5.5 defaults to `medium` while Sonnet 5.5 defaults to `high`. The coordinator's own effort is the session's setting; record it. Inspect each role's effective model and supported effort instead of assuming a Codex mapping. Prefer a suitable installed role with known settings. If effort cannot be selected, record the configured or inherited value; if unknown, say unknown.

Keep the current coordinator model unless a supported mechanism and authorization allow changing it. Record its actual or inherited settings. Reserve its context for dependency decisions, integration, review, and delivery. Specialist roles can have fixed model and effort settings; never claim an override worked without evidence. For Codex overrides, use a fresh charter such as `fork_turns: "none"` and only supported `model` and `reasoning_effort` fields. For Claude Code, pass the Agent tool's `model` (`sonnet`, `opus`, `haiku`, or `fable`) and `effort` on each dispatch; this routing policy is the explicit instruction that authorizes setting effort. A fixed role definition overrides both. Record the requested values, and the resolved model when a result reports it; a dispatch result is not proof of what ran.

Keep the same owner, meaning the same package, charter, and findings, through a coherent correction cycle. Whether that owner is resumed or re-dispatched fresh with a compact brief is a context decision; see "Keep contexts small" in `SKILL.md`. Measure cache behavior from transcripts rather than inferring it from dispatch shape, and record observed usage.

## Escalation

Escalate only the failing package. After two unsuccessful attempts at the same defect or acceptance criterion, stop patching, inspect the failure and control, and reassess the causal model before another correction. Record the revised diagnosis and whether scope, budget, ownership, or quality requires a user decision. The counter belongs to the defect across agents, renamed tasks, and follow-ups; replacement never resets it. A regression that a correction introduces in the same module or state machine counts as another attempt at the same class, not as a new defect. After the second, hand the class to the escalation tier for a design pass over the whole outcome space, not a third local patch. A worker whose `review-threads.ts classes` check exits 1 has reached the same point by a different count, and gets the same reassessment. A missing credential, active owner, or absent external artifact requires resolving that dependency, not a larger model. Never lower quality gates to save tokens.

For concurrency, replay, retry, or state-machine work, require an outcome matrix before implementation: every input or failure the code can meet, crossed with every exit it can take, each with its required result. Write it into the acceptance criteria and have the worker turn it into a table-driven test that is red first. The matrix is the guard for the class; scenario lists invite one correction per missed cell.
