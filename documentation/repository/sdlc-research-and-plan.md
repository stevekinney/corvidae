# SDLC research and proposed plan

Research date: 2026-11-17. Repository baseline: `721367ba220dc2384c83ee1c33b3a38bdf702e5b`. Status: research and recommendations; no workflow policy, automation, or source cleanup has been enacted by this document.

The [SDLC implementation plan](sdlc-implementation-plan.md) now owns the execution sequence, acceptance criteria, verification commands, team assignments, and completion of reused pull requests. This document preserves the research and source audit; the earlier implementation outline below is superseded by that plan.

This spike combines the supplied Agentic Engineering Comprehensive Report, inspection of the current repository, and primary research. The supplied report is a proposal, not an instruction to install its suggested roles, skills, or controller. Research findings below distinguish measured results, vendor guidance, source inspection, and our recommendations. Paper versions matter: indexed passages sometimes described older versions, so consequential claims were checked against the canonical arXiv version.

## Recommendation

Keep Chef's delivery primitives, simplify its instructions, and make orchestration conditional. Its strongest contributions are bounded assignments, isolated worktrees, ownership records, pinned candidate heads, guarded integration, and recoverable progress. Its weakest parts are duplicated policy, model calls for mechanical work, report formatting treated as a gate, and completion rules that rely on the coordinator remembering what evidence means.

The objective is cost per verified outcome, including unsuccessful attempts, corrections, verification, and human intervention. Neither tokens per changed line nor merged-issue count measures that objective. We cannot establish that all software works for every input; we can identify the supported behaviors, test the risks that threaten them, verify the actual artifact, and detect and contain failures after release.

Build on the existing scripts. Do not introduce another orchestration framework, generalized agent memory service, vector database, or fleet of specialized agents for this plan.

## Is Chef worth keeping?

### What both providers actually use

The Codex and Claude Code skill paths are symlinks to the same [Chef skill](../../.agents/skills/chef/SKILL.md). There are not two independent skill documents to reconcile. The shared skill is 1,490 whitespace-delimited words; its eleven references add 8,220, for 9,710 total. References are loaded on demand, so this is a maintenance surface, not a claim that every invocation injects all those words.

The provider implementations do differ:

| Surface | Codex | Claude Code | Assessment |
| --- | --- | --- | --- |
| Delivery sequence | [Manual protocol](../../.agents/skills/chef/references/codex-protocol.md) | [Executable delivery workflow](../../.claude/workflows/deliver-issue.js) for the pull request path | Shared prose does not guarantee equivalent execution. |
| Worker | [TOML role](../../.codex/agents/chef-worker.toml), fixed `gpt-5.6-terra`, medium effort | [Markdown role](../../.claude/agents/chef-worker.md), `sonnet` | Routing prose recommends a cheaper Codex implementation tier than the fixed role selects. Verify the actual model, not the requested label. |
| Reviewer | TOML role `.codex/agents/chef-reviewer.toml` (since replaced by `stickler`), high effort, read-only sandbox setting | Markdown role `.claude/agents/chef-reviewer.md` (since replaced by `stickler`), no model pinned there, Bash available | Claude's role prohibits writes in prose; Bash availability means that prohibition alone is not an operating-system read-only boundary. |
| Worker admission and edit guards | No corresponding wiring found in the checked-in Codex role files | [Settings hooks](../../.claude/settings.json) invoke host admission, stash, and edit guards | Test runtime capabilities explicitly. This inspection does not establish what every installed Codex harness enforces. |
| Brief preparation | Coordinator invokes the script | A Haiku agent invokes the script, reads the Markdown, and extracts blockers | Extend the script's structured result to carry blockers; remove the model from this mechanical operation. |
| Review corrections | Manual sequence | Workflow launches correction and review agents | Preserve one owner, explicit attempt counts, and reviewed-head identity across both paths. |

The [November 11 assessment](chef-assessment.md) records real use of the delivery tools and prior removal of unused machinery. Its transcript counts are historical, predominantly Claude Code, and do not compare Chef against an alternative on equivalent outcomes. They support keeping useful tools, but do not prove the current end-to-end workflow has positive return on investment.

