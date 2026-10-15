# The typed Operative and Bureau API

This document describes the public TypeScript contracts implemented by `@lostgradient/operative` and `@lostgradient/bureau`. The source exports are the authoritative definition; this document explains the relationships that are easy to miss when reading the individual modules.

## Agent input and run context

Every runnable agent accepts the same input and context shapes (supporting types are defined in the linked source):

```ts
import type { ConversationHistory } from 'conversationalist';

export type AgentInput = string | { conversation: ConversationHistory };

export interface AgentRunContext {
  signal?: AbortSignal | undefined;
  traceContext?: unknown;
  withTraceContext?: (<T>(parentContext: unknown, fn: () => Promise<T>) => Promise<T>) | undefined;
  agentName?: string | undefined;
  childRegistry?: ChildRunRegistry | undefined;
  delegatedAuthority?: DelegatedAuthority | undefined;
  principal?: string | undefined;
}
```

A string starts a fresh conversation. `{ conversation }` resumes supplied history after it has been cloned, so the caller's history and the in-flight run do not share mutable state. `principal` is attribution forwarded to run options; it is not, by itself, an authorization mechanism.

## Runnable agents and run handles

`RunnableAgent<O, H>` preserves the output type and whether an output schema was provided:

```ts
export interface RunnableAgent<O = never, H extends boolean = false> {
  readonly name: string;
  readonly hasOutput: boolean;
  readonly generationProfile?: AgentGenerationProfile | undefined;
  run: (input: AgentInput, context?: AgentRunContext) => AgentRun<O, H>;
}
```

The function is intentionally property-typed. This makes TypeScript check its parameter contravariantly, so an implementation cannot silently accept only the string form and reject conversation resumption.

COR-567 (2026-09-19) ratifies that `RunnableAgent` carries an optional `hooks?: HookRegistry<OperativeHookMap>`, settable only at `createAgent()` construction time. At dispatch, a run's effective hook plan is `mergeHookRegistries(bureauRegistry, agentRegistry, directRegistry)`, composed bureau-first and agent-additive, so an Agent- or run-level registration can narrow but never remove or bypass a Bureau invariant hook. The merged registry is a snapshot, so later mutation of a source registry does not change a dispatched run. A child run's plan is `mergeHookRegistries(bureauRegistry, childAgentRegistry)` and never inherits the parent's direct-run hooks. As of COR-1265 and COR-1268 the agent tier is implemented: `RunnableAgent` carries a `readonly hooks?: HookRegistry<OperativeHookMap>`, `createAgent`'s options accept `hooks`, and `buildRunOptions` composes it through `mergeHookRegistries`, giving that function its first production call site. `HookRegistry` is now the ONLY hook surface on a run: the parallel `RunOptionsBase` hook arrays (`prepareStep`, `beforeToolExecution`, `afterToolExecution`, `onStep`, `validateResponse`, `validateToolResult`, `selectTools`) are removed.

`RunnableAgent.hooks` is `readonly` and construction-time only. A registry handed to `createAgent()` becomes that agent's tier and is composed into every run it dispatches; there is no setter, and the property descriptor on a `createAgent()` result is not writable. Registering on that registry afterwards changes the agent's future runs but not one already dispatched, because the merge copies every entry into a fresh registry at dispatch.

As of COR-1265 the Bureau tier is composed too. Every site that hands a registry into a run's options delivers a merged one, and Bureau's registrations carry `source: 'bureau'`. The composition order is bureau-first on `runFirst`, where the first handler to answer ends the question; on `runLast` and the plain `run` waterfall, where the last handler decides, a Bureau registration that narrows carries an explicit pinned-last priority instead, so an agent-tier handler cannot hand the run a value the guardrail had already narrowed. See [Hierarchical hook composition](hierarchical-hook-composition.md) for the whole contract, including which Bureau invariants reach a catalog-dispatched run and the one dispatch path they cannot.

