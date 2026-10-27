# Hierarchical hook composition

Hooks in this workspace are owned by _tiers_. A Bureau owns invariants it will not let a lower level remove. An agent extends its own behavior. A caller constructing a run directly extends that run. All three compose into one immutable plan per run, and an inspector can ask a run which sources applied and in what order.

This document is the contract. The decision behind it is COR-567; the implementation slices are COR-1265 through COR-1270.

## The three tiers

| Tier | Where a registry comes from | What it may do |
| --- | --- | --- |
| `bureau` | Built per run inside `createRunRuntime` | Enforce and narrow. Never grants capability. |
| `agent` | `createAgent({ hooks })`, surfaced as `RunnableAgent.hooks` | Extend behavior within whatever Bureau already permits. |
| `direct` | `createActiveRun({ hooks })` on a run constructed by hand | Extend that one run. |

A run's plan is `mergeHookRegistries(bureauRegistry, agentRegistry, directRegistry)`, absent tiers passed as `undefined` and filtered out. The merge copies every entry into a fresh registry, so the plan a dispatched run holds is a _snapshot_: registering on a source registry afterwards changes that tier's future runs and not the one already in flight.

> [!NOTE] No path populates all three tiers at once
>
> `AgentRunContext` declares no `hooks` field and `BureauOptions` exposes none, both by decision (COR-567 Decision 4). The reachable shapes are Bureau → `(bureau, agent, undefined)`, a plain `agent.run()` → `(undefined, agent, undefined)`, and a hand-built `createActiveRun` → `(undefined, undefined, direct)`. The three-tier ordering is a real property of `mergeHookRegistries` and is tested directly against it; it is not currently reachable through a dispatch. That is a stated limitation, not a gap.

## Ordering, and why it is not one rule

`mergeHookRegistries` offsets each participant's priorities by `(participants - 1 - index) * 1000`. Bureau is always first, so it takes the largest offset — `+2000` with three tiers, `+1000` with two. The registry sorts descending, so a higher priority runs earlier.

Which end of that order _wins_ depends on the hook point's dispatch shape, and the three shapes disagree:

- **`runFirst`** — handlers run in order against the same arguments and the first defined result ends the question. The highest priority wins, so Bureau's band is enough on its own. `prepareStep` and `beforeCompaction` use this.
- **`runLast`** — every handler runs against the same arguments and the _last_ defined result is kept. `selectTools` and `selectToolChoice` use this.
- **`run` (waterfall)** — every handler runs, and each defined return replaces the first argument for the next. `validateResponse`, `validateToolResult` and `onStep` use this.

On the latter two, running last means winning, and the tier band works _against_ Bureau: its large offset pushes it toward running first. A Bureau registration that must hold final narrowing power therefore carries an explicit `BUREAU_PINNED_LAST_PRIORITY` — `Number.MIN_SAFE_INTEGER + 2000`, sized so the largest offset added back cannot leave the safe-integer range. Today that is `bureau:guardrails-validate-response`, plus the two trailing `onStep` hooks, which take the same value for an ordering reason rather than an authority one: they persist the session after the step's mutations settle, and an agent-tier `onStep` handler is one of those mutations.

The limit, stated rather than implied: a lower tier that deliberately registers at or below `MIN_SAFE_INTEGER + 2000` sorts after Bureau anyway. A priority is a plain number with no floor, so no finite constant closes that, and `-Infinity` closes it only until a second entry carries it — `b.priority - a.priority` then returns `NaN` and the sort is no longer defined. What the constant defends against is an ordinary registration that happens to outrank Bureau, not a tier reaching for the bottom of the number line.

## Authority

Hooks may enforce or narrow policy. They never grant capability.

A child's delegated-authority grant is composed by `attenuateDelegatedAuthority` from the parent's grant and the dispatching tool's own narrowing, independently of any hook, and no hook context declares `delegatedAuthority` at all — a type-level fixture asserts that absence, so a context gaining the field fails the build rather than quietly opening a channel.

`selectTools` is the widest lever a hook has over what a step may reach, and it still cannot touch the grant. A child-tier `selectTools` handler that hands its step a toolbox of its own choosing changes which tools that step sees; the grant forwarded to a grandchild it dispatches is still `attenuateDelegatedAuthority(parentGrant, toolNarrowing)`, composed by the dispatch path rather than by anything the hook returned.

## Bureau invariants on catalog-agent runs

A catalog-dispatched run (a `bureau.children.dispatch` child, a goal attempt, or a workflow step) resolves its provider, toolbox, memory and skills through the _agent's own_ `OPERATIVE_RESOLVE_RUN_OPTIONS`, never through `createRunRuntime`. That separation is deliberate and reattaching such a run against the Bureau's defaults is its rollback trigger.

The whole Bureau tier cannot travel there: `bureau:memory-recall`, `bureau:memory-persist` and `bureau:skill-record-snapshot` close over a session, a memory and a skill session a catalog run does not have. The three registrations that close over composition-level configuration only — `bureau:identity` and both guardrails — do travel, through `RuntimeComposition.createBureauInvariantHooks()`, merged in front of the agent's own tier. The guardrails travel only to an agent that does not resolve its own (COR-1367): a `createAgent` agent carries `OPERATIVE_RESOLVES_GUARDRAILS`, receives the bureau-level policy as `AgentRunContext.inheritedGuardrails`, and registers its resolved guardrails in its own tier as `agent:guardrails-prepare-step` and `agent:guardrails-validate-response`, so Bureau passes `agentResolvesGuardrails` and registers none. Those two entries sit at `AGENT_POLICY_PINNED_LAST_PRIORITY`, behind every ordinary agent hook and still ahead of Bureau's own pinned-last entries.