### What earns its cost

- Keep `brief.ts` as the way to produce one accepted assignment with criteria, dependencies, and verification commands. Include only relevant policy in the worker's brief.
- Keep worktree isolation, process ownership, stale-branch checks, conflict checks, and serialized integration. These prevent concrete cross-session failures that prose alone cannot prevent.
- Keep `focused-checks.ts` for inexpensive local feedback, the existing affected-test machinery for broader verification, and installed-artifact checks for releases. Each answers a different question.
- Keep independent review for concurrency, authorization, persisted formats, published contracts, and agreed design. Review the changed behavior and its oracle; do not repeat every previous review.
- Keep compact resumable state, transcript accounting, and the existing two-failure causal reassessment rule.

### What needs to change

| Finding in current source | Consequence | Proposed change |
| --- | --- | --- |
| Both worker roles and `brief.ts` say to push after every commit, while the batch brief and skill say to push once at the end. | A worker must reconcile incompatible procedures; intermediate pushes can trigger extra review or CI where configured. | Define checkpoint publication separately from candidate verification. Preserve recoverable commits, but launch one verification/review cycle for the stable candidate. Render this policy from one source. |
| Worker descriptions say “exactly one issue,” while their bodies and generated briefs permit batches. | Dispatch scope depends on which instruction the worker prioritizes. | Describe one cohesive assignment, which may contain multiple explicitly ordered issues. |
| The skill says the coordinator never edits; a reference permits direct execution for small work. | Cheap tasks can acquire an unnecessary delegation boundary. | Put the direct-versus-coordinated route at the top of the skill. A direct run uses the same verification and delivery primitives. |
| The skill requires explicit model/effort selection, while fixed Codex roles and several Claude workflow calls supply different or inherited settings. | Planned spending can differ from actual execution. | Resolve provider capabilities once and record requested and observed model/effort. Treat unsupported overrides explicitly. |
| `executionReportProblems()` in [deliver.ts](../../scripts/chef/deliver.ts) checks a marker and ten ordered headings. `--closes` then permits moving the issue to Done after merge. | A correctly formatted report can describe incomplete evidence; the command does not independently validate those assertions. | Validate a compact evidence record against the accepted criteria and delivery boundary. Generate the human report from that record. |
| Current delivery intentionally does not wait for CI; latest `main` health is advisory. | “Merged,” “verified,” and “delivered” can diverge. | Keep these as separate states. Required sensitive-change checks gate integration; all applicable release obligations gate delivery. This is a proposed policy change, not a description of the current rules. |
| Coordination guidance gives fixed tool/context cost figures and line-count sizing rules. | Historical harness observations become universal policy; adding code can appear to improve efficiency. | Keep observations dated. Size by independently verifiable behavior and coupling; measure total cost per accepted outcome. Remove the 300-line floor. |
| [Workflow tests](../../scripts/chef/workflows.test.ts) largely inspect source strings; [moved-rule tests](../../scripts/process-docs-moved-rules.test.ts) preserve phrases. | Text can stay compliant while execution changes, and useful simplification can fail a wording test. | Preserve command/link validation; replace semantic phrase assertions with behavioral scenarios for the policy they protect. |

One additional ownership limit matters: [claimIssue() and leaseProject()](../../scripts/chef/linear.ts) read, write a comment/update, then read back. These are useful coordination records, but not atomic exclusion. Two callers can both read “unclaimed,” then A can write/read/return before B writes/reads/returns. Source inspection establishes this possible interleaving; this spike did not reproduce it against live Linear. Use the existing host-lock primitive to serialize claim acquisition for the supported single-host scope, and validate the current owner before consequential transitions. A future multi-host controller would need an actual shared conditional-write mechanism and fencing; do not claim that comment read-back supplies one.

### The smaller Chef