One part of the contract above is decided but NOT yet in source, and a reader should not plan against it: `dispatchChildRun` composes nothing, so the child-run rule is a contract rather than behavior (COR-1269). Note also that no path reachable today populates all three tiers at once — `AgentRunContext` declares no `hooks` field, so a caller of `agent.run()` has no per-call hook surface, and `BureauOptions` exposes none by decision.

`run()` starts synchronously and returns an `AgentRun` immediately. The handle is deliberately not a `Promise` or thenable: callers choose an explicit terminal operation.

```ts
const run = agent.run('Summarize this report.');
const result = await run.result();
const text = await run.unwrap();
```

An `AgentRun` is an async iterable of `RunEvent` values and provides:

- `id`, the run's identifier, which `snapshot().id` equals and a durable run keeps across recovery. A handle returned before its run exists, such as a lazy agent's or `bureau.run`'s, already carries it; pass `AgentRunContext.runId` to choose it. A session run's `id` is final only once the session has reserved the run, and a hand-written `RunnableAgent` that ignores `AgentRunContext.runId` runs under its own id, which the wrapping handle's `snapshot().id` then reports instead;
- `result()`, which resolves to the terminal `RunResult`;
- `unwrap()`, which resolves to plain text for a schema-less run or the validated output for a run with a schema, and rejects unsuccessful runs;
- `output()`, only on the `H = true` type, for the typed validated value;
- `abort(reason?)`, `children()`, and `abortChild(childId, reason?)`;
- `snapshot()` and `subscribeSnapshot()` for liveness observation;
- `closed(options?)`, an awaitable cleanup acknowledgement; and
- `[Symbol.dispose]()` for synchronous disposal.

`RunResult` always contains `conversation`, `steps`, `content`, `usage`, and `finishReason`. It may contain `costEstimate`, `error`, and `schemaValidation`. The conditional `output` property exists only when the compile-time `H` parameter is `true`; runtime narrowing also uses the agent's `hasOutput` witness.

Standalone runs use a permanently `redacted` liveness projection. Their liveness result exposes `finishReason` and `hasError`, not the complete conversation, model content, output, or error object.

## Creating and loading agents

`createAgent` requires a `generate` function because there is no Bureau to provide one. `output` is a Zod schema when typed structured output is desired; the validated value is available through `RunResult.output` and `AgentRun.output()` after successful validation. The factory also accepts instructions, tools or a toolbox, guardrails, stop conditions, maximum steps, retry and context-management settings, permissions, and an optional `RuntimeServices` instance.

```ts
import { createAgent } from '@lostgradient/operative';
import type { GenerateFunction } from '@lostgradient/operative';
import { z } from 'zod';

declare const generate: GenerateFunction;

const researcher = createAgent({
  name: 'researcher',
  generate,
  instructions: 'Research carefully and cite your sources.',
  output: z.object({ summary: z.string() }),
});

const summary = await researcher.run('Summarize the report.').output();
```

The returned standalone agent is bureau-less and in-memory. Its name defaults to `'(agent)'` when omitted, and its `hasOutput` value reflects whether an output schema was supplied.

`createLazyGenerate` memoizes the first successful loader result and shares an in-flight load across concurrent calls. `createLazyAgent` does the same for a whole runnable agent and returns a synchronous `AgentRun` handle whose first work may await the definition. Both loaders validate their resolved export and reset to the unloaded state after a failed load. Capability metadata supplied through `descriptors` or `generationProfile` is readable without invoking the loader.

## Durable execution

Import durable workflow helpers from the `@lostgradient/operative` package root. `createRunWorkflow(checkpointStore, options)` builds the `agentRun` workflow. Its `version` option is stamped into each new run's `RunCursor.workflowVersion`.

A durable checkpoint contains only cloneable state:

```ts
export interface RunCheckpoint {
  runId: string;
  cursor: RunCursor;
  conversation: ConversationSnapshot | null;
  steps: StepRecord[];
}
```