Which paths that reaches — and the axis is the resolver, not durability. `bureau-catalog-dispatch.ts` composes the invariants for any agent satisfying `hasDefinitionResolver`, whether or not the bureau was built durable, by resolving the agent's own `RunOptions` and merging into that bag. An agent exposing no resolver builds its options entirely inside `run()`, so there is nothing to merge into:

| Catalog path                                          | Bureau invariants |
| ----------------------------------------------------- | ----------------- |
| Dispatch of an agent that resolves run options        | Yes               |
| Recovery of a durably dispatched catalog run          | Yes               |
| Dispatch of an agent exposing no run-options resolver | **No**            |

> [!WARNING] The last row is a real gap
>
> It calls `agent.run(input, context)` directly, so no `RunOptions` exists outside the agent for anything to augment. The only remaining injection point would be a caller-facing hook field on `AgentRunContext`, which COR-567 Decision 4 declines, and COR-1276 accepted the gap rather than taking that.
>
> It applies to a hand-written `RunnableAgent` placed in a catalog — a deliberate act by whoever wrote the agent, not a configuration anybody falls into. `durable` has nothing to do with it: tests pin the same outcome on both sides of that flag, so a future change that reintroduces a durability dependency fails rather than quietly narrowing this row.

## Child runs

A child dispatched through `dispatchChildRun` gets its effective plan entirely from its own `agent.run()` path — the child agent's own tier, and nothing else. No parent hook reaches it.

This is structural rather than a convention anybody has to remember. Neither `child-run.ts` nor `create-subagent-tool.ts` contains a hook-registry reference, and `parentContext` declares no `hooks` field; there is nothing to copy from. Sibling children of one fan-out hold independent plans for the same reason.

> [!WARNING] Bureau's invariants do not reach a child run either
>
> A child dispatched by a Bureau-owned agent carries the child agent's tier and **no Bureau tier at all** — not the identity hook, not the guardrails. `dispatchChildRun` calls `agent.run()`, which builds its `RunOptions` inside the agent, so there is no options bag for a Bureau tier to be merged into. Structurally this is the same gap as a non-durable catalog dispatch, with the same only-remaining fix — a caller-facing hook field on `AgentRunContext` — which COR-567 Decision 4 declines.
>
> COR-1269's criterion 1 originally stated the opposite. It was amended to match the implementation once the discrepancy was verified by probe rather than argued, and a test in `packages/bureau/src/bureau-run.test.ts` pins the actual behavior. Do not read the tier table above as applying to child runs.

Narrowing and veto do work inside a child, through the child's own tier: a child-tier `validateResponse` narrows what its run returns, and a child-tier `prepareStep` that answers replaces the generate call entirely. What a child does not get is inheritance from above.

What _does_ cross is correlation. `dispatchChildRun` passes `AgentRunContext.childCorrelation` — the same `{ parentAgentName, parentRunId, childAgentName, childRunId }` the `multiagent.child-workflow.*` events carry — and the child's run forwards it into its hook-plan observer. That is data: nothing reachable through it can add, remove or reorder a handler.

## Inspecting a plan

`ActiveRun.describeHookPlan()` answers which hook sources applied and in what order. It returns a redacted description — hook name, registration id, priority, the replay class in force, and the owning tier — built field by field so a field added to a registration does not silently become readable. The handler, its `onError` closure, and anything either closes over are absent by construction.

Ordering is reported as _iteration_ order, highest priority first, not winner order. The three dispatch shapes disagree about which end wins, so a single winner ordering would be a lie for two of them.

Redaction is the entire security boundary; there is no authorization gate in front of it. Any holder of the run handle may call the accessor.

The `hook-plan.*` events are the live counterpart for an event-stream consumer, and they carry `hookName`, `hookId` and `runId` only — not the session or the parent-child correlation. A consumer that needs those attaches its own observer instead.

`HookRegistry.observe(observer, context?)` is that attachment. The context names the run the observer watches on behalf of, and the parent-child pair when that run is a child, and every observation that observer receives carries it alongside the entry's tier and the plan's revision. It is supplied per attachment rather than on the registry because a merged plan is composed at dispatch from tiers that predate the run: the registry has no single truthful answer to "which run is this", and each observer does.

## Durable replay

A crashed in-flight step re-runs from its boundary, so its hooks fire again — at-least-once, by design. A completed step does not: it returns its memoized result without re-executing the body, and invokes no hooks. A purely terminal reattachment builds no hook plan at all.

`HookRegistrationOptions.replay` classifies a registration as `safe` or `effectful`, defaulting to the conservative `effectful` when unset. It is metadata: it never gates whether a hook runs, because skipping an `effectful` hook on replay would drop the side effect for a step whose generation and tools genuinely did re-execute. The correct mitigation is an idempotent handler, and every `effectful` Bureau registration has a test that invokes it twice and asserts one effect.

One thing reads the classification, and only to report. `HookRegistryOptions.onUnclassifiedReplay` fires when a registration omits `replay` entirely — never on an explicit `effectful` — so an author who never considered replay stays distinguishable from one who chose the conservative class deliberately. Only the first is a latent durability bug. The diagnostic cannot gate execution, change the classification or fail a run; a callback that throws is swallowed.

## Reference

- Registry mechanics, the offset formula and the merge: [`packages/lifecycle/README.md`](../packages/lifecycle/README.md#hierarchical-hook-priority-bands-cor-567)
- `RunnableAgent.hooks` and the run contract: [Operative's type-safe API](./operative-type-safe-api.md)
- Tier construction and the invariant subset: `packages/bureau/src/runtime-composition.ts`
