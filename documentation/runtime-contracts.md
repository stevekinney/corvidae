# Runtime contracts across Corvidae

When a runtime starts work, the useful question is not only whether it eventually returns a value. You also need to know which provider capability was selected, which context the provider actually consumed, who owns the work, how a parent reaches the children it started, and whether cancellation reached a real cleanup boundary. This guide ties those contracts together across [Operative](../packages/operative/README.md), [Bureau](../packages/bureau/README.md), [Conversationalist](../packages/conversationalist/README.md), [Armorer](../packages/armorer/README.md), [Lifecycle](../packages/lifecycle/README.md), and [Testing](../packages/testing/README.md).

## Provider capability matrix

Operative's provider surface uses progressive enhancement for native features. The matrix is the result of `getProviderCapabilities(provider, options?)` in `packages/operative/src/providers/capabilities.ts`; it performs a synchronous, side-effect-free read. The [Anthropic Messages API](https://docs.anthropic.com/en/api/messages), [OpenAI API](https://platform.openai.com/docs/api-reference), and [Google Gemini API](https://ai.google.dev/api) are therefore represented by the capabilities the installed SDK surfaces actually provide.

| Provider or endpoint | Batch inference | Explicit thinking request | Request-controlled caching | Server-side token counting |
| --- | --- | --- | --- | --- |
| `anthropic` | yes | yes | yes | yes |
| `openai` default endpoint | yes | no | no | no |
| `openai` custom `baseURL` or `OPENAI_BASE_URL` | no | no | no | no |
| `gemini` | yes | no | yes | yes |
| `voyage` and `ollama` | no | no | no | no |

The OpenAI-compatible case is deliberately conservative: a local server can copy the chat request shape without implementing `/v1/batches` or any of the other native surfaces. A `false` capability lets a caller choose a fallback; a `true` capability that later 404s is a broken promise. Unsupported features are absent from the relevant batch module at compile time, and dynamic callers can inspect the matrix before offering an option.

```typescript
import { getProviderCapabilities } from '@lostgradient/operative';

const capabilities = getProviderCapabilities('openai', { baseURL: 'http://localhost:11434/v1' });
if (!capabilities.batchInference) {
  // Use ordinary generation or an application-owned queue.
}
```

The native batch clients are intentionally provider-shaped: `createAnthropicBatchClient`, `createOpenAIBatchClient`, and `createGeminiBatchClient` expose each SDK's own request and result vocabulary. The shared contract stops at capability discovery; it does not pretend that three different batch APIs have identical payloads.

## Selection plans and model policy

`bureau.planSelection(request)` answers what the current Bureau would use without starting a run, refreshing the catalog, or dispatching an event. The caller supplies `agentName`, an optional `taskClassification`, an optional model/provider/route/effort `requestedValue`, and an optional `principal`. Bureau supplies the live catalog and policy revisions.

The returned `SelectionPlan` is self-contained and frozen. Its fields are:

- `planId`: stable identity for this decision.
- `request`: the caller-facing request plus the catalog, policy, and availability revisions used to evaluate it.
- `candidates`: every considered backend, with an inlined descriptor snapshot, eligibility, exclusion reason, and ranking inputs.
- `selected`: the chosen provider, model, optional route, and optional effort when `outcome` is `selected`.
- `fallbackPlan`: the ordered eligible fallbacks from the configured fallback order.
- `catalogRevision`, `policyRevision`, and `selectorRevision`: the versions needed to explain and replay the decision.
- `configurationRevision`: the steering configuration version when steering produced the request.
- `createdAt`: the plan timestamp.
- `outcome` and `failure`: a discriminated success or failure result. Failure kinds include `no-candidate`, `stale-catalog`, `capability-changed`, `policy-changed`, `exact-override-rejected`, and `provider-effective-divergence`.

```typescript
import type { SelectionPlan } from '@lostgradient/operative';

function explain(plan: SelectionPlan): string {
  if (plan.outcome !== 'selected') return `No model selected: ${plan.failure.reason}`;
  const selected = plan.selected;
  if (!selected) return `Plan ${plan.planId} has no selected backend`;
  return `${selected.provider}/${selected.model} from plan ${plan.planId}`;
}
```