The cursor carries the next step, usage totals, last content, schema-retry count, applied steering version, and optional workflow version. The live `Conversation`, toolbox, hooks, emitter, and generator closures do not cross a checkpoint boundary. A step is the durability unit: generation and its tools are checkpointed together, so a crash during a step can replay that whole step. Effectful tools and hooks must therefore be idempotent.

`createRunEngine` requires the durable storage and workflow definition. It can recover on boot, re-provide non-serializable run services with `resolveWorkflowServices`, run scheduler maintenance automatically or manually, and use `ownership: 'workflow-lease'` for per-workflow multi-process fencing. A resolver returning `{ status: 'unavailable' }` fails that run terminally without aborting recovery of other runs.

The durable path uses the same `runStep` implementation as in-memory execution. This keeps generation, tools, retries, schema validation, hooks, and events on one behavior path while the durable driver adds checkpoint boundaries.

## Events and observation

The root package exports the `OperativeEventMap`, `CombinedOperativeEventMap`, event classes, and event type unions. The event surface covers run and step lifecycle, generation, tools, guardrails, sessions, child workflows, scheduling, steering, and durable recovery. `WorkflowVersionMismatchEvent` reports the durable version observation described in the [workflow versioning guide](./workflow-versioning.md).

An observer receives the current snapshot synchronously when it subscribes, then receives each later revision. Subscriptions are independent and may be removed without changing ownership or cancellation. A terminal handle still delivers its terminal snapshot to a later subscriber.

## Started-work control contract

The run and administrative handles use one lifecycle vocabulary for work that has started. A resource has an immutable identifier, a kind, creation and transition timestamps, a monotonic revision, a current status, ownership, durability, projection, and a terminal result when one exists. Optional owner and parent fields are omitted when the resource has no such relationship; an omitted field is not an authorization failure.

### The common facts

Snapshots are cached, immutable, and side-effect-free. Calling `snapshot()` does not start work or wait for progress. `subscribeSnapshot()` delivers the current snapshot before returning, then delivers later revisions. A handle's `cancellable` value is truthful at construction time; unsupported cancellation is a no-op on the live handle and is represented by its unchanged snapshot.

### Required capabilities

An independently owned live operation exposes a cached snapshot, independent observation, idempotent cancellation where supported, an awaitable terminal result, and an awaitable cleanup acknowledgement. `AgentRun` supplies these as `snapshot()`, `subscribeSnapshot()`, `abort()`, `result()`, and `closed()`. Child runs remain parent-owned and are discovered through `children()` and `abortChild()` when a `ChildRunRegistry` is wired. Bureau's durable children are a separate surface, `bureau.children`, that the parent's `children()` does not list; see [Multi-agent lifecycle and communication](./multi-agent-lifecycle.md).

Cleanup acknowledgement describes cleanup, not optimistic rollback. An external tool, provider, or hook may already have committed a side effect; the run preserves the observed outcome and idempotency evidence rather than claiming that effect was reversed.

`closed()` never rejects and memoizes the resource-level acknowledgement. A caller's `ClosedOptions.signal` bounds only that caller's wait; an `unresolved`/`timed-out` result is not written into the shared cache. The acknowledgement distinguishes definite cleanup failure (`failed`) from effects whose outcome cannot be confirmed: `timed-out`, `unknown-effect`, `unreachable`, and `persistence-failed`. A cancellation request disqualifies the immediate `not-required` fast path, and durable runs report `persistence-failed` when the post-cancellation state cannot be confirmed.

Bureau's `detachBestEffortPromise()` is reserved for detached wake-ups and cleanup triggers whose result is not the lifecycle acknowledgement. It observes and diagnoses a rejection without turning that fire-and-forget path into an unhandled rejection. Callers needing a truthful lifecycle result use `result()` and `closed()` instead.

## Started-work inventory

The control contract above says how started work is owned. This section defines the rule for work that is not, and records where the workspace breaks it today.

### The unowned-background-work rule