Chef should explain five responsibilities: accept the scope; select direct or coordinated execution; implement with focused feedback; verify the candidate and review its risks; integrate and reconcile actual delivery evidence. Each responsibility should name the relevant command and failure signal. Provider-specific references should cover only dispatch, capabilities, and resume mechanics.

For a small cohesive change, one agent can own implementation and invoke the shared commands. For a program with separable work, a coordinator manages dependencies and at most the currently allowed worker count. Choose that route from the task's structure; do not force every large task through a failed single-agent run before allowing coordination. Shared state or tightly coupled modules stay with one owner.

## Research that changes the plan

### Instructions and context

[Evaluating AGENTS.md, v3, September 2026](https://arxiv.org/html/2602.11988v3) evaluates four model configurations using SWE-bench Lite and 138 CTXbench tasks from twelve Python repositories. Generated context files increased cost without a statistically significant success improvement; developer-written files performed better than generated ones, but did not significantly beat no context. Its scope is task resolution, not all security or maintainability requirements. Apply this as a reason to evaluate nonredundant instructions, not to delete repository-specific constraints wholesale.

The apparently contrary [AGENTS.md efficiency study, v2, March 2026](https://arxiv.org/html/2601.20404v2) covers ten repositories and 124 pull requests, finding lower median runtime and output tokens with instructions. Its methods explicitly exclude comprehensive semantic correctness evaluation; a manual sanity check of fifty outputs is not equivalent. These papers do not establish opposite answers to the same quality-adjusted question. Our comparison must grade correctness and cost together.

[When Instruction Files Go Stale, November 2026 preprint](https://arxiv.org/html/2611.09802v1) studies three stale instructions, 22 tasks, and 732 trajectories. Agents often recovered and completed tasks while following obsolete paths; some apparent checks ran no tests. The cost effect was case- and model-dependent. Add instruction-command smoke tests that establish the expected tests actually ran, and repair stale guidance when encountered. A shorter file containing a wrong command remains harmful.

[The Complexity Trap, v3, October 2025](https://arxiv.org/html/2508.21433v3) compares observation masking with model summarization in SWE-agent, with a smaller OpenHands generality probe. Masking verbose old tool observations was competitive with summarization and substantially cheaper than retaining raw history; a tuned hybrid improved further. This is evidence for compact tool results and retrievable raw artifacts. It does not prove that we can replace the managed Codex or Claude compactor. Keep stable instructions, return bounded summaries from tools, and retrieve raw output only for a concrete question before building custom summarization infrastructure.

### Coordination and measurement

[Towards a Science of Scaling Agent Systems, v3, April 2026](https://arxiv.org/html/2512.08296v3) compares 260 configurations across six benchmarks and finds strongly task-dependent coordination effects. Its predictive model has modest cross-domain explanatory power. Do not turn its accuracy thresholds or error-amplification ratios into universal Chef rules. Use dependency structure, tool overhead, and locally measured outcomes to decide when another agent is useful.

[Effective Strategies for Asynchronous Software Engineering Agents, v2, July 2026](https://arxiv.org/html/2603.21489v2) provides a positive counterexample: isolated worktrees and explicit integration improve long-horizon library-development and paper-reproduction scores. Coordination also costs more; PaperBench uses the Code-Dev protocol and a model judge rather than full reproduction. The study supports preserving Chef's isolation and integration mechanisms, while rejecting the assumption that multiple workers automatically save tokens. Task coupling should influence routing before work begins.

[METR's February 2026 experimental update](https://metr.org/blog/2026-02-24-uplift-update/) explains why task/developer selection and noncompliance make later productivity estimates hard to interpret. Its early-2025 slowdown result should not be presented as today's general effect. For Chef, compare predefined tasks under controlled conditions and report human intervention, failed attempts, and review work; do not infer productivity from adoption, impressions, or pull request counts.

[Anthropic's agent-evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) distinguishes a transcript's claims from the final environment state and recommends repeated trials and calibrated graders. This is vendor engineering guidance, not a controlled estimate of Chef's benefit. Use deterministic outcome checks for code and workflow transitions, retain human judgment for design and product acceptance, and evaluate the harness together with its actual model configuration.

### Verification and testing

[On the Risks of using LLM-Generated Tests, October 2026 preprint](https://arxiv.org/html/2610.11835v1) injects faults into historical changes from SciPy, Qiskit, and pandas, then studies tests generated without access to the reference implementation. Some tests enforce the faulty behavior and persist through later changes. This is a seeded-fault experiment, not an estimate of our current defect rate. Require expected behavior to come from a contract, known-good example, invariant, or independent implementation. A green test generated from the implementation is weak evidence by itself.

[Google's Practical Mutation Testing at Scale](https://research.google/pubs/practical-mutation-testing-at-scale-a-view-from-google/) describes changed-code mutation, filtering, and limits on actionable mutants. The publisher abstract supports the technique; this spike did not inspect the paywalled full study. Pilot mutation on changed high-risk predicates and known regression classes, not a whole-repository mutation gate. Reject equivalent or out-of-contract mutants rather than optimizing a universal mutation score.

[Meta's predictive test-selection deployment](https://engineering.fb.com/2018/11/21/developer-tools/predictive-test-selection/) reports substantial savings using historical change/test outcomes, while retaining exhaustive testing before deployment. Its high change-level recall does not mean every relevant test was selected or every regression was impossible. We already have graph-based selection; improve and audit that first. Run any more aggressive selector in shadow against full results before allowing it to omit a gate. There is no present justification for building an ML selector.

[FoundationDB's simulation documentation](https://apple.github.io/foundationdb/testing.html) describes reproducible schedules and injected failures, alongside live performance and hardware testing. Adopt the principle narrowly: deterministic event schedules for Chef ownership, retries, cleanup, and partial completion. Corvidae already has [host-session interleaving tests](../../scripts/host-sessions-model.test.ts); extend that pattern instead of building a general simulation platform.

[Turborepo's caching documentation](https://turborepo.dev/docs/crafting-your-repository/caching) makes determinism and known inputs prerequisites for reuse. Corvidae already tests transitive cache inputs and artifact restoration in [task-cache.integration.test.ts](../../scripts/task-cache.integration.test.ts). Preserve valid cached evidence, label it as reused, and invalidate it when a relevant input changes. Recording a candidate SHA is useful provenance; hashing the entire SHA into every task would unnecessarily discard reuse.

## Verification with less waste

Use a small number of layers with explicit obligations:

| Boundary | Evidence | Avoid |
| --- | --- | --- |
| Editing | Direct regression tests, formatter, lint, types | Full suites on every attempted repair |
| Stable candidate | Affected consumers, integration boundaries, applicable browser/design checks | Treating sibling-test selection as proof about all consumers |
| Integration | Reviewed head, current ownership, conflict/revert checks, required sensitive-change checks | Accepting evidence for a different candidate or merged tree |
| Delivery | Tested artifact digest, installation/startup, required user journeys and deployment health | Marking an issue delivered because a branch merged |

An evidence entry needs its criterion, command, exit status, test inventory/count where available, source and task-input identity, environment/toolchain assumptions, artifact path, and whether execution was fresh or reused. Pending, failed, canceled, skipped, not applicable, and reused-pass must remain distinguishable. No tests discovered is a failure for a check expected to execute tests; documentation-only selection can legitimately contain no behavioral tests when recorded as such.

Maintain exhaustive behavior cases in the cheapest layer that can observe them, a few real integration tests at each external boundary, and a compact set of browser journeys for wiring. Preserve the full visual matrix when a shared token or component change can affect it. Do not remove real rendering, cold-start, filesystem/process, authorization, durability, or installed-package boundaries merely because unit tests cover similar branches.

For every bug regression, demonstrate failure on the relevant broken control and success on the fix. For tricky state transitions, test properties such as at-most-one owner, stale completions cannot release new ownership, retries preserve operation identity, and a post-merge tracker failure cannot trigger a second merge. Use targeted mutations to check that the assertions detect the intended class.

Remove a test only when its behavior is retired or equivalent retained coverage is identified and shown to detect the relevant fault. Structural phrase checks can be replaced by behavioral checks; deleting a slow but unique boundary test is not simplification. Existing coverage and required checks remain in force until a policy change is explicitly adopted.

## What to stop doing

- Stop using an agent to run a command, extract a known field, or render a status report when ordinary code can do it.
- Stop optimizing tokens per changed line and enforcing a minimum change size. Batch cohesive outcomes; retain independent closeout and delivery boundaries.
- Stop copying the same policy into the skill, worker roles, generated briefs, protocol, and report template. Keep one owned policy source and thin provider-specific configuration.
- Stop loading every reference, raw log, issue comment, and diff into the coordinator. Retrieve only the unresolved question's evidence.
- Stop rerunning unchanged checks or rereviewing unchanged decisions. Reuse evidence only while its inputs and assumptions remain valid.
- Stop treating report headings, a worker's “Verified,” or a successful merge as executable proof of completion.
- Stop requiring a full team or a separate specialist review for mechanical changes already proven by an appropriate check.
- Stop swallowing process failures through pipelines or accepting a successful command that exercised no intended tests.
- Stop adding a permanent rule for every anecdote. A recurring failure earns a regression, lint/type constraint, or bounded workflow test; retain its rationale outside the active prompt.

## Infrastructure to prevent relapse

Use existing Chef scripts as the control surface. Add only the missing durable facts and enforcement:

- One versioned policy for assignment scope, candidate publication, review requirements, verification obligations, and completion semantics. Provider files describe capabilities rather than repeat policy.
- One compact execution record with append-only events for ownership, candidate revisions, attempts, evidence, integration, and delivery. Generate the note and Linear report from it. Reconcile external state after interruption instead of assuming a recorded command completed.
- A deterministic transition validator that refuses stale evidence, an obsolete owner, incomplete required criteria, or unavailable delivery proof. It should return the missing evidence and next action without spending an LLM turn.
- Cumulative accounting across coordinator, workers, reviewers, retries, and resumed sessions. Separate cached input, uncached input, cache writes, output, and tool/CI cost where available. Use actual prices only when supplied and dated. An unavailable usage feed is unknown, not zero. Enforce a caller-supplied allowance before dispatch where the harness supports it; do not promise precise mid-call hard limits in managed interfaces that lack them.
- Behavioral workflow scenarios shared by both provider routes, plus command/link validity checks and a budget on the effective loaded instructions. A smaller top-level skill is not a saving if it causes all references to be loaded.
- Entrypoint-aware unused-code analysis and checks that every required guard is invoked. [Knip's documented Bun support](https://knip.dev/overview/getting-started) makes it a candidate, but dynamic entrypoints, scripts, benchmarks, and framework-generated imports need configuration before its output can authorize deletion.

Use the first implementation to prove these facts for one representative path. No database service or new dashboard is required. Do not revive the previously removed Chef decision-model, packet, or mutation-wrapper machinery without a demonstrated consumer.

## Original implementation outline

This outline records the initial research recommendations. Use the [consolidated implementation plan](sdlc-implementation-plan.md) for dispatch, dependencies, bounded evaluation, and delivery gates.

These are recommendations for the next agreed implementation plan, not newly created tickets. Each unit has a bounded artifact and a binary verification boundary. Sensitive changes continue to require the repository's independent review and branch CI procedure. Commands below use existing entrypoints; run them from the repository root after the normal frozen-lockfile installation. A listed test command is an acceptance gate for the future implementation, not a claim it ran during this research.

### Establish the comparison

Extend the existing transcript-accounting and execution-record surfaces to record outcome identity and all attempts. Prepare a small fixed bank of representative repository tasks: a local defect, a cross-workspace contract change, a concurrency defect, a UI change with design criteria, and an interrupted delivery. Keep held-out tasks for the comparison rather than tuning every instruction against the same examples.

Acceptance: every trial records provider, actual model/effort when observable, policy version, base revision, task, all attempts, required checks, outcome, human intervention, and usage or an explicit unknown. Run current Chef and the simplified route on identical task snapshots, randomize order, use repeated trials, and grade final artifacts independently of the author's report. Report uncertainty; a small pilot can find failures but cannot prove equal quality. Select the smallest sample that can answer the pilot question, then expand only if the result remains inconclusive and the budget permits.

Verification: `bun scripts/bun-test.ts scripts/chef/transcript-usage.test.ts`; analyze captured trials with `bun scripts/chef/transcript-usage.ts --json <transcript-path>`. Changing the telemetry does not require launching the paid comparison in the same unit.

### Simplify the shared policy and provider routes

Own the change in `.agents/skills/chef/`, `scripts/chef/brief.ts`, both Chef role pairs, and the two Claude workflow files. Correct contradictory push/scope/model wording. Return blocker data directly from brief generation and use deterministic preparation. Retain provider-specific dispatch mechanisms while making their outcome contracts identical. Replace redundant report prose with a rendered compact view once the evidence validator below exists; do not remove necessary evidence fields first.

Acceptance: a direct assignment and a multi-issue batch each produce one unambiguous contract; supported provider routes agree on blockers, candidate identity, review disposition, and delivery boundary. Preparation invokes no model. An invalid brief dispatches no worker. Requested versus actual model differences are visible. No permanent minimum line count remains.

Verification: `bun scripts/bun-test.ts scripts/chef/brief.test.ts scripts/chef/workflows.test.ts scripts/chef/command-spellings.test.ts scripts/process-docs-budget.test.ts scripts/process-docs-references.test.ts scripts/process-docs-moved-rules.test.ts`; `with-turborepo-cache bun scripts/chef/focused-checks.ts --json`.

### Enforce ownership and evidence transitions

Extend `linear.ts`, `deliver.ts`, the existing delivery ledger, and the existing merge paths. Serialize supported same-host claim acquisition using the existing lock primitive; preserve live ownership checks at dispatch and delivery. Validate an explicit evidence record before a transition that claims verification or delivery. Separate integration from release completion, including partial integration and per-issue closeout within a batch.

Acceptance: two concurrent same-host claimers cannot both receive permission to dispatch the same issue; a stale owner or head is refused; failed, missing, wrong-revision, and unexpectedly empty verification cannot close an issue; valid reused evidence is accepted; merge success followed by a Linear failure resumes closeout without a second merge; missing installed/deployed-artifact evidence keeps a release obligation open. Behavioral tests inject failures at each side-effect boundary. All current ownership/deletion protections remain exercised.

Verification: `bun scripts/bun-test.ts scripts/chef/linear.test.ts scripts/chef/deliver.test.ts`; `bun scripts/bun-test.ts scripts/chef/direct-merge.integration.test.ts scripts/chef/merge-gate.integration.test.ts`; focused checks; `gh workflow run main.yml --ref <branch>` for the stable infrastructure candidate. Verify the dispatched run's actual head and final result, not merely that dispatch returned successfully.

### Audit test selection and evidence reuse

Extend the current affected-test and cache tests instead of adding a second selector. Cover root scripts, shared configuration, dynamic entrypoints, transitive consumers, and browser fixtures explicitly. Record selected and excluded obligations. Compare proposed selections against existing full CI results without omitting gates during the comparison.

Acceptance: known dependency changes select the relevant checks; unknown ownership takes the documented conservative fallback; changing a relevant input invalidates evidence and changing an unrelated input preserves it; every omitted failure in the comparison is investigated and resolved before the selector gains authority. CI obligations remain distinguishable from local feedback.

Verification: `bun scripts/affected-tests.ts --explain --base <base-sha>`; `bun scripts/bun-test.ts scripts/affected-tests.test.ts scripts/chef/focused-checks.test.ts`; `bun scripts/bun-test.ts scripts/task-cache.integration.test.ts`; focused checks and the branch workflow for root/cache changes.

### Improve the oracle for one high-risk behavior

Choose one existing ownership or delivery transition. Derive its expected behavior from the accepted contract, add deterministic interleavings and representative fault injections, and demonstrate the tests detect intentionally broken versions. Use the host-session model tests as the existing pattern. This unit proves the method before expanding it across the codebase.

Acceptance: the intended invariants pass; each named wrong behavior fails for the intended reason; the same event sequence reproduces the same result; at least one real integration check covers the boundary the simulation replaces. No performance deadline substitutes for an invariant, and no assertion is weakened to match the implementation.

Verification: `bun scripts/bun-test.ts scripts/host-sessions-model.test.ts` plus the selected owning test file through `bun scripts/bun-test.ts <test-file>`; focused checks; applicable infrastructure CI. Record the broken-control and repaired results separately.

### Remove demonstrated orphans and add reachability protection

Remove the confirmed candidates below only after rechecking their callers against the implementation base. Configure an entrypoint-aware unused-code report before making it blocking. Classify manual commands explicitly, including their owner and purpose. Prove the wiring check detects a deliberately disconnected required guard, then restore the fixture.

Acceptance: removed runtime files have no supported entrypoint or consumer; their tests disappear only with their retired behavior; declaration resolution still targets the source; current manual/release/benchmark entrypoints remain reachable; unused-code and guard-wiring fixtures detect their seeded defects. No blanket ignore hides a category of results.

Verification: `bun run typecheck:root`; `bun scripts/bun-test.ts scripts/process-docs-references.test.ts`; `with-turborepo-cache bun scripts/chef/focused-checks.ts --json`. After Knip is installed and configured under the dependency policy, use `bun run knip` as the new entrypoint and record its configuration and exit status. That command does not exist in the baseline.

The comparison/telemetry unit establishes the baseline before instruction changes. Policy simplification and evidence enforcement share contracts and should have one integration owner. Test-selection work depends on the evidence identity. The narrowly scoped cleanup can proceed independently, except that its retained entrypoints must inform the later reachability configuration. Keep high-risk test improvements with the owner of the transition they verify.

## Cleanup inventory

Static reference and module-resolution inspection identified five strong candidates totaling 329 lines. This is evidence for a cleanup patch, not a claim that a full dead-code analysis or deletion validation has already passed.

| Candidate | Lines | Evidence and disposition |
| --- | --- | --- |
| `components/cinder/scripts/component-conventions-hydration.ts` | 166 | No current callers of the module or its exported helpers found. Remove after the final entrypoint check. |
| `components/cinder/scripts/component-source-filter.ts` | 12 | No current callers found. Same disposition. |
| `scripts/shiki-grammar-assets.ts` | 51 | Its only current code consumer is its own test; a historical migration document mentions it. Remove with the test if no supported manual command is identified. |
| `scripts/shiki-grammar-assets.test.ts` | 76 | Exercises the orphan helper above. Do not count its existence as evidence the helper is used. |
| `scripts/test-deadlines.d.ts` | 24 | Redundant declaration beside the source. The inspected TypeScript resolver selected the `.ts` source for both extensionless and explicit `.ts` imports. Confirm again under the cleanup candidate's pinned toolchain. |

Do not automatically remove `components/cinder/scripts/export-names.ts` or `packages/weft/scripts/import-string-kv-sqlite-to-weft.ts`: they are manual-command candidates whose continued purpose needs to be established. Keep the Cinder gate-wiring checks, benchmark glob entrypoints, and installed-release verification. Lack of a static import alone is not proof of disuse.

## Evidence limits and success criteria

No paid Chef comparison, model-routing experiment, live Linear mutation, release, or full test suite was run for this spike. No workflow code or candidate orphan was changed. Local source establishes specific contradictions and enforcement gaps; published studies motivate experiments but do not supply our savings estimate. Current provider usage telemetry was not collected, so no dollar or token savings are claimed.

The simplified workflow earns adoption when it preserves required outcomes and risk checks, demonstrates correct recovery in the shared scenarios, and reduces measured total cost or human intervention on comparable work. If it only shortens the skill while increasing lookup, repair, or coordination work, it has failed the objective. Keep the same outcome checks when changing models, prompts, or provider versions so improvements do not silently regress.