When a run owns a `SelectionGate`, revalidation happens at the run step boundary. A plan is an explanation of a decision, not a reservation that prevents the catalog or policy from changing. The gate reports a changed capability or policy instead of silently using a stale candidate.

## Effective context and steering

An effective context epoch records the versioned sources that produced one provider turn when the host composes `createContextEpochSealer()` into the run. The sealer runs immediately before `generate.started`, after identity, memory, guardrails, hooks, tools, conversation, steering, and selection have been resolved. The epoch includes source dispositions, revisions, permitted digests, a baseline digest, the selection plan id, policy revision, steering configuration version, and the first run/step/attempt that consumed it. Without a composed sealer, no epoch id is emitted.

```typescript
import { Conversation } from 'conversationalist';
import { createContextEpochSealer } from '@lostgradient/operative';

const epochs = createContextEpochSealer({ agentName: 'support' });
const epoch = epochs.seal({
  conversation: new Conversation(),
  toolNames: ['lookup-order'],
  consumer: { runId: 'run-1', step: 0, attempt: 0 },
});
console.log(epoch.epochId, epoch.selectionPlanId, epoch.firstConsumedBy.step);
```

The example is executable as written; `plan` and steering are optional because this host has not composed those gates. A host that does compose them passes the resolved values at the boundary. The sealer does not fetch them or expose protected source content. Its digest is a same-process change detector, not a cryptographic signature.

`Bureau.submitSteeringCommand` admits `pause`, `resume`, `agent-identity`, `route`, `model`, `provider`, and `effort` for authorized, non-terminal sessions. The command is idempotent by `(principal, id)`, checks `expectedRevision` and `deadline`, and applies at a `runStep` boundary where applicable. It never retargets a provider call already in flight. Durable sessions persist admitted commands in the per-session mailbox before updating desired state, then replay that log during recovery. `agent-identity` is applied when the session starts its next run; the other configuration coordinates are effective at the next step boundary.

The following complete example creates an in-memory Bureau, starts a run with a public Armorer tool, pauses at the steering boundary, resumes it, and waits for the run summary to become terminal. It uses a release gate so the first tool call gives the pause command a deterministic boundary to reach:

```typescript
import { createBureau } from '@lostgradient/bureau';
import { createTool, createToolbox } from 'armorer';
import { stopWhen } from '@lostgradient/operative';
import { z } from 'zod';

const toolStarted = Promise.withResolvers<void>();
const releaseTool = Promise.withResolvers<void>();
let generationCalls = 0;

const waitForRelease = createTool({
  name: 'wait-for-release',
  description: 'Wait until the host releases the first tool call.',
  input: z.object({}),
  async execute() {
    toolStarted.resolve();
    await releaseTool.promise;
    return { released: true };
  },
});

const bureau = await createBureau({
  agents: {},
  generate: async () => {
    generationCalls += 1;
    return generationCalls === 1
      ? { content: 'waiting', toolCalls: [{ name: 'wait-for-release', arguments: {} }] }
      : { content: 'finished', toolCalls: [] };
  },
  toolbox: createToolbox([waitForRelease]),
  storage: { type: 'memory' },
  stopWhen: stopWhen.noToolCalls(),
});

try {
  const run = await bureau.createRun({ message: 'start', principal: 'operator-1' });
  await toolStarted.promise;
  const pause = await bureau.submitSteeringCommand(run.sessionId, {
    id: 'pause-1',
    principal: 'operator-1',
    requestedValue: { target: 'pause' },
    runId: run.id,
  });
  if (pause.outcome !== 'accepted') throw new Error(`pause failed: ${pause.outcome}`);

  releaseTool.resolve();
  const resume = await bureau.submitSteeringCommand(run.sessionId, {
    id: 'resume-1',
    principal: 'operator-1',
    requestedValue: { target: 'resume' },
    runId: run.id,
  });
  if (resume.outcome !== 'accepted') throw new Error(`resume failed: ${resume.outcome}`);

  let current = await bureau.getRun(run.id);
  for (let attempt = 0; attempt < 100 && current?.status === 'running'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    current = await bureau.getRun(run.id);
  }
  if (current?.status !== 'completed') throw new Error(`run did not complete: ${current?.status}`);
  console.log(pause.outcome, resume.outcome, current.status);
} finally {
  await bureau.dispose();
}
```