An exported API breaks the rule when it starts long-lived or fire-and-forget asynchronous work and its stop or dispose path does not await what is already in flight. In `applications/`, the same test applies to every entrypoint or server-lifecycle path, meaning any file reachable from the application's documented process-startup entrypoint, not just the top-level file.

An exported API that starts such work and has no stop or dispose path at all also breaks the rule. It is a row in the table, and its execution mode is annotated `(no dispose path)`. No current row carries that annotation.

Stopping a timer is not awaiting the work the timer already started. A stop path that only clears a handle, sets a flag, or aborts a signal still leaves the callback's work in flight, so it does not satisfy the rule. Work whose promise is returned to the caller, tracked and drained by the owner (for example through `RuntimeServices` deferred tracking or an awaited in-flight field), or fully synchronous is conformant and is not listed.

### Table columns

- **Ownership** is the workspace package that owns the code, by its real name: `@lostgradient/*`, or the unscoped `armorer` and `conversationalist`.
- **Execution mode** is one of `interval`, `timeout`, `fire-and-forget-call`, or `unawaited-field-promise`.
- **Durability** uses the control contract's vocabulary. `ephemeral` means the work leaves no state that outlives the process. `durable` means abandoning it mid-flight can leave persisted state incomplete or stale.
- **File** and **line** locate where the work is started, on base commit `5ec1f80223890fa431a684c687e4333b6b2da103`, the commit this inventory was taken from.

### Sweep coverage

Every workspace was swept. These workspaces have no non-conformant path: `conversationalist`, `@lostgradient/cryptography`, `@lostgradient/embeddings`, `@lostgradient/lifecycle`, `@lostgradient/markdown`, `@lostgradient/memory`, `@lostgradient/testing`, `@lostgradient/tool-protocol`, `@lostgradient/chat`, and `@lostgradient/cinder`. Every other workspace appears in the table below.

### Inventory

