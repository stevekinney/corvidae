# Runtime contracts across Corvidae

When a runtime starts work, the useful question is not only whether it eventually returns a value. You also need to know which provider capability was selected, which context the provider actually consumed, who owns the work, how a parent reaches the children it started, and whether cancellation reached a real cleanup boundary. This guide ties those contracts together across [Operative](../packages/operative/README.md), [Bureau](../packages/bureau/README.md), [Conversationalist](../packages/conversationalist/README.md), [Armorer](../packages/armorer/README.md), [Lifecycle](../packages/lifecycle/README.md), and [Testing](../testing/testing/README.md).

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

`bureau.models.plan(request)` answers what the current Bureau would use without starting a run, changing the catalog, or dispatching an event. The caller supplies `agentName`, an optional `taskClassification`, an optional model/provider/route/effort `requestedValue`, and an optional `principal`. Bureau supplies the live catalog and policy revisions.

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

`Bureau.submitSteeringCommand` admits `pause`, `resume`, `agent-identity`, `route`, `model`, `provider`, and `effort` for authorized, non-terminal sessions. The command is idempotent by `(principal, id)`, checks `expectedRevision` and `deadline`, and applies at a `runStep` boundary where applicable. It never retargets a provider call already in flight. On a durable session every decision is first appended to the session incarnation's steering log, and only then applied to desired state. Every process sharing the backend, including one recovering a run after a restart, folds the same log to the same state. See [the durable steering log](durable-steering-log.md). `agent-identity` is applied when the session starts its next run; the other configuration coordinates are effective at the next step boundary.

The following complete example creates an in-memory Bureau, starts a run with a public Armorer tool, pauses at the steering boundary, resumes it, and waits for the run summary to become terminal. It uses a release gate so the first tool call gives the pause command a deterministic boundary to reach:

```typescript
import { createBureau } from '@lostgradient/bureau';
import { createTool, createToolbox } from 'armorer';
import { createAgent, stopWhen } from '@lostgradient/operative';
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
  agents: {
    worker: createAgent({
      generate: async () => {
        generationCalls += 1;
        return generationCalls === 1
          ? { content: 'waiting', toolCalls: [{ name: 'wait-for-release', arguments: {} }] }
          : { content: 'finished', toolCalls: [] };
      },
      toolbox: createToolbox([waitForRelease]),
      stopWhen: stopWhen.noToolCalls(),
    }),
  },
  storage: { type: 'memory' },
});

try {
  const run = await bureau.createRun({
    agentName: 'worker',
    message: 'start',
    principal: 'operator-1',
  });
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

## Hosting in a long-lived process

A service, worker, or interactive CLI that hosts Weft, Operative, or Bureau owns its own SIGINT and SIGTERM. The libraries already expose every part a clean exit needs; the host composes them in one order: close admission, settle in-flight work under an explicit policy, and exit only after cleanup is acknowledged. Durable work the process does not finish stays in the store, and the next process recovers it. This is the shape every process manager relies on, from Ctrl-C at a terminal to a supervisor's SIGTERM followed by a relaunch.

This is the reference handler. It is the file `packages/bureau/src/test/signal-shutdown/shutdown-handler.ts`, copied here byte for byte, and `packages/bureau/src/signal-shutdown.test.ts` fails if the two differ.

```ts
/**
 * Turns SIGINT and SIGTERM into one orderly shutdown of a long-lived process.
 *
 * The first signal starts `shutdown`, which closes admission, settles in-flight
 * work under the host's policy, and resolves `true` only once every owner has
 * acknowledged its cleanup. The process then exits 0, or 1 when cleanup is not
 * acknowledged. A second signal during that wait exits at once with 130 (SIGINT)
 * or 143 (SIGTERM); durable work stays in the store for the next process.
 */
export type ShutdownSignal = 'SIGINT' | 'SIGTERM';

export interface ShutdownSignalOptions {
  readonly shutdown: (signal: ShutdownSignal) => Promise<boolean>;
}

export const EXIT_CODES = { settled: 0, unresolved: 1, SIGINT: 130, SIGTERM: 143 } as const;