The Bureau run summary has no `result()` method. For an Operative `AgentRun`, call `result()`; for a directly constructed `ActiveRun`, await its `result` property. Both are terminal outcomes, while `closed()` is the cleanup acknowledgement.

Configuration targets are validated at admission: model, provider, and effort must be known to the live model catalog; a route name is accepted because routing entries belong to the generate function and are validated when that function runs; and an `agent-identity` override must name an agent in the Bureau catalog. Unknown coordinates are rejected with `policy-denied`. For `model`, `provider`, `route`, and `effort`, a `policyRef` names a profile in `BureauOptions.modelPolicy.users`. Bureau resolves and records the concrete coordinate before admission, then applies the same catalog check as an explicit override. An unknown profile or missing coordinate is rejected with `policy-denied`. Only `agent-identity` with a `policyRef` remains unsupported with `selector-unavailable`. The Operative selection and epoch types carry the effective values used by the later step boundary.

Policy profiles supply each configuration coordinate as follows:

| Target     | Profile value                                                              |
| ---------- | -------------------------------------------------------------------------- |
| `model`    | `exactOverride.model`                                                      |
| `provider` | `exactOverride.provider`                                                   |
| `route`    | `exactOverride.route`; route existence is checked by the generate function |
| `effort`   | `exactOverride.effort`, falling back to `defaultEffort`                    |

The persisted command contains the resolved override, so recovery does not reinterpret an old policy reference against a changed profile.

## Ownership and cleanup

The runtime ownership matrix is intentionally made from existing public handles:

| Resource | Starts work | Live observation | Cancellation request | Cleanup evidence |
| --- | --- | --- | --- | --- |
| Operative `AgentRun` | `agent.run()` | events, `snapshot()`, `subscribeSnapshot()` | `abort()` | `await run.closed()`; `await run.result()` is the terminal run outcome |
| Operative `ActiveRun` | `createActiveRun()` | events, `snapshot()`, `subscribeSnapshot()` | `abort()` | `await run.closed()`; `await run.result` is the terminal run outcome |
| Durable Operative run | `createActiveRun()` with engine/checkpoint options | the same run facade plus `durablyStarted` | `abort()` and durable engine cancellation | `durablyStarted` proves initial durable admission; `await run.closed()` proves cleanup acknowledgement |
| Bureau session or run | `createRun()` / `run()` | Bureau summaries, events, liveness, and locators | `abortRun()` or session cancellation | Bureau shutdown report, `listAbortingRuns()`, and quiescence report |
| Operative child run | `dispatchChildRun()` or `createSubagentTool()` | the handle's events, `multiagent.child-workflow.*` events, `ChildRunRegistry` descriptors, typed child events | `handle.abort()`, `registry.abortChild()`, or the parent's signal; never a sibling | `await handle.result()`; the parent's `closed()` waits for registered children |
| Bureau child | `bureau.children.dispatch()` | `children.list`, `get`, `wait`, and `child.*` audit entries | `children.cancel()`, or the child's `parentCancellation` policy when its parent is cancelled | `children.wait()` resolves `settled` once the terminal record is written |
| Armorer tool execution | `toolbox.execute()` | `toolbox.inspect()` for catalog views; `toolbox.executions.inspect()`, `toolbox.executions.subscribe()`, and `toolbox.executions.locate(executionId)` for lifecycle state; the returned `ExecutionHandle` has `snapshot()` | `handle.abort()` or toolbox shutdown | `await handle.whenSettled()` plus `ExecutionCleanupReport`; `unknown-effect` remains unresolved |
| Conversationalist controller | `new Conversation()` and streaming/compaction helpers | snapshots, revisions, events, external-store subscription | stream cancellation or `dispose()` | `dispose()` awaits owned work; `close()`/`complete()` only close mutation admission |
| Lifecycle event or deferred work | `events()`, `subscribe()`, `deferred.track()` | iterator, subscription, `outstandingDeferred()` | `return()`, `unsubscribe()`, or owner signal | iterator/subscription completion or `deferred.drain()` report |