| Ownership | Execution mode | Durability | File | Line |
| --- | --- | --- | --- | --- |
| `@lostgradient/bureau` | `fire-and-forget-call` | durable | `packages/bureau/src/create-bureau.ts` | 3283 |
| `@lostgradient/bureau` | `fire-and-forget-call` | durable | `packages/bureau/src/create-bureau.ts` | 3337 |
| `@lostgradient/bureau` | `fire-and-forget-call` | durable | `packages/bureau/src/create-bureau.ts` | 3403 |
| `@lostgradient/bureau` | `fire-and-forget-call` | durable | `packages/bureau/src/create-bureau.ts` | 3706 |
| `@lostgradient/bureau` | `fire-and-forget-call` | durable | `packages/bureau/src/create-bureau.ts` | 3743 |
| `@lostgradient/bureau` | `fire-and-forget-call` | ephemeral | `packages/bureau/src/create-bureau.ts` | 4022 |
| `@lostgradient/bureau` | `fire-and-forget-call` | ephemeral | `packages/bureau/src/create-bureau.ts` | 4442 |
| `@lostgradient/bureau` | `interval` | durable | `packages/bureau/src/create-bureau.ts` | 5454 |
| `@lostgradient/bureau` | `fire-and-forget-call` | ephemeral | `packages/bureau/src/durable-event-history.ts` | 958 |
| `@lostgradient/operative` | `fire-and-forget-call` | ephemeral | `packages/operative/src/create-run.ts` | 595 |
| `@lostgradient/operative` | `fire-and-forget-call` | ephemeral | `packages/operative/src/child-signals.ts` | 436 |
| `@lostgradient/operative` | `fire-and-forget-call` | durable | `packages/operative/src/scheduler/create-scheduler.ts` | 507 |
| `armorer` | `fire-and-forget-call` | ephemeral | `packages/armorer/src/create-tool/runtime-execution.ts` | 109 |
| `armorer` | `fire-and-forget-call` | durable | `packages/armorer/src/idempotency/with-toolbox-idempotency.ts` | 720 |
| `armorer` | `fire-and-forget-call` | durable | `packages/armorer/src/idempotency/with-toolbox-idempotency.ts` | 791 |
| `armorer` | `fire-and-forget-call` | durable | `packages/armorer/src/idempotency/with-toolbox-idempotency.ts` | 818 |
| `armorer` | `fire-and-forget-call` | durable | `packages/armorer/src/idempotency/with-toolbox-idempotency.ts` | 876 |
| `armorer` | `fire-and-forget-call` | ephemeral | `packages/armorer/src/toolbox-event-lifecycle.ts` | 118 |
| `armorer` | `fire-and-forget-call` | ephemeral | `packages/armorer/src/toolbox-event-lifecycle.ts` | 138 |
| `armorer` | `fire-and-forget-call` | ephemeral | `packages/armorer/src/toolbox-event-lifecycle.ts` | 142 |
| `@lostgradient/evaluation` | `timeout` | ephemeral | `packages/evaluation/src/evaluator.ts` | 114 |
| `@lostgradient/skills` | `timeout` | ephemeral | `packages/skills/src/discovery/catalog-service.ts` | 278 |
| `@lostgradient/weft` | `interval` | durable | `packages/weft/src/core/scheduler/scheduler-class.ts` | 95 |
| `@lostgradient/weft` | `fire-and-forget-call` | ephemeral | `packages/weft/src/alerting/alert-manager.ts` | 283 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/server/serve-internals.ts` | 347 |
| `@lostgradient/weft` | `interval` | durable | `packages/weft/src/server/serve-internals.ts` | 473 |
| `@lostgradient/weft` | `interval` | durable | `packages/weft/src/server/serve-internals.ts` | 484 |
| `@lostgradient/weft` | `timeout` | durable | `packages/weft/src/core/outbox.ts` | 210 |
| `@lostgradient/weft` | `timeout` | durable | `packages/weft/src/service-worker/scheduler.ts` | 242 |
| `@lostgradient/weft` | `fire-and-forget-call` | ephemeral | `packages/weft/src/core/engine/reviews.ts` | 470 |
| `@lostgradient/weft` | `timeout` | durable | `packages/weft/src/server/runtime/task-dispatch.ts` | 72 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/server/runtime/long-poll-drain.ts` | 41 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/server/runtime/worker-disconnect-requeue.ts` | 151 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/server/runtime/authentication-bridge.ts` | 430 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/server/runtime/authentication-bridge.ts` | 457 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/server/runtime/remote-activity-event-bridges.ts` | 54 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/server/runtime/remote-activity-event-bridges.ts` | 83 |
| `@lostgradient/weft` | `interval` | ephemeral | `packages/weft/src/worker/long-poll.ts` | 382 |
| `@lostgradient/weft` | `fire-and-forget-call` | ephemeral | `packages/weft/src/worker/long-poll.ts` | 421 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/server/runtime/websocket-worker.ts` | 292 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/server/runtime/websocket-worker.ts` | 347 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/server/runtime/websocket-worker.ts` | 492 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/server/runtime/event-broadcasting.ts` | 138 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/server/runtime/event-broadcasting.ts` | 387 |
| `@lostgradient/weft` | `unawaited-field-promise` | durable | `packages/weft/src/server/runtime/event-broadcasting.ts` | 400 |
| `@lostgradient/weft` | `timeout` | durable | `packages/weft/src/core/engine/pending-updates.ts` | 84 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/core/engine/callback-creators-core.ts` | 112 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/core/engine/lifecycle/checkpoint-launch.ts` | 77 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/core/engine/lifecycle/resume-body.ts` | 494 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/core/engine/updates.ts` | 365 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/core/engine/signals.ts` | 397 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/core/engine/inline-parking.ts` | 231 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/core/engine/disposal.ts` | 221 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/core/engine/second-instance-detector.ts` | 352 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/core/engine/termination/complete.ts` | 204 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/core/engine/termination/complete.ts` | 208 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/core/engine/termination/complete.ts` | 233 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/core/engine/termination/complete.ts` | 339 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/core/engine/termination/complete.ts` | 368 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/core/engine/termination/complete.ts` | 644 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/core/engine/termination/complete.ts` | 670 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/core/engine/termination/cleanup.ts` | 182 |
| `@lostgradient/weft` | `interval` | durable | `packages/weft/src/core/engine/index.ts` | 908 |
| `@lostgradient/weft` | `interval` | durable | `packages/weft/src/core/engine/workflow-claim-renewal-interval.ts` | 296 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/core/engine/checkpoint-io.ts` | 451 |
| `@lostgradient/weft` | `fire-and-forget-call` | durable | `packages/weft/src/core/engine/checkpoint-io.ts` | 533 |
| `@lostgradient/weft` | `timeout` | durable | `packages/weft/src/core/outbox-runner.ts` | 333 |
| `@lostgradient/weft` | `fire-and-forget-call` | ephemeral | `packages/weft/src/server/runtime/authentication-bridge.ts` | 327 |
| `@lostgradient/weft` | `fire-and-forget-call` | ephemeral | `packages/weft/src/server/runtime/authentication-bridge.ts` | 350 |
| `@lostgradient/editor` | `fire-and-forget-call` | ephemeral | `components/editor/src/lib/editor/attach.ts` | 117 |
| `@lostgradient/weft-ui` | `timeout` | ephemeral | `components/weft-ui/src/lib/live-source/polling-source.svelte.ts` | 97 |

## Session input admission

Operative exports the session-input record and outcome types. Bureau implements `submitSessionInput(sessionId, request)` with pre-admission checks in order: an unauthorized caller or unknown session receives `not-found`; an authorized caller naming a terminal session receives `session-terminal`; every other request receives `unsupported-capability` with reason `durable-mailbox-unavailable`. The method creates no record and consumes no identifier. Its `admitted`, `replayed`, `conflict`, and `backlog-exhausted` outcomes are currently unreachable.

The following types define the mailbox admission contract without claiming that record admission is implemented. `SessionInputPayload` is `string` or an array of an explicit allowlist: `TextContent` with `citations?: undefined`, `ImageContent`, or `DocumentContent`. It is intentionally not an `Exclude` over the provider union, so a future response-only content variant cannot be admitted silently.

`SessionInputRecord<TPayload>` and `SessionInputAdmissionRequest<TPayload>` bound `TPayload extends SessionInputPayload`. A record carries `id`, `idOrigin`, `sessionId`, authenticated `principal`, `deliveryMode` (`'steer'` or `'queue'`), `payload`, `payloadDigest`, admission time, optional expiry, and optional explicit `supersedes`. An exact retry replays the original receipt without creating a second record. Conflicting reuse returns a typed conflict (`session-mismatch`, `delivery-mode-mismatch`, `payload-mismatch`, or `id-owned-by-other-principal`) and leaves the original untouched.

The state vocabulary is `accepted`, `queued`, `promoted`, `rejected`, `expired`, `superseded`, `canceled`, and `failed`. Promotion commits the model-visible message and promoted state together. Typed outcomes also cover authorization/lookup failure, terminal sessions, unsupported capability, and per-session or per-principal backlog exhaustion.

The record and state-transition types describe the admission boundary; the current runtime behavior is the pre-admission rejection surface above.

## Steering commands

Bureau accepts `pause`, `resume`, `agent-identity`, `route`, `model`, `provider`, and `effort` for authorized, non-terminal sessions, on both in-memory and durable ones. The requested value carries exactly one of `policyRef` or `override` for every target but pause and resume, which carry neither. For `model`, `provider`, `route`, and `effort`, `policyRef` resolves through the named profile in `BureauOptions.modelPolicy.users` before admission. Model, provider, and route use the corresponding `exactOverride` field; effort uses `exactOverride.effort` or `defaultEffort`. A missing profile or coordinate is rejected with `policy-denied`. Only an `agent-identity` `policyRef` returns `unsupported-capability` with reason `selector-unavailable`; identity overrides remain supported.

An `agent-identity` override is validated against the Bureau's own `agents` catalog. The four configuration coordinates are validated against the live model catalog, one coordinate at a time — not through `planSelection`, because `composePolicy`'s exact-override path requires provider and model together and rejects any override naming a route, so a single-coordinate steering command can never satisfy it. Whole-backend coherence is decided later, at the runStep selection boundary, where the accumulated desired configuration is recomputed into a plan. A `route` has nothing in the model catalog to validate against — routing entries live on the generate function — so admission accepts the name and the routing layer rejects an unknown route at generate time. An override the catalog does not know is rejected with `policy-denied`.

The four configuration targets are session-scoped and effective at the next `runStep` boundary, so a run already in flight observes them. `agent-identity` is session-scoped but deferred to step 0 of the session's next run, because swapping the agent also changes the tool set and hook plan. `pause` and `resume` bind to one run.

On a durably-configured bureau each admitted command is persisted into a per-session mailbox before it enters desired state, and a restart replays the log back into a fresh gate. The in-memory gate remains the authority for desired state; the mailbox is the durable log.

The operative run-step boundary reads a `SteeringGate`; a paused run waits for `awaitResume()` or its abort signal before the next step. The wider exported command contract describes these typed states: `accepted`, `applied`, `rejected`, `superseded`, or `failed`.

An exact retry of an idempotency identifier and equivalent requested value replays the existing command state. Reusing that identifier for a different requested value returns a typed conflict. A command that loses its target run to terminal completion fails with `run-terminal` rather than applying after the run has ended. `configVersion` increments exactly once on acceptance; the step boundary applies the desired state and stamps the effective state.

The five steering event classes are exported and included in `OperativeEventMap`. Operative dispatches `steering.applied` from `runStep`, and Bureau dispatches `steering.accepted` onto its own emitter at admission. `steering.rejected`, `steering.superseded`, and `steering.failed` describe `accepted → X` transitions owned by the gate's post-admission state machine and have no production dispatch site yet; a pre-admission rejection is deliberately not reported as one of them, because such a command never entered the state they describe leaving.

## Effective context epochs

Every generate attempt can seal one immutable effective-context epoch, recording which identified, versioned sources produced that provider turn. The epoch carries each source's identity, revision, trust tier, precedence, availability, redaction policy, and a digest — never the source's content, so provenance cannot turn protected values into logs. `generate.started` references the epoch by `epochId`.

An epoch seals immediately before `generate.started`, once per generate attempt, which is the last point at which nothing further can change the request. The `prepareStep` hook waterfall — the identity hook, the memory bridge, the input guardrail — runs inside `executeGeneration`, after `prepareStep` itself returns, so an epoch sealed at that earlier boundary would omit them. Sealing per attempt rather than per step follows from the same place: a guardrail that sanitizes the user message between retry attempts seals a successor epoch. An attempt that short-circuits before the provider call seals nothing.

A source change produces a successor epoch with its own id and a `supersedes` link rather than editing the original. Reuse is permitted when every bound source digest is unchanged, which in practice means a retry attempt where nothing moved — `conversation` is a bound source, so successive steps chain rather than reuse. A source the run never composed is recorded `absent-by-composition`, distinct from `excluded`, so a `required` source does not fail every step of an agent that has no Bureau, policy, or catalog.

`RunOptions.contextEpoch` is `undefined` by default and is then a complete no-op.

## Bureau composition

`createBureau` accepts an `AgentDefinitions` map of runnable agents and returns a typed Bureau catalog. `bureau.run(name, input, options?)` preserves the selected agent's output type and forwards the caller's principal and other run context. Bureau also owns durable composition, recovery classification, session and scheduler operations, model selection, event history, pending reviews, and shutdown reporting.

The Bureau durable options that affect the Operative contract include `workflowVersion`, `durableOwnership`, `durableGuardrails`, persistence, and the durable storage configuration. `workflowVersion` is passed to both the workflow stamp and recovery comparison when a durable engine is composed.

`BureauOptions.memory?: GovernedMemory` takes a host-constructed governed memory (COR-41); Bureau never constructs memory storage itself. Each run's recall and persistence hooks act under a memory authority `createRunMemoryAuthority` derives from the run's persisted request authority, delegated from Bureau (`BureauOptions.memoryAuthority.runCapabilities`, default `memory:search` and `memory:write`) through the request principal to the run; a run with no persisted request authority gets no memory hooks. Recall goes through the governed memory's mandatory recall admission and enters the conversation as a labeled evidence envelope; persisted assistant content is admitted as untrusted conversation memory. The instance is exposed on `Bureau.memory` (`GovernedMemory | undefined`).

## Reserved for memory

COR-750 (2026-09-19) ratified the memory lifecycle and ownership contract without expanding the surface documented above. Four reservations follow from it:

- A per-agent memory-profile read method on the Bureau catalog, parallel to `generationProfile`'s "a caller reads which projection it received" pattern, is reserved for a later decision.
- A metadata method on any future memory catalog beyond the ratified `get`/`find`/`has`/`names`/`entries`/`query` shape is reserved.
- Reuse of the AB-34 started-work control contract (described above under "Started-work control contract") for any memory administrative surface that exposes in-flight state is reserved; the contract itself already ships—`Bureau.modelCatalog`'s doc comment in `packages/bureau/src/types.ts` references it—but this document does not yet describe a memory-scoped user of it.
- A placeholder is reserved for memory administrative methods that ship later; this document has no field or administrative-method inventory yet to hold it.

## Compile-ready example

```ts
import { createBureau } from '@lostgradient/bureau';
import { createAgent } from '@lostgradient/operative';
import type { GenerateFunction } from '@lostgradient/operative';
import { z } from 'zod';