export function handleShutdownSignals(options: ShutdownSignalOptions): void {
  let shuttingDown = false;
  const onSignal = (signal: ShutdownSignal): void => {
    if (shuttingDown) process.exit(EXIT_CODES[signal]);
    shuttingDown = true;
    options.shutdown(signal).then(
      (settled) => process.exit(settled ? EXIT_CODES.settled : EXIT_CODES.unresolved),
      () => process.exit(EXIT_CODES.unresolved),
    );
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}
```

The first signal calls `shutdown`; a second SIGINT while it runs exits at once with 130, which is how an operator who pressed Ctrl-C twice gets their terminal back. Each library supplies the `shutdown` callback from its own cleanup boundary:

| Host | `shutdown` callback | Settled when |
| --- | --- | --- |
| Weft engine | `await engine.shutdown()` | it resolves `true`: queued starts drained, write paths down, and the ownership lease released, so a relaunched engine adopts the in-flight workflow without waiting for the lease to lapse |
| Durable Operative run | `run.abort(reason)`, then `await run.closed()` | the cleanup acknowledgement is `completed`; the run's terminal status is `aborted` and its workflow is `cancelled` |
| Bureau | `await bureau.shutdown({ policy, timeoutMilliseconds })` | the `BureauShutdownReport` has `unresolved === 0` |

Bureau's `policy` decides what happens to in-flight runs. `'drain'` refuses any new run with a `CONFLICT` `BureauError` and lets each in-flight run reach its own terminal result; `'abort'` aborts them, and the abort is durable, so the next process finds those runs cancelled rather than resuming them. `timeoutMilliseconds` bounds only the wait. When it elapses, the report's `owners` names every owner still `unresolved`, the callback returns `false`, and the process exits 1 so the supervisor can tell an unacknowledged shutdown from a clean one; the unfinished run remains durable. A process forced out by a second signal, or killed with SIGKILL, leaves its workflow claims to lapse after `workflowClaimTtlMs`; the relaunched Bureau adopts the run once the claim lapses and finishes it. The tested relaunch drives `bureau.runDurableMaintenance()` while it waits.

`packages/bureau/src/signal-shutdown.test.ts` proves each row against a real child process and a real signal, and runs the Weft and Operative hosts under both Bun and native Node with `NodeSQLiteStorage`; `packages/bureau/src/process-crash-recovery.test.ts` covers the SIGKILL relaunch.

## Parent, child, and peer communication

A parent addresses its children, and a peer is reached over A2A. The [multi-agent lifecycle guide](./multi-agent-lifecycle.md) is the full contract, with runnable examples. This is the summary.

**Addressing.** An Operative child is named by the handle `dispatchChildRun` returns: `childRunId`, the caller-supplied `parentRunId`, and `agentName`. The handle, its lifecycle events, and every signal carry that pair, and `ChildRunRegistry.abortChild(id)` reaches one child by its identifier. A Bureau child is named by a `BureauChildReference`: the owning `parentRunId`, the child's stable `childRunId` (also its durable workflow identifier), and an optional `principal`. Bureau accepts a `createRun` run, a durable `bureau.run` run, or another child as a parent. Every `bureau.children` read and write names the parent, and an unrelated parent or a mismatched principal reads as `not-found`. A child's record carries its parent's owner, which is `anonymous:local` for a parent started with no principal; `dispatch` compares the caller's principal with the parent's, and every other operation compares it with the child record's.

**Observation.** Operative dispatches `multiagent.child-workflow.started` and then one terminal `.completed`, `.failed`, or `.aborted` event per child, and a wired `ChildRunRegistry` backs `AgentRun.children()`, `listChildRuns()`, and `worstChildAssessment`. Bureau exposes `children.list`, `get`, and `wait`, and writes `child.started`, `child.completed`, `child.failed`, `child.aborted`, and `child.reattached` audit entries when persistence is configured. These reads are non-consuming. Bureau children are not registered in the parent `AgentRun`'s registry. `ChildWorkflowReattachedEvent` and `ChildWorkflowProgressEvent` are typed but have no production emitter.

**Communication contract.** The only message path is a typed parent-child signal channel (COR-814) bound to one pair when it is created. The parent's `send` resolves `acknowledged` once the child's handler settles, or `rejected` with `handler-failed`, `invalid-payload`, `unknown-name`, `buffer-full`, or `channel-closed`. The child's `emit` reaches the parent's listener. Every payload is schema-validated and cloned, and it is data, not authority: the recipient decides whether to act. Bureau's `children.signal` sends signals to children whose agents have a contract in `BureauOptions.children.signals`, but it offers no way to observe a child's events. Channels are in-memory in both packages. A signal is never persisted, replayed after a restart, or delivered across processes.

**Peers.** A parent addresses its children; a peer is addressed by its Agent Card over A2A (COR-905), whether it runs in the same Bureau or another. `createA2APeerClient` from `@lostgradient/weft/a2a` reads and validates the card and calls the peer, and Operative's `createPeerCallTool` wraps that client as a tool. The call is a child run: it registers in the parent's `ChildRunRegistry` with `ChildRunDescriptor.remote` carrying the peer's task identity and latest state, and it emits the `multiagent.child-workflow.*` events. Aborting the call or `abortChild` sends `CancelTask` and ends the child `aborted` even when the peer refuses. The tool throws a distinct error for a `failed` or `rejected` task, for `input-required` (call again with the same `taskId` to continue), and for `auth-required`. A child that stopped at a question stays `running` and abortable (`abortChild` cancels the remote task) until a later call continues the task. Everything a peer returns is untrusted input attributed to its card identity. By default the call is synchronous and nothing is persisted, so a restart of the caller does not resume it. With `durable: bureau.peerCalls` (COR-1670), a durable run's tool call records the peer task it started under the run and the call's operation key, and the replay of that call after a restart follows the recorded task with `A2APeerClient.attach` instead of sending again; a replay that finds no record sends with a `messageId` derived from the operation key, so a peer that keeps message history answers with the task the first send created. Each record holds a digest of the request, and a replay that makes a different request at the same position fails with `PeerCallMismatchError` instead of following the other call's task. A peer that no longer knows a recorded task fails the replay with `task-not-found`; it is not sent again, because the first message may have had effects. The records are deleted when the run's task is removed. There is still no sibling mailbox, broadcast, group channel, or shared blackboard. COR-807 rejected direct peer messaging for lack of a consumer, and the owner's COR-901 ruling named operatives calling peers as that consumer. Durable same-Bureau peer delivery, COR-812, stays canceled. The `CollaborationPlan` and `CollaborationMessage` shapes from COR-820 are a recorded decision with no exported types or runtime.

The detailed references are [Operative's child dispatch and discovery](../packages/operative/README.md#child-dispatch-and-discovery-ab-50), [Operative's delegation grants](../packages/operative/README.md#delegation-grants-cor-336), and [Bureau's parent-child topology](../packages/bureau/README.md#parent-child-topology-cor-772).

## Durable boundaries and unsupported capabilities

Bureau's durable session surface is capability-driven. `signalSession` has a real delivery path on the current built-in workflow; the workflow registers no update or query handler, so Bureau has no verb for either. `submitSessionInput` admits input through the session's durable mailbox and returns `unsupported-capability` only when the Bureau has no durable mailbox (or the session id is too long to address one). Each `admitted` input ends with exactly one terminal receipt, and Bureau never starts a run to answer input (COR-1476). It reads `promoted` once a live run's step boundary appends its user turn to the conversation: before the run's next step generates, or once more after its last step generated while the run has a step left, so input sent during the final step is answered by one more step of the same run. The turn is appended at most once, in admission order within a run, keyed by the mailbox command (so an `id` reused after the mailbox retired its record, or in a later incarnation of the session, is a new input: each incarnation of a session has its own mailbox, a deleted incarnation's open input is cancelled and its mailbox retired by the sweep, and no reader has to check an incarnation), under the input's own `id` as its message id (a fresh id only when the conversation already holds a message with that id), and its promotion commits in the same atomic write as the transcript that holds the turn, whatever that step's outcome, so a transcript and its promotions never disagree. It reads `canceled`, with reason `the run ended before the input was delivered`, when the turn was not appended before its run ended, where a run ends by completing, failing, `abortRun`, `cancelDurableRun`, or being promoted but never started. The ending run first writes its steering `run-ended` entry (the not-live write every process honours over the engine's status, retried until it is acknowledged or the Bureau closes), then catches up steering and reads the session's liveness without itself; with another run of the session live or starting it only releases what it held, and that run's end does the cancelling; otherwise it cancels every open input whose turn is not in its checkpoint transcript, in admission order. `submitSessionInput` mirrors that order: it writes the session's open-input marker, commits the admission, catches up steering, and reads liveness, and with no run live or starting it cancels its own input and returns the re-read receipt (`receipt.state === 'canceled'`); a liveness read that fails is answered the same way. A client therefore learns of a cancellation from the input's absence in the run's terminal history and resends it. The boot sweep and the periodic sweep cancel a session's open input only when no run of it is live or starting, and run the mailbox's maintenance before that liveness check, so input under a run parked past the seven-day timeout still expires on time; input under an orphaned `running` workflow of a dead process stays open until that workflow is recovered, when its run delivers it, or marked terminal. Shutdown releases open input instead of cancelling it, for the next boot's recovered run to deliver or its sweep to cancel. Delivery is idempotent per mailbox command: a replayed step or a recovered run never appends the same turn twice, and a lease a crashed process held delays delivery by up to about 31 seconds (the mailbox's 30 second visibility timeout plus its short retry backoff). Input for a run parked on a human reviewer or a wakeup is delivered when the run resumes. An input still undelivered after seven days reads `expired`, one whose session is deleted reads `canceled`, and one that cannot be decoded reads `failed`. A request's `expiresAt` and `supersedes` are stored but not yet honored. A host should surface the unsupported outcomes as deployment capability facts instead of retrying them as provider errors.

To use the supported durable paths, compose `createBureau()` with a raw Weft-backed `storage` configuration; the same backend supplies session persistence and checkpointed execution. After `createBureau()` resolves, call `await bureau.waitForRecovery()` before presenting recovered-run state. `bureau.signalSession(sessionId, name, payload)` delivers a fire-and-forget signal to an in-flight durable run and resolves after dispatch; the built-in workflow has no public update or query handler, so Bureau offers no update or query verb.

Durable schedules are owned by the Weft engine. `createSchedule(definition)` returns a schedule summary (or `undefined` when no durable engine is composed), and `pauseSchedule`, `resumeSchedule`, and `cancelSchedule` return `true` after the engine accepts the transition. A schedule definition names a catalog agent and its recurrence; each occurrence has its own run identity and can be skipped by the configured overlap policy. A process restart reattaches in-flight durable runs and resumes native schedules during Bureau recovery; call `waitForRecovery()` to read the typed `clean`, `partial`, or `failed` report. See the [Bureau durable API table](../packages/bureau/README.md#public-api) and the [Weft durability guide](../packages/weft/README.md) before choosing storage or ownership settings.

Human review is created by a tool approval policy or the `requestHumanInput` tool; the Bureau exposes the resulting queue through `listPendingReviews()` and `getReview(id)`. A pending review records its session, run, tool or signal, and review identifier. `resolveReview({ id, decision: 'approve' | 'deny' | 'reject', principal, ... })` is the owner-side transition. Approval resumes the waiting tool or sends the configured session signal, denial records the decision, and rejection requires a reason. Unknown or already-resolved reviews fail at this boundary rather than being silently replayed. Keep the review identifier and principal with the host's durable state so a reviewer can resolve it after a restart; the review event intentionally omits approval arguments and decision reasons from broadcast frames.

The same rule applies to schedule wakeups and human review tools: Operative throws `DurableCapabilityUnavailableError` when a durable-only tool is invoked outside a durable run. A process-local scheduler, durable Weft workflow, and human-review mailbox are three different owners; the host must compose the one it intends to operate and await that owner's cleanup boundary. Durable steering keeps its own append-only steering log rather than a mailbox (see [Durable steering log](./durable-steering-log.md)), while session input rides the session's durable mailbox, which the run workflow drains at each step boundary (see the guarantees above); a Bureau without a durable mailbox answers it with the explicit `durable-mailbox-unavailable` outcome.

**Invocation-driven execution.** Durable Weft and Operative work does not need a long-lived process. [`invocation-driven-execution.test.ts`](../packages/bureau/src/invocation-driven-execution.test.ts) runs every invocation as a fresh Bun process over one shared SQLite file, with `backgroundTasks: 'manual'`, a `getNow` clock the driver owns and passes on to `runMaintenance(now)`, and a small `workflowClaimTtlMs`; each invocation does bounded work, shuts its runtime down, and must exit on its own within 30 seconds. A Weft workflow with an activity and a durable timer completes from `engine.start`, one later `engine.runMaintenance(now)`, and a result read. An invocation that overlaps another one holding the workflow's claim commits no step, and after an invocation is killed with SIGKILL inside an activity, a wake-up past the claim's TTL takes the workflow over and commits that step exactly once. An Operative durable run that parks on `scheduleWakeup` completes in the next invocation, whose `resolveWorkflowServices` rebuilds its `generate`. Bureau has a limit: an invocation can exit on its own only through `bureau.shutdown()`, whose default `'abort'` policy cancels a run parked on a timer, so the next invocation inherits a cancelled run, as the test "cannot hand a parked run to the next invocation: shutting down to exit cancels it" asserts. Bureau forwards no `getNow` to its engine, so its timers use the wall clock.

## Source map and retained guides

The package READMEs remain the detailed API references. Start with [Operative's `createActiveRun()` and session sections](../packages/operative/README.md#event-driven-style-with-createactiverun), [Bureau's model catalog and test harness sections](../packages/bureau/README.md#test-utilities), [Conversationalist's events section](../packages/conversationalist/README.md#events), [Armorer's execution lifetime section](../packages/armorer/README.md#execution-lifetime), [Lifecycle's manual runtime section](../packages/lifecycle/README.md#createmanualruntimeservices-identifier-seeding), and [Testing's deterministic boundaries](../testing/testing/README.md#deterministic-test-boundaries). For the complete exported steering and session-input type contracts, see [Operative's type-safe API contract](./operative-type-safe-api.md#steering-commands); for the hook ownership hierarchy those runs compose, see [Hierarchical hook composition](./hierarchical-hook-composition.md); for parent, child, and delegated work, see [Multi-agent lifecycle and communication](./multi-agent-lifecycle.md). The implementation sources that define the contracts are `packages/operative/src/providers/capabilities.ts`, `packages/operative/src/providers/selection.ts`, `packages/operative/src/context-epoch.ts`, `packages/bureau/src/model-policy.ts`, `packages/bureau/src/steering.ts`, `packages/armorer/src/execution-lifecycle.ts`, `packages/lifecycle/src/runtime-services.ts`, and `packages/conversationalist/src/history.ts`.