Child runs are parent-owned; [Parent, child, and peer communication](#parent-child-and-peer-communication) below covers how they are addressed and observed.

The distinction matters in failure handling. `abort()` is a request signal. `AgentRun.result()` resolves ordinary model, tool, and cancellation outcomes, but `AgentRun.closed()` waits for tool drains, hooks, and registered children before returning `completed`; a cancellation-ignoring callback can therefore leave cleanup pending after the result has settled. Armorer makes the same distinction explicit with `whenSettled()` and `unknown-effect`.

## Parent, child, and peer communication

A parent addresses its children; nothing addresses a peer. The [multi-agent lifecycle guide](./multi-agent-lifecycle.md) is the full contract, with runnable examples. This is the summary.

**Addressing.** An Operative child is named by the handle `dispatchChildRun` returns: `childRunId`, the caller-supplied `parentRunId`, and `agentName`. The handle, its lifecycle events, and every signal carry that pair, and `ChildRunRegistry.abortChild(id)` reaches one child by its identifier. A Bureau child is named by a `BureauChildReference`: the owning `parentRunId`, the child's stable `childRunId` (also its durable workflow identifier), and an optional `principal`. Bureau accepts a `createRun` run, a durable `bureau.run` run, or another child as a parent. Every `bureau.children` read and write names the parent, and an unrelated parent or a mismatched principal reads as `not-found`. A child's record carries the parent run's principal or, when the parent has none, the principal that dispatched it; `dispatch` compares the caller's principal with the parent's, and every other operation compares it with the child record's.

**Observation.** Operative dispatches `multiagent.child-workflow.started` and then one terminal `.completed`, `.failed`, or `.aborted` event per child, and a wired `ChildRunRegistry` backs `AgentRun.children()`, `listChildRuns()`, and `worstChildAssessment`. Bureau exposes `children.list`, `get`, and `wait`, and writes `child.started`, `child.completed`, `child.failed`, `child.aborted`, and `child.reattached` audit entries when persistence is configured. These reads are non-consuming. Bureau children are not registered in the parent `AgentRun`'s registry. `ChildWorkflowReattachedEvent` and `ChildWorkflowProgressEvent` are typed but have no production emitter.

**Communication contract.** The only message path is a typed parent-child signal channel (COR-814) bound to one pair when it is created. The parent's `send` resolves `acknowledged` once the child's handler settles, or `rejected` with `handler-failed`, `invalid-payload`, `unknown-name`, `buffer-full`, or `channel-closed`. The child's `emit` reaches the parent's listener. Every payload is schema-validated and cloned, and it is data, not authority: the recipient decides whether to act. Bureau's `children.signal` sends signals to children whose agents have a contract in `BureauOptions.children.signals`, but it offers no way to observe a child's events. Channels are in-memory in both packages. A signal is never persisted, replayed after a restart, or delivered across processes.

**Peers.** Direct peer messaging is unsupported. COR-807 rejected it because no concrete consumer scenario showed an advantage that supervisor-mediated communication could not provide, so there is no sibling address, peer mailbox, broadcast, group channel, or shared blackboard. To move information between siblings, the parent observes one and signals the other. Durable peer delivery, COR-812, is not implemented; it was canceled after that decision. The `CollaborationPlan` and `CollaborationMessage` shapes from COR-820 are a recorded decision with no exported types or runtime.

The detailed references are [Operative's child dispatch and discovery](../packages/operative/README.md#child-dispatch-and-discovery-ab-50), [Operative's delegation grants](../packages/operative/README.md#delegation-grants-cor-336), and [Bureau's parent-child topology](../packages/bureau/README.md#parent-child-topology-cor-772).

## Durable boundaries and unsupported capabilities

Bureau's durable session surface is capability-driven. `signalSession` has a real delivery path on the current built-in workflow, while `updateSession` and `querySession` are explicitly unavailable because that workflow registers no update or query handler. `submitSessionInput` likewise returns `unsupported-capability` until the adopted Weft version supplies the durable mailbox. A host should surface these outcomes as deployment capability facts instead of retrying them as provider errors.

To use the supported durable paths, compose `createBureau()` with a raw Weft-backed `storage` configuration and omit a custom `persistence` value; the same backend supplies session persistence and checkpointed execution. After `createBureau()` resolves, call `await bureau.waitForRecovery()` before presenting recovered-run state. `bureau.signalSession(sessionId, name, payload)` delivers a fire-and-forget signal to an in-flight durable run and resolves after dispatch; the built-in workflow has no public update or query handler, so `updateSession` and `querySession` throw `BureauError` with `UNSUPPORTED_CAPABILITY`.

Durable schedules are owned by the Weft engine. `createSchedule(definition)` returns a schedule summary (or `undefined` when no durable engine is composed), and `pauseSchedule`, `resumeSchedule`, and `cancelSchedule` return `true` after the engine accepts the transition. A schedule definition names a catalog agent and its recurrence; each occurrence has its own run identity and can be skipped by the configured overlap policy. A process restart reattaches in-flight durable runs and resumes native schedules during Bureau recovery; call `waitForRecovery()` to read the typed `clean`, `partial`, or `failed` report. See the [Bureau durable API table](../packages/bureau/README.md#public-api) and the [Weft durability guide](../packages/weft/README.md) before choosing storage or ownership settings.

Human review is created by a tool approval policy or the `requestHumanInput` tool; the Bureau exposes the resulting queue through `listPendingReviews()` and `getReview(id)`. A pending review records its session, run, tool or signal, and review identifier. `resolveReview({ id, decision: 'approve' | 'deny' | 'reject', principal, ... })` is the owner-side transition. Approval resumes the waiting tool or sends the configured session signal, denial records the decision, and rejection requires a reason. Unknown or already-resolved reviews fail at this boundary rather than being silently replayed. Keep the review identifier and principal with the host's durable state so a reviewer can resolve it after a restart; the review event intentionally omits approval arguments and decision reasons from broadcast frames.

The same rule applies to schedule wakeups and human review tools: Operative throws `DurableCapabilityUnavailableError` when a durable-only tool is invoked outside a durable run. A process-local scheduler, durable Weft workflow, and human-review mailbox are three different owners; the host must compose the one it intends to operate and await that owner's cleanup boundary. Durable steering keeps its own append-only steering log rather than a mailbox (see [Durable steering log](./durable-steering-log.md)), while session input remains an explicit `durable-mailbox-unavailable` outcome until the adopted Weft surface supplies that capability.

## Source map and retained guides

The package READMEs remain the detailed API references. Start with [Operative's `createActiveRun()` and session sections](../packages/operative/README.md#event-driven-style-with-createactiverun), [Bureau's model catalog and test harness sections](../packages/bureau/README.md#test-utilities), [Conversationalist's events section](../packages/conversationalist/README.md#events), [Armorer's execution lifetime section](../packages/armorer/README.md#execution-lifetime), [Lifecycle's manual runtime section](../packages/lifecycle/README.md#createmanualruntimeservices-identifier-seeding), and [Testing's deterministic boundaries](../packages/testing/README.md#deterministic-test-boundaries). For the complete exported steering and session-input type contracts, see [Operative's type-safe API contract](./operative-type-safe-api.md#steering-commands); for the hook ownership hierarchy those runs compose, see [Hierarchical hook composition](./hierarchical-hook-composition.md); for parent, child, and delegated work, see [Multi-agent lifecycle and communication](./multi-agent-lifecycle.md). The implementation sources that define the contracts are `packages/operative/src/providers/capabilities.ts`, `packages/operative/src/providers/selection.ts`, `packages/operative/src/context-epoch.ts`, `packages/bureau/src/model-policy.ts`, `packages/bureau/src/steering.ts`, `packages/armorer/src/execution-lifecycle.ts`, `packages/lifecycle/src/runtime-services.ts`, and `packages/conversationalist/src/history.ts`.