export async function runExample(generate: GenerateFunction) {
  const agents = {
    researcher: createAgent({
      name: 'researcher',
      generate,
      output: z.object({ summary: z.string() }),
    }),
    writer: createAgent({ name: 'writer', generate }),
  };

  const bureau = await createBureau({ agents });
  try {
    const structured = await bureau.run('researcher', 'Summarize this.').output();
    const prose = await bureau.run('writer', 'Draft an introduction.').unwrap();
    return { structured, prose };
  } finally {
    await bureau.shutdown();
  }
}
```

The catalog is built from the literal `agents` object, so `structured` is typed as `{ summary: string }` while `prose` is typed as `string`.

### Widened runtime modules

When the module path is only known at runtime, the loader must narrow the module's shape and preserve the unresolved output capability as `boolean`:

```ts
import { createLazyAgent } from '@lostgradient/operative';
import type { RunnableAgent } from '@lostgradient/operative';

export async function runWidenedPlugin(pluginPath: string): Promise<string> {
  const plugin: RunnableAgent<unknown, boolean> = createLazyAgent<unknown, boolean>(
    () => import(pluginPath) as Promise<{ default: RunnableAgent<unknown, boolean> }>,
  );
  return plugin.run('do the thing').unwrap();
}
```

Because `H` is `boolean`, `output()` is not available on the returned run and the wrapper does not pretend that a runtime-loaded plugin has a statically known schema. This is the canonical widened-plugin pattern exercised by `packages/operative/src/create-lazy-agent.test-d.ts`.

## Source map

- [Runnable agent contract](../packages/operative/src/runnable-agent.ts)
- [Agent factory](../packages/operative/src/create-agent.ts)
- [Lazy agent and generate factories](../packages/operative/src/create-lazy-agent.ts)
- [Run result and options](../packages/operative/src/types.ts)
- [Durable workflow](../packages/operative/src/durable/run-workflow.ts)
- [Durable engine](../packages/operative/src/durable/create-run-engine.ts)
- [Durable checkpoint types](../packages/operative/src/durable/types.ts)
- [Bureau options and API](../packages/bureau/src/types.ts)
- [Bureau factory and recovery](../packages/bureau/src/create-bureau.ts)
