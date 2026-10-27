# Bureau

`@lostgradient/bureau` is Corvidae's fleet composition layer. `createBureau()` assembles providers, tools, memory, skills, session persistence, durable execution, guardrails, and multi-agent behavior from one configuration surface, then exposes the runtime through a single `Bureau` object.

## Workspace usage

Declare `"@lostgradient/bureau": "workspace:*"` in the consuming workspace's dependencies. Install dependencies from the Corvidae root with `bun install`. Import the private package through `@lostgradient/bureau`; it exports TypeScript source directly and has no library build or publication step.

## Table of Contents

- [Overview](#overview)
- [What It Does](#what-it-does)
- [How It Works](#how-it-works)
- [Project Role](#project-role)
- [Quick Start](#quick-start)
- [Public API](#public-api)
  - [`createBureau(options)`](#createbureauoptions)
  - [`BureauOptions`](#bureauoptions)
  - [The `Bureau` Object](#the-bureau-object)
  - [Tasks (`bureau.tasks`)](#tasks-bureautasks)
  - [`streamEventToFrame`](#streameventtoframe)
  - [The Audit Trail](#the-audit-trail)
  - [Run-creation receipts (COR-424)](#run-creation-receipts-cor-424)
  - [The AG-UI mount (COR-855)](#the-ag-ui-mount-cor-855)
  - [External control plane](#external-control-plane)
  - [A2A](#a2a)
  - [Interactive surfaces (COR-1631)](#interactive-surfaces-cor-1631)
  - [The Durable Event History Store (AB-91)](#the-durable-event-history-store-ab-91)
  - [Parent-child topology (COR-772)](#parent-child-topology-cor-772)
  - [Durable goals (COR-851)](#durable-goals-cor-851)
  - [Multimodal content and managed assets](#multimodal-content-and-managed-assets)
  - [Governed memory (COR-41)](#governed-memory-cor-41)
- [`AgentDefinitions` and the Agent Catalog](#agentdefinitions-and-the-agent-catalog)
  - [Agent files (COR-1524)](#agent-files-cor-1524)
  - [Workflow files (COR-1527)](#workflow-files-cor-1527)
  - [`createSupervisor` and `createAgentDiscoveryTool`](#createsupervisor-and-createagentdiscoverytool)
- [Test utilities](#test-utilities)
- [Development](#development)

## Overview

Everything else in the workspace is a library: `operative` runs one agent loop, `armorer` executes tools, `memory` recalls facts, `skills` catalogs procedures. `bureau` is where those libraries become a fleet—a runtime that can create runs, resume them across a crash, hold live sessions, run scheduled and durable schedules, and route requests to more than one named agent.

Applications own HTTP and browser integration. `createBureau()` has no HTTP dependency and can be called directly from a Bun process. `createBureauHandler(bureau, options)` returns a `(request: Request) => Promise<Response>` that serves the Bureau's event feeds, review queue, and management plane (`weft.system.principal`, `bureau.deployment.get`, `bureau.agents.list`, `bureau.tasks.list`/`get`/`cancel`/`respond`/`events`, `bureau.contexts.list`/`get`/`input`/`delete`, `bureau.audit.query`, `bureau.schedules.list`/`get`/`create`/`pause`/`resume`/`cancel`/`update`, `bureau.goals.list`/`get`/`create`/`cancel`, `bureau.memory.list`/`search`/`get`/`forget`/`correct`, and `bureau.assets.uploads.create`/`append`/`complete` and `bureau.assets.get`, with `GET /assets/{assetId}/content` streaming an asset's bytes); the handler needs a Bureau with an asset service (`assets` on `createBureau`) and throws at construction without one; `maxRequestBodyBytes` caps a JSON-RPC body (Weft's default is 1 MB), so an upload chunk over it is refused with 413 before anything is written; the application still binds the port, for example with `Bun.serve({ fetch: handler })`. Authentication is `resolveApiKeyPrincipal` (static `apiKeys` throw at construction) or `unauthenticatedAccess: 'allow'`, which serves every request as one local caller owned as `anonymous:local`. `agUi: {}` additionally mounts the [AG-UI adapter](#the-ag-ui-mount-cor-855), which streams runs to an AG-UI 1.0 client. A principal reaches the reviews and run events it owns without any Bureau scope, the kind's operator scope (`bureau.reviews:read`, `bureau.reviews:resolve`, `bureau.tasks:read`, `bureau.tasks:write`, `bureau.contexts:read`, `bureau.contexts:write`, `bureau.audit:read`, `bureau.schedules:read`, `bureau.schedules:write`, `bureau.goals:read`, `bureau.goals:write`) grants cross-owner access (`bureau.assets:read` and `bureau.assets:write` gate who may upload and read assets and grant nothing across owners), `bureau.events` needs `bureau.events:observe-all`, and a caller who may not see a resource is answered as if it did not exist. `bureau.memory:read` and `bureau.memory:write` are required rather than an alternative to owning, and grant no one else's memory, so a caller without the scope is `Forbidden`. See [Owner of record](#owner-of-record-cor-718).

## What It Does

- Composes a runtime from `BureauOptions`: a catalog of agents (each owns its `generate`, tools, skills, guardrails, stop conditions, and instructions), memory, session persistence, durable execution, and identity configuration.
- Starts tasks (`bureau.tasks.start`), tracks them, cancels them, and lists them by status.
- Persists sessions through a `SessionStore` and recovers in-flight durable runs after a process restart (`engine.recoverAll()`), reattaching bureau-owned runs and monitoring native scheduled fires.
- Exposes durable primitives when a durable engine is composed: `bureau.contexts.signal` delivers a real fire-and-forget signal; `bureau.contexts.input` runs AB-42's fixed pre-admission checks (authorization, then session lifecycle, then capability/capacity), and an authorized request on a session that is not terminal reaches the durable session mailbox (`admitted`, `replayed`, `conflict`, or `backlog-exhausted`); it returns `{ outcome: 'unsupported-capability', reason: 'durable-mailbox-unavailable' }` only when no session mailbox, durable storage, or key-value store is composed (AB-194, COR-435); `bureau.contexts.steer` admits `pause`, `resume`, `agent-identity`, `route`, `model`, `provider`, and `effort` for authorized in-memory and durable sessions, persisting durable commands before applying them; `policyRef` resolves configuration coordinates through `modelPolicy.users`, while an `agent-identity` `policyRef` remains `unsupported-capability` with `selector-unavailable`; plus full CRUD over durable schedules (`bureau.schedules`).
- Emits a typed event surface (`BureauEventMap`) and live WebSocket/SSE-ready frames (`ServerFrame`) via `subscribeLiveFrames` and `streamEventToFrame`.
- Records a durable, append-only audit trail of tool, run, and step lifecycle events when persistence is configured.
- Gives the runs it composes governed memory (COR-41): recall through mandatory recall admission and persistence through write admission, both under an authority derived from the run's persisted request (see [Governed memory](#governed-memory-cor-41)).
- Exposes a typed `AgentDefinitions` catalog (`bureau.agents`) and `bureau.tasks.start(name, input, options?)`, which starts a task of a statically named agent in a context (a session) and resolves with its handle.
- Records durable parent-child relationships (`bureau.children`): dispatch a catalog agent as a child of a known run, then list, inspect, wait on, signal, and cancel it by a stable identifier, including after a restart, with optional signed delegation grants that bound how deep and how wide the tree below each child may grow. A top-level parent holds no grant, so its own dispatches are neither checked nor budgeted.

## How It Works

`createBureau(options)` is async because composing the runtime may involve resolving a Weft storage backend, building a durable engine, and loading a session store. The returned `Bureau` object wraps an `@lostgradient/operative` `Store` (the live run/action registry), an optional `GovernedMemory`, an optional `Scheduler`, and the resolved runtime composition (session store, durable engine, memory, and the agent catalog's dispatch).

`tasks.start(agentName, input, options?)` loads or creates a context (a session), appends the input to its conversation, builds an `ActiveRun` via `operative`'s `createActiveRun`, and registers it with the store. If a durable engine is composed, the run is routed through it instead of the in-memory loop, so it can crash and resume from its last completed step. Terminal run events (`run.completed`, `run.aborted`) persist the session's status with a bounded retry.

A task names a catalog agent and runs it. The run uses the agent's own `generate`, tools, skills, guardrails, system prompt, `maximumSteps`, `maximumTokens`, and stop conditions (a start has no per-request override of any of them; they belong to the agent definition), with the Bureau's memory, identity, and tools (`requestHumanInput` and `scheduleWakeup` on a durable Bureau, both on by default) composed around it. A context is bound to the agent that created it: a later task names the same agent, and naming another is a `BAD_REQUEST`. A name outside the catalog is `NOT_FOUND`, which includes `bureau`: the implicit Bureau-wide agent that ran on `BureauOptions.generate` and its siblings no longer exists, and a session, schedule, or recovered run stored under it is refused (a new run, a schedule fire) or fails with a diagnostic (a recovered run) rather than running. A durable named run recovers as its agent. If the agent has left the catalog the run fails, and if its definition revision changed Bureau logs a warning and resumes with the current definition. A schedule's fire runs its named agent the same way, resolved through the catalog, and a fire whose agent is missing settles as unavailable with the reason. A skill an agent activates survives a crash: Bureau snapshots the active records of the agent's own `createAgentSkills` client into the session after every step and, on recovery, re-validates them against the live catalog before the run's first step.

A durable Bureau offers `scheduleWakeup` to a task by default, and `wakeup: false` removes it (`wakeup: true` throws `BAD_REQUEST`). It offers `requestHumanInput` by default too (COR-1700): `humanInput: false` removes it, `humanInput: true` throws `BAD_REQUEST` because it is already the default, and an object `{ inputSchemas }` keeps it and maps a `signalName` to a JSON Schema (2020-12) for the answer a person must give (COR-1674). A park on a signal with a schema carries it: an A2A client that activated A2UI's extension sees an A2UI form beside the prompt (any other client sees the prompt text alone), and an answer that does not satisfy the schema is refused before the run resumes. `createBureau` checks every schema with Operative's `checkHumanInputSchemas` and throws `HumanInputSchemaError` for one it cannot accept, and a run recovered after a restart parks with the same schemas. A signal with no entry takes any answer, as with the default.

```ts
import { createBureau } from '@lostgradient/bureau';

declare const agents: NonNullable<Parameters<typeof createBureau>[0]['agents']>;

const bureau = await createBureau({
  agents,
  durable: true,
  humanInput: {
    inputSchemas: {
      deploy: {
        type: 'object',
        properties: { environment: { type: 'string', enum: ['staging', 'production'] } },
        required: ['environment'],
        additionalProperties: false,
      },
    },
  },
});
```

On a durable Bureau, an agent can call `requestHumanInput` to park its run, in a task (a child run or a goal attempt is not offered the tool, and neither is anything on a Bureau with no durable engine). The park appears in `bureau.reviews.list()` as a `human-wait` review. A task's review carries its context's id as `sessionId`, and `runId` is the task's id. `bureau.reviews.resolve` resumes it: `approve` delivers the optional `payload`, and `deny` and `reject` deliver the same denial and rejection markers on the signal. A task's park is resolved through the engine by run id, under a delivery id derived from the review id (the review id itself, or a fixed-length hash of it when it exceeds Weft's 128-byte `signalId` limit, as a long `signalName` makes it), so a retried resolve delivers once. The engine's own record of what the run waits on decides whether a review is still pending, so resolving does not depend on the audit trail. After a restart a parked task is listed again under the id it had. The agent must stop on the call (`stopWhen.toolCalled('requestHumanInput')`) for the run to park. A schedule fire is offered `requestHumanInput` the same way, and what it waits on is a review of the fire: its `runId` is the fire's run id (its task id), its `sessionId` is the session the fire runs in, and its owner is the schedule's owner. A fire's park is listed live and after a restart, and `bureau.tasks.respond` or `bureau.reviews.resolve` answers it. A tool call a fire's step leaves awaiting approval is a `tool-approval` review of the fire in the same way, recorded with the fire's session, in the same write as its conversation, so a restart lists it again. A restart lists only the approvals the fire's run committed, whether the fire is still going or has ended: the run's checkpoint is the source of truth, and what the session holds is a claim made before the step committed. One from a step that crashed before its commit is not restored, the replayed step records its own, and the session is reconciled with the checkpoint when the fire settles. `bureau.reviews.resolve` with `approve` runs the tool, and the fire's task is `input-required` until it is decided. An approval nobody answers expires like any other, in the expiry sweep every maintenance pass runs, and a canceled fire's approvals are revoked and removed from its session, so a restart never brings one back to run a tool for a canceled run. The engine's own status decides whether a fire was canceled, at boot and again when an approval is decided: a fire the engine records as `cancelled`, whichever process canceled it and however far the cancel's bookkeeping got, restores nothing, and deciding its approval is refused with `CONFLICT`. A boot that cannot read the engine's status restores nothing and prunes nothing, and tries again at the next boot. A decided, expired, canceled or abandoned approval leaves nothing of its own in the session; what fences a concurrent resolver goes with the fire's task at retention. A fire announces each review it raises as `review.requested`, and its `bureau.tasks.events` stream reads `input-required` while a review is open and ends when the last one closes, decided or expired. A fire that takes another step after an approval writes its conversation back then, over the outcome an early decision would have recorded, so deciding such an approval throws `ApprovalOutcomeNotWrittenError`: configure the agent with `stopWhen.pendingApproval()`. Reviews of a fire are the same on every Bureau sharing its stores (COR-1613). Another instance answers a fire's `requestHumanInput` park through the engine by run id, without holding the fire, and the fire completes on its holder. A review closed by another instance, decided or expired, reaches the holder through the run's shared durable history: it drops its own copy and re-reads the task, whether or not a stream is open (COR-1621), so a `bureau.tasks.events` stream it serves ends when the last review closes anywhere. A peer's re-gate leaves the review listed at the round the session holds, and a decision on a round a peer has re-gated since is refused with `CONFLICT`. A `-1` reconnect to that stream is told the fire's current status first. A replayed step announces the same `review.requested` once, by review id from the run's history, and a request a replay abandoned (the model minted a new tool call id) is closed with `review.superseded` when the fire settles or is canceled. A canceled fire's approvals and parks are each closed once per round in the audit trail and the durable history, by whichever process finds them first, whichever route cancels the fire, and including after a crash and restart. A re-gate (`review.superseded`) does not close an approval: it stays pending under its id at the next round, and a task stream that replays the history does not drop it. The expiry sweep leaves a review alone while a decision on it is in flight. An approval or park the canceled fire was holding is recorded as `canceled` by principal `system:run-abort` only when no terminal record exists. A restored approval is decided under the skills the run has active now, which are the last set it committed (a fire's from its checkpoint, a session run's from its session snapshot), not the set that was active when the call was requested, so a skill activated after the request can narrow a tool away from it. A call those skills refuse is refused after a restart, and a tool the active skills do not permit cannot be approved even live (`CONFLICT`). The snapshot is read again on each approve (COR-1620), so a read that failed once does not fix the policy for good. When the policy that governed the call cannot be verified, the approve is refused with `CONFLICT` and runs nothing, and a deny still goes through. Unverifiable is a snapshot that fails to be read or deserialized, one that names another fire (a recurring schedule's newer fire) or another run, a stored skill the catalog refuses on recovery (a revoked source or a drifted digest), and a run with no toolbox of its own whose session names active skills, which the base toolbox cannot enforce. A snapshot that verifiably names no skill is not unverifiable: a run that never activated one is approved as before. A snapshot a later run cleared is unverifiable too: the start of a run in a session nulls the session's skill records and their run id, so a cleared snapshot whose run id is null while the session's last run is another run is that run's reset, not a record that this run had no skills (a Bureau with no skills has nothing to verify, and is not affected). The same holds for every toolbox recovery builds, not only the restore's: a fire replayed after its process died in a step, and a session run reattached the same way, are offered no tool and write no skill snapshot when their snapshot cannot be verified or a stored skill is refused on recovery, so what they persisted before is kept, and an approval they raise is refused at approve under the snapshot read again. The automatic maintenance profile runs that sweep on its own timer (every five minutes), so expired state goes without a host call, and an approval's session prune commits before its in-memory state is dropped: when the prune fails the approval stays hidden and refused, and the fire's next release retries it. A fire that settled with a review still open counts as activity for its context, so `bureau.contexts.list` and `get` read `awaiting-input` as `bureau.tasks.get` reads `input-required`.

On boot, if durable execution is configured, `bureau` sweeps suspended scheduler-origin residue and calls `engine.recoverAll()`. Each recovered handle is classified—`reattach` (a bureau-owned, in-flight, session-confirmed run becomes a live `ActiveRun` again), `monitor` (a native scheduled fire gets a detached result monitor but no live run surface), `cancel` (a positively unowned or unidentifiable run is terminalized), or `skip` (ownership can't be confirmed, so recovery leaves it alone rather than risk cancelling a legitimate resume).

## Project role

`@lostgradient/bureau` composes the agent packages and `@lostgradient/weft`. A host application can put HTTP routes, a browser interface, or a live transport around that runtime; Bureau itself stays transport-agnostic.

## Quick Start

Give `agents` a catalog entry built with `createAgent`, then start a task of it with `bureau.tasks.start(name, input, options?)`.

```typescript
import { createBureau } from '@lostgradient/bureau';
import { createAgent, type GenerateFunction } from '@lostgradient/operative';

declare const generate: GenerateFunction;

const bureau = await createBureau({
  agents: { summarizer: createAgent({ generate }) },
  storage: { type: 'sqlite', path: 'bureau.sqlite' },
});

const run = await bureau.tasks.start('summarizer', 'Summarize the Q3 report.');
console.log(bureau.tasks.detail(run.id)?.status); // "running"

// Wait for completion via the live event surface. A run records many actions
// before it finishes, so keep the subscription open until this run's terminal
// action arrives, then close it.
await new Promise<void>((resolve) => {
  const subscription = bureau.subscribe('action', ({ action }) => {
    if (action.runId !== run.id) return;
    if (action.type === 'run.completed' || action.type === 'run.aborted') {
      subscription.unsubscribe();
      resolve();
    }
  });
});

const detail = bureau.tasks.detail(run.id);
console.log(detail?.finishReason); // "stop-condition" | "maximum-steps" | …

await bureau.dispose();
```

Without `storage`, runs are ephemeral: nothing is persisted, and a crash loses in-flight work. Pass a `sqlite` or `lmdb` `storage` configuration to get session persistence and, by default, durable crash-and-resume execution.

## Public API

### Selection, steering, and capability boundaries

The full provider matrix, `SelectionPlan` field map, steering example, ownership table, and durable capability boundaries live in [Runtime contracts across Corvidae](../../documentation/runtime-contracts.md).

`bureau.models.plan(request)` is a synchronous read of the current model catalog and policy. It returns a versioned `SelectionPlan` describing the requested, supported, allowed, selected, fallback, and effective model and effort values without starting a run or changing the catalog. Use the plan as an explanation and pass it into the run boundary that owns execution; a plan is not a reservation.

`bureau.contexts.steer()` admits the seven shipped steering targets for authorized, non-terminal sessions. `pause` and `resume` bind to a run; `agent-identity` is deferred to the next run; and `route`, `model`, `provider`, and `effort` apply at the next step boundary. Durable sessions persist the command before entering desired state, so recovery can replay it. Unsupported policy references return a typed `unsupported-capability` outcome, and a command that is accepted still applies at its named boundary rather than interrupting a provider call halfway through. Read the resulting steering event or run snapshot to confirm application.

Durable session input, update, query, schedules, and human review are separate capabilities. A composed Bureau advertises them through its capability surface and returns an explicit unsupported outcome when the backing engine or mailbox is absent. Treat `unsupported-capability` as a deployment fact to surface to the host, not as a transient provider error to retry.

### `createBureau(options)`

```typescript
import {
  createBureau,
  type AgentDefinitions,
  type Bureau,
  type BureauOptions,
} from '@lostgradient/bureau';

const create: <const D extends AgentDefinitions = AgentDefinitions>(
  options: BureauOptions<D>,
) => Promise<Bureau<D>> = createBureau;
```

Composes and returns a `Bureau`. `agents` is the only required field—pass `{}` for a bureau that only dispatches durable primitives and doesn't run an agent at all. Every run belongs to a catalog agent, which owns its own `generate`, tools, skills, guardrails, stop conditions, step cap, and instructions (COR-323 deleted the Bureau-wide `generate`, `provider`, `providers`, `routing`, `toolbox`, `guardrails`, `skills`, `stopWhen`, `maximumSteps`, and `systemPrompt` options); a request names its agent with `agentName`.

### `BureauOptions`

Every field is optional. `createBureau({})` resolves a Bureau with no agents.

| Field | Type | Purpose |
| --- | --- | --- |
| `id` | `string` | This Bureau's identity, as `bureau.id`, and the tenant every run's memory is written under. Defaults to a generated identifier, which is fine for a single in-process Bureau. Required with `memory` and `storage` together: a generated id changes on every start, so a restarted Bureau would read an empty memory tenant, and `createBureau` throws `BureauError` (`BAD_REQUEST`) instead. |
| `agents` | `AgentDefinitions` (`D`) | The typed agent catalog, exposed as `bureau.agents` and started by name through `bureau.tasks.start`. Omitted means `{}`, typed `Record<never, never>`, so `bureau.agents.names()` is `[]` and agent files use the string overload. The name `bureau` is reserved (it was the implicit Bureau-wide agent, which no longer exists), so an entry called `bureau` is refused with `BureauError` (`BAD_REQUEST`). |
| `children` | `{ signals?: { [agentName]?: ChildSignalContract }; delegation?: { secret; policyVersion?; defaultTimeToLiveMilliseconds? } }` | COR-772—configuration for `bureau.children`. `signals` registers each child agent's typed signal contract (contracts are code, so they are configured rather than persisted); `delegation` turns on signed COR-336 delegation grants. An empty `secret` or a non-positive lifetime is a `BAD_REQUEST` at construction. See [Parent-child topology](#parent-child-topology-cor-772). |
| `validators` | `readonly Validator[]` | COR-851—the validators durable goals may name. A goal stores only a validator's identity (name and version); the executable is registered here and resolved by that exact identity every time it runs, including after a restart. Two validators with the same name and version fail `createBureau`. See [Durable goals](#durable-goals-cor-851). |
| `resolveFreshAttemptSource` | `FreshAttemptSourceResolver` | COR-851—resolves the producing run's sealed context epoch and permitted actors for a `fresh-from-artifact` goal's handoff artifact. Omitted, no such goal can be created. See [Durable goals](#durable-goals-cor-851). |
| `store` | `Store` | Supply your own `@lostgradient/operative` `Store` instead of letting `bureau` create one. |
| `storage` | `StorageConfiguration \| Storage` | Configure session and key-value persistence: a Weft `StorageConfiguration`, or a `Storage` adapter you built (its lifecycle stays yours). One backend serves the sessions, the key-value view, and the durable engine. |
| `durable` | `boolean` | Override the default (on for persistent `storage`, off for `memory`) for Weft-backed crash-and-resume execution. |
| `maintenance` | `'automatic' \| 'manual'` | How the durable engine's periodic maintenance is driven. The default `'automatic'` uses in-process intervals; `'manual'` suits Cloudflare Durable Objects and other serverless hosts, which call `bureau.runDurableMaintenance()` from each alarm or Cron wake-up. |
| `retention` | `{ audit?; checkpoints?; events?; tasks?; receipts? }` | How long each kind of history is kept; every window is read at the next maintenance pass, and a bad value throws `BureauError` (`BAD_REQUEST`) at construction. `audit` is [`AuditRetentionOption`](#audit-trail-retention-ab-388) (default `'forever'`), `checkpoints` is [`CheckpointRetentionOption`](#checkpoint-retention-and-terminal-run-cleanup-cor-625) (default `'keep-all'`), `events` is `'forever' \| { olderThan }` (default 7 days; see [the durable event history](#the-durable-event-history-store-ab-91)), `tasks` is `'forever' \| { olderThan }` (default 30 days), and `receipts` is `{ olderThan }` only (default 24 hours; `'forever'` is refused; see [run-creation receipts](#run-creation-receipts-cor-424)). |
| `memory` | `GovernedMemory` | COR-41—attach governed recall and persistence hooks. Recall runs through the governed memory's mandatory recall admission and is injected as a labeled `<memory-evidence>` system message; final assistant content is admitted as untrusted `conversation` memory (scanned, quota-checked, quarantined when poisoned). Both run under the run's memory authority, and a recovered run whose request authority cannot be restored gets no memory hooks. `bureau.children` children, goal attempts, and workflow steps get none either. See [Governed memory](#governed-memory-cor-41). |
| `memoryAuthority` | `BureauMemoryAuthorityOptions` | COR-41—`runCapabilities` (default `['memory:search', 'memory:write']`) Bureau delegates to each run through the request principal; explicit `memory:*` capabilities on a request can only narrow them. `purpose` defaults to `'conversation-memory'`. See `createRunMemoryAuthority` and [Governed memory](#governed-memory-cor-41). |
| `identity` | `IdentityConfiguration` | Configure identity resolution for memory and session ownership. |
| `observability` | `boolean \| Omit<ObservabilityOptions, 'eventTarget'>` | Opt into OpenTelemetry spans/metrics for durable runs. No-op without `@opentelemetry/api` installed. |
| `onLog` | `(record: WorkflowLogRecord) => void` | Sink for `ctx.log` records emitted by durable workflows. |
| `onDiagnostic` | `(diagnostic: BureauDiagnostic) => void` | Sink for bureau's own operational diagnostics—recovery failures, live-frame listener exceptions, dispose errors, persistence failures. Omit to log to the console exactly as before. |
| `onEvent` | `(event: BureauEventMap[BureauEventType]) => void \| Promise<void>` | Listener on the Bureau's own event emitter, registered before recovery starts so it hears boot-time events (recovery decisions, `run.registered`, `action`) that `addEventListener` after `createBureau()` returns would miss. Receives every emitted event in dispatch order; a throwing or rejecting listener goes to `onDiagnostic`. |
| `durableGuardrails` | `DurableGuardrailsConfiguration` | History/checkpoint guardrails for durable runs: `history` (an agent run checkpoints its transcript per step, and `history.maxEvents` caps how long the event log may grow before the run is force-terminated), checkpoint size warnings, and `payloadSize`. |
| `durableOwnership` | `Pick<CreateRunEngineOptions, 'ownership' \| 'workflowClaimTtlMs' \| 'workflowClaimRenewIntervalMs'>` | Multi-process ownership posture (AB-178). Omit for the default `'workflow-lease'`, which lets several bureau processes share a store. Pass `{ ownership: 'none' }` to opt out (one bureau process per store). |
| `sessionInput` | `{ sessionBacklogLimit?: number; principalBacklogLimit?: number }` | AB-42/AB-194—per-session/per-principal backlog caps for `bureau.contexts.input`. Each is validated as a positive integer at construction time (`BureauError('...', 'BAD_REQUEST')` otherwise); `DEFAULT_SESSION_INPUT_BACKLOG_LIMIT` (32) and `DEFAULT_PRINCIPAL_SESSION_INPUT_BACKLOG_LIMIT` (128) are the values the mailbox-backed admission path applies for an omitted field, which returns `backlog-exhausted` once a cap is reached. |
| `agentSource` | `AgentSource` | COR-1702—where agent definitions are loaded from, watched in, and written back to. Pass `agentFileDirectory(path, { tools })` from `@lostgradient/bureau/sources` for a directory of Markdown agent files (COR-1524); `tools` is the deployment's tool catalog, the tools a file may name. Requires `models.generate`. See [`documentation/agent-files.md`](documentation/agent-files.md). |
| `workflowSource` | `WorkflowSource` | COR-1702—where workflow definitions are loaded from, watched in, and written back to. Pass `workflowFileDirectory(path)` from `@lostgradient/bureau/sources` for a directory of JSON workflow files (COR-1527). Needs a durable engine. See [`documentation/workflow-files.md`](documentation/workflow-files.md). |
| `models` | `{ catalog?: readonly BackendDescriptor[]; generate?: (row: BackendDescriptor) => GenerateFunction }` | The model rows the deployment offers and how a row becomes a `generate`, exposed as `bureau.models`. `catalog` defaults to `@lostgradient/operative`'s static `createModelCatalog()` rows; rows a host supplies are stamped `source: 'operator-override'`. `generate` is required with `agentSource`: it turns the catalog row an agent file's `model` resolved to into the `generate` the file runs with, because the host holds the credentials. See [`create-models.ts`](./src/models/create-models.ts). |
| `modelPolicy` | `{ deployment?; bureau?; users?: Record<string, UserModelConfiguration>; policyRevision: number }` | AB-64/AB-250—deployment/Bureau model-policy invariants and the per-principal user configuration `bureau.models.plan`/a run's `SelectionGate` compose against, held in memory for the bureau's lifetime. Named policy profiles are keys of `users` and of each configuration's own `fallbackOrder`; there is no storage schema. `StartTaskOptions` gains no field for any of this. See [`model-policy.ts`](./src/model-policy.ts). |

### Per-agent guardrails and skills (COR-1367)

`createAgent` accepts `guardrails` and `skills`. Guardrails a run applies resolve from the agent itself:

| Agent `guardrails` | The run applies                             |
| ------------------ | ------------------------------------------- |
| omitted            | the AB-40 preset, once, in the agent's tier |
| a configuration    | the agent's configuration only              |
| `false`            | no guardrails                               |

Bureau hands an agent that carries `OPERATIVE_RESOLVES_GUARDRAILS` (every `createAgent` result) nothing to inherit, and then registers no guardrail invariant of its own for that run, so the policy runs exactly once and a recovered run resumes under the same composition its fresh dispatch used. A hand-written `RunnableAgent`, or a `createLazyAgent` wrapper, keeps Bureau's own guardrail invariant (the AB-40 preset) and is handed `false`, so a `createAgent` behind a lazy wrapper does not add the preset a second time.

A catalog agent offers exactly the catalog its own `skills: createAgentSkills({ catalog })` names, scanned by its own guardrails.

`createAgentSkills({ catalog, includeTools?, loadArtifact?, events? })` is exported by this package. It implements operative's `AgentSkills` seam over Bureau's skills subsystem, which [documentation/skills.md](./documentation/skills.md) describes and the `@lostgradient/bureau/skills` subpath exports. The composition lives here because operative cannot import a private Bureau module, and the skills subsystem must not import operative. Each run gets a fresh skill client bound to the catalog, so activations never leak between runs. A task of the agent or a schedule fire also keeps its active skills across a crash: Bureau snapshots the client's activation records into the session after each step, and a recovered run re-validates them against the live catalog before its first step, so a skill whose source was revoked or whose content drifted does not come back. A child run dispatched through `bureau.children` has no Bureau session to hold them, so a recovered one starts with an empty active set.

```typescript
import { createAgentSkills } from '@lostgradient/bureau';
import { createAgent, type GenerateFunction } from '@lostgradient/operative';
import { discoverSkills } from '@lostgradient/bureau/skills';

declare const generate: GenerateFunction;

const catalog = await discoverSkills({
  sources: [{ id: 'user', kind: 'user', location: './skills', precedence: 20 }],
});
const agent = createAgent({ generate, skills: createAgentSkills({ catalog }) });
```

Removing the two deprecated fields later is therefore not a behavior change for an agent that says nothing: with no bureau value to inherit, it still resolves to the AB-40 preset.

A bounded retry persists terminal session state, waiting ten milliseconds between attempts on `runtime.timers`; under a `ManualRuntimeServices`, the test advances the clock to let a retry proceed.

`onLog` and `onDiagnostic` cover different sources: `onLog` carries only `ctx.log` records emitted _by durable workflow code itself_, while `onDiagnostic` carries bureau's own operational diagnostics—the sites that write to `console.error`/`console.warn` today (recovery failures, live-frame listener exceptions, dispose errors, persistence failures). Route `onDiagnostic` into a structured logger to capture those without monkeypatching `console`:

```ts
import { createBureau } from '@lostgradient/bureau';

// The members of a pino logger (`import pino from 'pino'; const logger = pino();`) this example uses.
interface Logger {
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

declare const logger: Logger;

const bureau = await createBureau({
  agents: {},
  onDiagnostic: ({ level, scope, message, cause }) => logger[level]({ scope, cause }, message),
});
```

### The `Bureau` Object

The most commonly used members:

| Member | Returns | Purpose |
| --- | --- | --- |
| `agents` | `BureauAgentCatalog<D>` | The typed, read-only agent catalog. See [`AgentDefinitions` and the Agent Catalog](#agentdefinitions-and-the-agent-catalog). |
| `tasks` | `BureauTasks<D>` | Starts a task and reads, waits on, watches, and cancels it: `start(agentName, input, options?)`, `detail(id)`, `get(id)`, `list(query)`, `cancel(id, options?)`, `receipt(query)`, `workflow(id)`, `workflows(filter?, options?)`, `wait(id)`, `snapshot(id, observer, options?)`, `events(id, options?)`, `subscribeEvents(id, listener, options?)`, and `inspect(id)`. The `bureau.tasks.*` operations of `createBureauHandler` delegate to these members. See [Tasks](#tasks-bureautasks). |
| `models` | `Models` | The model namespace, present regardless of `D`: `catalog()` returns the frozen `ModelCatalog` (the same object until `replace(rows)` commits; `revision` is 1 at boot and Bureau increments it on every `replace`, `stale` is always `false`, `generatedAt` is the runtime clock's time at the commit), `replace(rows)` swaps every row and validates agent files again, `generate(row)` is the host's `models.generate` (`NOT_CONFIGURED` when none was supplied), and `plan(request)` builds a `SelectionPlan`. |
| `memory` | `GovernedMemory \| undefined` | COR-41—the governed memory passed as `BureauOptions.memory`, for host-side reads, legal holds, and deletions under the host's own authority. The maintenance pass runs the retention sweep and deletion propagation itself. See [Governed memory](#governed-memory-cor-41). |
| `children` | `BureauChildren` | COR-772—dispatch a catalog agent as the child of a run this bureau knows, then `list`/`get`/`wait`/`signal`/`cancel` it by its stable identifier, including after a restart. See [Parent-child topology](#parent-child-topology-cor-772). |
| `goals` | `BureauGoals` | COR-851—create a durable goal, then `get`/`list`/`active`/`cancel`/`close` it and `recover` every unfinished one after a restart. Needs a durable engine. See [Durable goals](#durable-goals-cor-851). |
| `getOwner(resource)` | `Promise<string \| undefined>` | COR-718: the owner of record of a `run`, `session`, `goal`, `schedule`, `review`, or `audit` entry, or `undefined` when none exists. `anonymous:local` for a resource created with no principal. See [Owner of record](#owner-of-record-cor-718). |
| `waitForRecovery()` | `Promise<BureauRecoveryReport>` | AB-349—waits for boot durable recovery to finish and resolves a typed report: `outcome: 'clean' \| 'partial' \| 'failed'`, plus `sweepFailure`/`batchFailure` (each `{ message }`) and `perRunFailures` (`{ runId, reason }[]`, one entry per handle whose verdict was `'cancel'`, and one per durable goal the boot sweep reported `unrecoverable`, keyed by its goal id), and `skippedRuns` (`{ runId, type }[]`, COR-1583—one entry per stored run whose workflow type is not registered, which Bureau leaves untouched in storage so it never holds back the recovery of any other run, and which a later boot that registers the type recovers; each is also diagnosed once as a `scope: 'recovery'` `warn`). `outcome` is `'failed'` when `batchFailure` is set (`durable.engine.recoverAll()` itself threw—no handle was classified at all); otherwise `'partial'` when `sweepFailure` is set or `perRunFailures` or `skippedRuns` is non-empty; otherwise `'clean'`. `'skip'`/`'reattach'`/`'monitor'`/`'reattach-version-mismatch'` verdicts never change `outcome`. Recovery failure stays diagnostic either way—`createBureau()` never rejects on it, in whole or in part; this is the typed alternative to parsing `onDiagnostic`'s `scope: 'recovery'` log lines. **Boot returns once recovery has STARTED, not completed**, and what `await waitForRecovery()` buys a caller differs by path: when recovery is not deferred (the common case: `requestAuthorityValidator` is set in `BureauOptions`, or no persisted session has an in-flight run under transport-issued authority), `createBureau()` itself already awaits this same barrier before resolving, so by the time a caller has a `bureau` to call `waitForRecovery()` on, recovery classification is already done and a recovered run may already be advancing—calling it here only reports that already-settled fact, and a caller with post-boot dependency wiring a recovered run needs must finish that wiring BEFORE calling `createBureau()` instead, there is no after-the-fact seam on this path; when recovery is deferred (a host calls `createBureau()` without `requestAuthorityValidator` and later calls `bureau.setRequestAuthorityValidator()`, and durable execution finds a persisted session whose in-flight run carries transport-issued authority—an `authorizationRevision` other than Bureau's own—or cannot read the sessions to check), `createBureau()` resolves without starting recovery, and recovery does not start at all until `setRequestAuthorityValidator()` is called with a validator, so wiring dependencies before or immediately after that call and then awaiting `waitForRecovery()` genuinely gates on recovery's classification/reattachment pass completing. |
| `contexts` | `BureauContexts` | The contexts (sessions) of the Bureau: `list(options?)`, `get(id)`, `delete(id, options?)`, `signal(id, name, payload?)`, `input(id, request)`, `inputsDeliveredBy(taskId, contextId)`, `steer(id, request)`, `steering(id)`, `fork(id, request)`, and the context's event history (`events`, `subscribeEvents`). The `bureau.contexts.*` operations of `createBureauHandler` delegate to these members. See [Contexts](#contexts-bureaucontexts). |
| `schedules` | `BureauSchedules` | Durable recurring schedules, backed by the Weft engine: `create(definition)`, `get(id)`, `list(filter?)`, `pause(id)`, `resume(id)`, `cancel(id)`, `update(id, update)`, `agentName(id)`, `inputPreview(id)`, and the definition's durable event history, `events(id, options?)` and `subscribeEvents(id, listener, options?)`. See [Schedules](#schedules-bureauschedules). `schedules.create` dispatches `AgentScheduledEvent` (`schedule.created`) on this Bureau's event surface exactly once per successful registration. `schedules.pause`, `schedules.resume`, and `schedules.cancel` dispatch their matching schedule lifecycle events once per transition they make. Pausing a schedule that is not active, or resuming one that is active, succeeds without changing the schedule, so it records and dispatches nothing; every cancel is recorded. Each transition commits a pending record in the same write as the schedule's new state, and Bureau records it in durable event history and the audit trail before dispatching the event. A record left pending by a crash or a failed write is recorded at the next boot or durable maintenance pass, once (COR-194). `schedule.deleted` is reserved and unreachable because the public surface cancels schedules rather than deleting them. Separately from that definition lifecycle, every scheduled occurrence dispatches `schedule.attempted` before the overlap policy decides what to do with it, and an occurrence the policy drops (`overlap: 'skip'` colliding with a still-running fire) dispatches `schedule.skipped` carrying the occurrence, the blocking `runId`, and the policy. Both are sourced from the Weft engine's own `schedule:attempted`/`schedule:skipped` signals. They are what distinguishes a schedule that is ticking and choosing not to run from one that has stopped ticking — `schedule.completed`/`schedule.failed` only ever describe occurrences that actually launched a run. |
| `subscribeLiveFrames(listener)` | `() => void` | Subscribe to every `ServerFrame` the bureau emits; returns an unsubscribe function. The first subscriber is also replayed (in a microtask, after the call returns its unsubscribe handle) the frames emitted during boot recovery and by the runs it recovered (at most the newest 1024, in emission order), so recovered runs that emitted while `createBureau()` was still awaiting are not lost; later subscribers see only new frames. |
| `addEventListener` / `on` / `once` / `subscribe` / `toObservable` / `events` | — | The typed `BureauEventMap` surface for actions, run registration and removal, disposal, schedule lifecycle, recovery decisions, and non-pending review transitions. Schedule terminal events carry the fired `runId`; recovery events carry the classification verdict or rejection reason; review events carry identifiers and status metadata but never approval arguments, signal payloads, or decision reasons. |
| `audit` | `BureauAudit` | The audit trail read as redacted metadata: `query(filter?, options?)` returns `{ records, nextCursor }`, the same records `bureau.audit.query` serves over the handler. The raw trail is `bureau.internals.auditTrail`. See [The Audit Trail](#the-audit-trail). |
| `reviews` | `BureauReviews` | The reviews awaiting a human decision: `list()`, `get(id)`, `resolve(input)`, `pendingOf(taskId)`. See [Reviews](#reviews-bureaureviews). |
| `shutdown(options?)` | `Promise<BureauShutdownReport>` | AB-207—the awaited drain. `{ policy: 'abort' }` (the default) aborts every active run immediately, then awaits every Bureau-owned subsystem's teardown (online-evals, webhook notifier, audit trail, durable engine); `{ policy: 'drain' }` lets every task reach its own natural terminal result while Bureau-owned background work is stopped identically to `'abort'`. `timeoutMilliseconds` bounds the WAIT only—on elapse, `shutdown()` resolves (never rejects) reporting every still-outstanding owner `'unresolved'`; the underlying drain is not abandoned, only the wait for it. |
| `dispose()` | `Promise<void>` | Thin wrapper over `shutdown({ policy: 'abort' })`, kept for its existing `Promise<void>` shape. Tears down subscriptions and closes owned storage handles—genuinely awaited now (AB-207), not fire-and-forget. |

### Tasks (`bureau.tasks`)

A task is one run of a catalog agent inside a context (a session). `bureau.tasks.start(agentName, input, options?)` loads the context `options.contextId` names, or creates one when it is omitted, appends `input` to the context's conversation, and resolves with a `TaskHandle` once the run exists. `input` is a string, an ordered list of user text and media parts, `{ conversation }` (seeds a new context), `{ append }` (conversation rows with their own ids, as an A2A continuation sends them), or `{ continue: true }` (answers the conversation as it stands, as an AG-UI resume does). A start for a name in the typed catalog resolves to a `TaskHandle` typed by that agent's output, and a start for a name known only at run time (such as a file agent) resolves to an untyped one. The agent's own definition decides its system prompt, step and token caps, tools, and stop conditions; a start has no per-request override of any of them. A start that refuses does so before anything is persisted: an unknown agent is `NOT_FOUND`, an agent with no definition resolver is `UNSUPPORTED_CAPABILITY`, and malformed input or options are `BAD_REQUEST`.

```ts
import type { Bureau } from '@lostgradient/bureau';

declare const bureau: Bureau;

const task = await bureau.tasks.start('researcher', 'Summarize the Q3 report.', {
  principal: 'api-key:alice',
  commandId: 'summarize-q3',
});

for await (const event of task) {
  console.log(event.type);
}

const result = await task.result();
console.log(result.finishReason, task.contextId);

const detail = bureau.tasks.detail(task.id);
console.log(detail?.status);

const receipt = await bureau.tasks.cancel(task.id, { waitMilliseconds: 1_000 });
console.log(receipt.receipt); // 'rejected': the task had already finished
```

The handle iterates the task's run events (once), `result()` settles with the run's result, `abort(reason?)` requests cancellation (and does nothing once the task has settled), and `snapshot()` reads its liveness. The task's id is the id of its durable workflow, and `contextId` names the context the task runs in. A task started without a `contextId` creates a context, which `bureau.contexts.list()` then lists.

`options.commandId` is the caller's idempotency key. It needs a `principal` (`BAD_REQUEST` otherwise) and a durable engine (`NOT_CONFIGURED` otherwise), and it goes through the durable command ledger described under [Run-creation receipts](#run-creation-receipts-cor-424): an exact retry returns the original task, and the same key with a different agent, input, context, or request context is refused with `BureauLedgerConflictError`. A handle a retry replays for a task this process does not run iterates nothing (a task this process runs iterates its live tail), and its `result()` settles from `bureau.tasks.wait`, the durable workflow's recorded result. `bureau.tasks.receipt({ commandId, principal, agentName? , contextId? })` reports where a key stands: `recorded`, `pending`, `expired`, or `not-found`.

The remaining members read a task: `detail(id)` is the run this process holds, with its steps, events, transcript, and liveness; `get(id)` and `list(query)` read the task registry (the records `bureau.tasks.get` and `list` serve); `workflow(id)` and `workflows(filter?, options?)` are the durable engine's view; `wait(id)` resolves once the durable workflow is terminal; `snapshot(id, observer)` delivers the task's liveness on every change; `events(id)` and `subscribeEvents(id, listener)` read its durable event history; and `inspect(id)` reads its record, liveness, and children for the run inspector. `cancel(id, { waitMilliseconds? })` cancels a task whether this process holds it or only the durable store does, and reports where its cleanup stands. None of these authorizes the caller beyond the principal a start or a receipt names; `createBureauHandler` authorizes before it calls them.

### Reviews (`bureau.reviews`)

A tool call that needs approval and a `requestHumanInput` park are both reviews. `bureau.reviews` lists the ones awaiting a decision, reads one by id (live or already resolved), and resolves one: `approve` resumes the run, `deny` records the decision and continues it, and `reject` is a denial that requires a `reason`. `pendingOf(taskId)` reads the human waits a task is still parked on from durable state, so a process that shares the durable store with the one holding the task can list and resolve its park. The `bureau.reviews.list`, `bureau.reviews.get`, and `bureau.reviews.resolve` operations of `createBureauHandler` delegate to these members.

```ts
import type { Bureau } from '@lostgradient/bureau';

declare const bureau: Bureau;

for (const waiting of bureau.reviews.list()) {
  const review = await bureau.reviews.get(waiting.id);
  if (review?.status !== 'pending') continue;
  await bureau.reviews.resolve({
    id: waiting.id,
    decision: 'approve',
    principal: 'api-key:alice',
  });
}

const parks = await bureau.reviews.pendingOf('task-1');
console.log(parks.map((park) => park.id));
```

### Contexts (`bureau.contexts`)

A context is the durable conversation a task runs in (a session). `bureau.contexts` reads and deletes them, delivers a signal to a parked run, admits input and steering, branches one after a completed reply, and reads the durable history a context records. None of these members authorizes the caller; the handler's `bureau.contexts.*` operations check the owner of record first, and an in-process caller answers to `bureau.getOwner` itself. `events` and `subscribeEvents` read the `session` owner of the durable event history; the run owner's history stays on `bureau.tasks.events` and `bureau.tasks.subscribeEvents`.

```ts
import type { Bureau } from '@lostgradient/bureau';

declare const bureau: Bureau;

const [summary] = await bureau.contexts.list({ limit: 1 });
if (summary !== undefined) {
  const context = await bureau.contexts.get(summary.id);
  console.log(context?.metadata);
  console.log(await bureau.contexts.steering(summary.id));

  const outcome = await bureau.contexts.input(summary.id, {
    id: 'input-1',
    principal: 'api-key:alice',
    deliveryMode: 'steer',
    payload: 'Keep it short.',
  });
  console.log(outcome.outcome);

  const history = await bureau.contexts.events(summary.id);
  if ('events' in history) console.log(history.events.map((event) => event.kind));

  const subscription = bureau.contexts.subscribeEvents(summary.id, (event) => {
    console.log(event.kind);
  });
  subscription.unsubscribe();
}
```

- **`list(options?)`, `get(id)`, `delete(id, options?)`**: Session CRUD through the configured `SessionStore`. `delete` fences the session (a new run on it, and input to it, read as a session that does not exist), cancels every live run in it, and resolves the report of those tasks, each with its run's cleanup acknowledgement.
- **`signal(id, name, payload?)`**: Fire-and-forget signal to a session's in-flight durable run.
- **`input(id, request)`**: AB-42/AB-194—admits session input. An unauthorized caller or unknown session returns `{ outcome: 'not-found' }`; an authorized caller on an already-terminal session returns `{ outcome: 'session-terminal', sessionId }`. Both checks are run-correlated (COR-301): they consult this process's live runs on the session, so a session with any live run is not terminal even when a concurrent run's terminal write was the last to set `lastRunStatus`, and authorization targets the session's sole live run, keeping the `lastRunId` fallback when several runs are live. An authorized request on a session that is not terminal reaches the durable session mailbox (`admitted`, `replayed`, `conflict`, or `backlog-exhausted`). Each `admitted` input ends with exactly one terminal receipt, and Bureau never starts a run to answer input (COR-1476). It reads `promoted` once a live run's step boundary appends its user turn to the conversation: before the run's next step generates, or once more after its last step generated while the run has a step left, so input sent during the final step is answered by one more step of the same run. The turn is appended at most once, in admission order within a run, keyed by the mailbox command (so an `id` reused after the mailbox retired its record is a new input), under the input's own `id` as its message id (a fresh id only when the conversation already holds a message with that id), and its promotion commits in the same atomic write as the transcript that holds the turn, whatever that step's outcome, so a transcript and its promotions never disagree. It reads `canceled`, with reason `the run ended before the input was delivered`, when the turn was not appended before its run ended, where a run ends by completing, failing, `bureau.tasks.cancel`, or being promoted but never started. The ending run first writes its steering `run-ended` entry (the not-live write every process honours over the engine's status, retried until it is acknowledged or the Bureau closes), then catches up steering and reads the session's liveness without itself; with another run of the session live or starting it only releases what it held, and that run's end does the cancelling; otherwise it cancels every open input whose turn is not in its checkpoint transcript, in admission order. `input` mirrors that order: it writes the session's open-input marker, commits the admission, catches up steering, and reads liveness, and with no run live or starting it cancels its own input and returns the re-read receipt (`receipt.state === 'canceled'`); a liveness read that fails is answered the same way. A client therefore learns of a cancellation from the input's absence in the run's terminal history and resends it. The boot sweep and the periodic sweep cancel a session's open input only when no run of it is live or starting; input under an orphaned `running` workflow of a dead process stays open until that workflow is recovered, when its run delivers it, or marked terminal. Shutdown releases open input instead of cancelling it, for the next boot's recovered run to deliver or its sweep to cancel. Delivery is idempotent per mailbox command: a replayed step or a recovered run never appends the same turn twice, and a lease a crashed process held delays delivery by up to about 31 seconds (the mailbox's 30 second visibility timeout plus its short retry backoff). Input for a run parked on a human reviewer or a wakeup is delivered when the run resumes. An input still undelivered after seven days reads `expired`, one whose session is deleted reads `canceled`, and one that cannot be decoded reads `failed`. A request's `expiresAt` and `supersedes` are stored but not yet honored. `{ outcome: 'unsupported-capability', reason: 'durable-mailbox-unavailable' }` is returned only when no session mailbox, durable storage, or key-value store is composed, or the session id is too long to address a mailbox.
- **`steering(id)`**: COR-1559—the session's latest admitted `model` override (`{ provider, model }`, `provider` `null` when it named none, the whole `model` `null` before any) and its `configVersion`, the version a command's `expectedRevision` is compared against. A durable Bureau folds the session's steering log first. It does not authorize the caller.
- **`fork(id, request)`**: COR-1560—branches a session after a completed agent reply: `{ owner, commandId, throughMessageId }` answers `{ contextId, carriedOverride }`. `throughMessageId` must be the final assistant message of a run of the session whose task record the registry holds and which ended `completed`, with no tool approval pending and no tool call left without a result; otherwise it throws a `SessionForkRefusedError` whose `reason` is `message-not-found`, `not-a-branch-point`, `branch-from-errored-run`, `branch-from-aborted-run`, `branch-with-pending-approval` or `branch-with-unresolved-tool-call`, and nothing is created. The new session shares the history through that message, belongs to `owner`, and records `parentContextId` and `forkedFromMessageId`. The parent's `model` override is admitted on it as `<commandId>:model`. `commandId` is kept in the durable command ledger: an exact retry returns the original result, even after a restart, and a crash between the steps never forks twice; the same `commandId` for another message is a `command-conflict`. The identity is `owner`, the session and `commandId`, and a settled command is kept for 24 hours, after which an exact retry forks again. It does not authorize the caller.
- **`steer(id, request)`**: AB-67/AB-199/AB-200—admits `pause`, `resume`, `agent-identity`, `route`, `model`, `provider`, and `effort` for authorized, non-terminal in-memory and durable sessions. Durable sessions keep every admission and run-boundary transition in an append-only steering log that each Bureau process folds before deciding, so desired state, command states, `configVersion`, and `(principal, id)` idempotency survive any number of restarts and are shared by every process on the backend. `pause`/`resume` bind to one run; `agent-identity` is deferred to the next run; the other configuration coordinates apply at the next step boundary. Same `not-found`/`session-terminal` pre-admission checks as `input`. Configuration `policyRef` values resolve through `modelPolicy.users`; missing profiles or coordinates are rejected with `policy-denied`. Only an `agent-identity` `policyRef` returns `{ outcome: 'unsupported-capability', reason: 'selector-unavailable' }`. Unknown catalog coordinates are rejected with `policy-denied`. A `model` override may name its `provider` beside the model (`{ target: 'model', override, provider }`); with a provider, admission and step selection match the pair, and without one (every record written before the field existed) the model name alone. COR-1559: a `model` is also held to what the session's agent allows, decided at admission: a selectable agent (every file agent, and a code-defined agent with `allowedCandidates`) and a fixed agent are held to their models, and a model outside them is rejected with `model-not-allowed` and logged like any refusal, so a retry is answered the same; a routed or opaque agent lists no models (`bureau.agents.models` answers `selectable: false` and an empty list), so every `model` override for it is rejected with `model-not-allowed`. The check holds a model a caller names; a model chosen by a policy profile (`policyRef`) or by an agent's own routing is out of its scope. A `model` override is admitted on an idle session too (`pause`, `resume` and the other targets keep `session-terminal`), and a stale `expectedRevision` is `rejected` with `stale-revision`. An exact `(principal, id)` retry replays; a mismatched retry returns a typed `conflict`; an accepted command can transition to `failed` when its boundary is lost to terminal completion.
- **`inputsDeliveredBy(taskId, contextId)`**: the identifiers of the conversation rows the task itself took context input into, in delivery order, from the durable delivery record (which commits with the transcript the run saved). Empty for a run that delivered none, and for a Bureau with no session mailbox.

### Schedules (`bureau.schedules`)

A durable Bureau registers recurring schedules with the Weft engine. `bureau.schedules` creates, reads, and changes them, and reads the durable history their definitions record: `schedule.created` when one is registered, and `schedule.paused`, `schedule.resumed`, and `schedule.cancelled` for each transition. Every operation resolves `undefined` on a Bureau with no durable engine, and `events` answers `{ outcome: 'unsupported-capability' }` on one with no persistent storage.

```ts
import type { Bureau } from '@lostgradient/bureau';

declare const bureau: Bureau;

const schedule = await bureau.schedules.create({
  agentName: 'default',
  input: 'Summarize overnight activity',
  spec: '0 9 * * *',
});
if (schedule !== undefined) {
  await bureau.schedules.pause(schedule.id, { expectedRevision: schedule.revision });
  console.log(await bureau.schedules.agentName(schedule.id));

  const history = await bureau.schedules.events(schedule.id);
  if ('events' in history) console.log(history.events.map((event) => event.kind));

  const subscription = bureau.schedules.subscribeEvents(schedule.id, (event) => {
    console.log(event.kind);
  });
  subscription.unsubscribe();
}
```

`bureau.internals` is the seam `createBureauHandler` and the test harness read (the stores, the event feeds, the task registry); it is not part of the surface an application builds on.

`bureau.dispose()` (and `bureau.shutdown()`) is safe to call more than once—the second call returns the same, already-settled promise rather than re-running teardown.

**The manual-runtime rule (AB-338):** `shutdown()`'s bounded `timeoutMilliseconds` wait always sleeps on this bureau's own resolved `RuntimeServices.timers` (AB-260's deterministic contract), never a real timer directly. Under a real-globals runtime that is invisible—the wait just elapses. Under a `ManualRuntimeServices`, nothing advances that wait's timer on its own, so the CALLER owns advancing the clock (`runtime.advance(timeoutMilliseconds)`) far enough for a bounded `shutdown()` call to resolve, exactly as it owns advancing the clock for any other timer-driven behavior in that bureau. The one built-in exception is `bureau/test`'s `BureauTestHarness.close(shutdownOptions)` (below), which owns that advance itself.

### `streamEventToFrame`

```typescript
import { streamEventToFrame, type StreamFrame } from '@lostgradient/bureau';
import type { StreamEvent } from '@lostgradient/operative';

const toFrame: (runId: string, event: StreamEvent) => StreamFrame | undefined = streamEventToFrame;
```

Converts an `operative` `StreamEvent` (`stream:text-delta`, `stream:tool-call-start`, `stream:tool-call-delta`, `stream:tool-call-complete`, `stream:complete`, `stream:error`) into the matching typed `StreamFrame` (the stream members of `ServerFrame`, before Bureau stamps `runSeq`), stamped with the owning `runId`. Returns `undefined` for event types with no frame equivalent. Bureau uses this internally to translate a run's `streaming` output into the frames delivered by `subscribeLiveFrames`; an application-owned WebSocket or server-sent events transport can use it the same way.

### The Audit Trail

`bureau.audit.query(filter?, options?)` reads the audit trail as metadata and is what the handler's `bureau.audit.query` operation delegates to, so an in-process caller and a wire caller read identical records for the same filter. Each record is `sequence`, `timestamp`, `type`, `resource` (the run, `schedule:<id>`, `session:<id>`, `agent:<id>`, or `workflow:<id>`), `principal` (the actor), and a few scalar `detail` fields from an allowlist; no secret, transcript, tool argument, tool result, review prompt, or memory content leaves the Bureau. `filter` narrows by `runId`, `type`, and `since` (epoch milliseconds) and pages with `limit` (1 to 100, default 50) and `cursor`; `nextCursor` is `null` on the last page. An in-process caller is the host and reads every record. Pass `options.owner` (an owner string such as `api-key:alice`) to read as that owner: only records about resources it owns come back, and a page is filled from those, so a cursor advances across records the owner may not see. The handler does exactly that for a caller without `bureau.audit:read`, and passes no owner for one with it. A Bureau without `storage` keeps no trail: `query` rejects with `BureauError` (`UNSUPPORTED_CAPABILITY`), and a `limit` or `cursor` it did not issue rejects with `BAD_REQUEST`.

```typescript
import type { Bureau } from '@lostgradient/bureau';

declare const bureau: Bureau;

const first = await bureau.audit.query({ type: 'run.completed', limit: 20 });
const next =
  first.nextCursor === null
    ? undefined
    : await bureau.audit.query({ type: 'run.completed', limit: 20, cursor: first.nextCursor });
const alices = await bureau.audit.query({}, { owner: 'api-key:alice' });
console.log(first.records.length, next?.records.length, alices.records.length);
```

The raw, unredacted trail is `bureau.internals.auditTrail`:

```typescript
import { createAuditTrail, type Bureau } from '@lostgradient/bureau';
import type { ConditionalTextValueStore } from '@lostgradient/weft';

declare const bureau: Bureau;
declare const kv: ConditionalTextValueStore;
declare const runId: string;

const trail = createAuditTrail(bureau, kv);
const records = await trail.query({ runId, since: Date.now() - 3_600_000, limit: 100 });
await trail.dispose();
```

`createBureau()` builds an audit trail automatically whenever persistence is configured—it's exposed as `bureau.internals.auditTrail`. It listens to the bureau's `action` events and, for a fixed set of event types (`tool.started`, `tool.settled`, `tool.error`, `run.completed`, `run.error`, `run.aborted`, `run.tripwire`, `step.completed`, plus, as of AB-228, `budget.exceeded` (the bare `BudgetExceededEvent` class has no production emitter—AB-231, merged, reclassifies to `run.completed`'s `finishReason` instead), and the toolbox-forwarded `toolbox.loop-warning`/`toolbox.loop-blocked`/`toolbox.budget-exceeded` (the toolbox's OWN real budget rejection, a distinct production path the bare `budget.exceeded` entry does not cover—Codex review finding, PR #566)—see `AUDIT_EVENT_TYPES`), writes an append-only `AuditRecord` into the key-value store under an `audit:v1:` prefix, key-encoded so natural sort order is chronological. AB-228 also added dedicated listeners for the schedule-DEFINITION lifecycle (`schedule.created`/`paused`/`resumed`/`cancelled`) and for `session.deleted`, none of which traverse `'action'` at all (same reason `durable-event-history.ts`'s own producer needs its own listeners for the schedule family)—`bureau.contexts.delete` dispatches `SessionDeletedEvent` on the bureau emitter (there was previously no production emission point at all, despite `session.deleted` sitting in `SESSION_DURABLE_ACTION_TYPES`—Codex review finding, PR #566), replayed from the session commit outbox by `drainOutbox` rather than dispatched directly from `bureau.contexts.delete` itself as of AB-389 (see "Session commit outbox" below), and this trail records it under a synthetic `session:<sessionId>` owner, the same convention `schedule:<scheduleId>` uses, since neither a schedule definition nor a session deletion has a run of its own to attribute to. The seven `review.*` `ReviewStatus` outcomes are NOT in `AUDIT_EVENT_TYPES` at all: they already reach this trail through `AuditTrail.record()`'s out-of-band path (`create-bureau.ts`'s `recordReviewDecision`/`recordReviewStatusTransition`, kind-namespaced as `review.<kind>.<status>`), which bypasses the allowlist entirely—see `AUDIT_EVENT_TYPES`'s own doc comment for the full accounting.

This is a second, durable layer alongside the in-memory `@lostgradient/operative` ring buffer (which is bounded by `maxActions` and lost on restart): the operative store is the live/glass-box view, the audit trail is the durable/queryable one. `trail.query(options)` filters by `since`, `runId`, and `type`, returning up to `limit` records (default 500) oldest-first. Without a `kv` store, the trail still subscribes (so `dispose()` is always safe) but writes nothing. Every write is fire-and-forget from its dispatching caller's perspective (`bureau.contexts.delete` returns once the synchronous event dispatch completes, not once the underlying `kv.set` commits; `pauseSchedule`/`resumeSchedule`/`cancelSchedule` await their own records before dispatching), so `query()` first awaits a snapshot of every write already in flight at call time (AB-228)—giving read-your-writes for a query immediately following a schedule transition or session deletion, even against a `TextValueStore` whose `set()` resolves asynchronously.

`encodeAuditEntryKey(timestampMs, sequence, runId)` (also exported from `bureau`) reconstructs the exact `audit:v1:...` key a queried `AuditRecord` was written under from its own public fields—used by `bureau/test`'s `selectAuditWriteFaultTarget` (AB-263) rather than a second, drifting reimplementation of the key encoding.

`trail.dispose()` returns `Promise<void>` (AB-207)—it resolves only after every write already in flight has settled, and accepts an owner-issued `AbortSignal` (threaded in by `bureau.shutdown()`) that tells the trail to stop _starting new writes_ once aborted; a write already in flight when the signal fires cannot be cancelled (there is no cancellation hook for the underlying `kv.set`), so `dispose()` still fully awaits it rather than racing the KV store's own close. `bureau.shutdown()`/`bureau.dispose()` await this the same way they await the webhook notifier and online-eval sampler's own async `dispose()`.

### `AuditRecord` schema versioning (AB-370)

`AuditRecord.sequence` is one monotonic counter shared by every write path this trail has—the action-stream listener above AND every out-of-band write (`record()`, the schedule-definition listeners, the `session.deleted` listener) all draw the next value from the same per-bureau counter, allocated at the moment a write is dispatched (before its `kv.set` even starts). `createBureau()` seeds that counter above the highest `sequence` already persisted under `audit:v1:` at boot (`computeInitialAuditSequence`, also exported from `bureau`), so a fresh process never re-issues a value a prior process lifetime already used. Readers order by `timestampMs` first and `sequence` second: `sequence` only breaks a genuine same-millisecond tie, so a query's order for two records that do not share a millisecond is unaffected by this field. Before AB-370, an action-stream record's `sequence` was a straight copy of the operative store's own per-process `Action.sequence`, and an out-of-band record's `sequence` was a second, deliberately huge and disjoint counter (`writeOutOfBandRecord`'s old `manualSequence`, seeded near `Number.MAX_SAFE_INTEGER`)—two numbering domains that could never be compared for true relative order, so a same-millisecond collision between (for example) `session.deleted` and a released run's own terminal action always resolved in the out-of-band record's favor regardless of which one genuinely happened first. That bias is gone: both paths now draw from the identical counter, so a same-millisecond tie sorts by true dispatch order.

`sequence` is optional on `AuditRecord`—a record written before this field existed at all carries none, and `query()`'s sort comparator maps that absence to `-1` (below every real `sequence`, which is always `>= 0`) so a same-millisecond tie against such a record still uses a genuinely transitive comparator, rather than the `0`-for-either-side special case an earlier round of this fix used (non-transitive, and not guaranteed to produce the claimed order by every sort algorithm).

`AuditRecord.actionSequence` is present only on records written from the action stream. It preserves the originating operative-store `Action.sequence`, which lets a host merge live and durable views without showing the same action twice. Out-of-band records such as `session.deleted`, `schedule.*`, and `review.*` have no live action counterpart, so they do not carry `actionSequence`.

### Audit trail retention (AB-388)

`BureauOptions.retention.audit` controls whether the durable audit trail is ever pruned. It defaults to `'forever'`—unbounded, exactly the behavior described above—so a long-lived deployment must opt in before any postmortem evidence is ever removed:

```typescript
import { createBureau } from '@lostgradient/bureau';

const bureau = await createBureau({
  agents: {},
  retention: { audit: { olderThan: 30 * 24 * 60 * 60 * 1000 } }, // 30 days
});
```

`options.retention.audit.olderThan` must be a finite, non-negative number—validated at `createBureau()` construction time (`BAD_REQUEST` otherwise), since `NaN` or a negative value feeding the cutoff arithmetic could otherwise prune far more than intended (Codex review, PR #597, "Reject non-finite and negative retention durations").

`retentionFloorTimestamp()`'s protection depends on a schedule/session dedicated event's durable-event `emittedAtMs` never diverging from that SAME event's own audit record `timestampMs`—`createAuditTrail` and `createDurableEventProducer` share one `emittedAtMs` resolver (`createEventTimestampResolver`, `event-timestamp.ts`), keyed by event-object identity, so whichever of the two subsystems' listeners for a `schedule.created`/`paused`/`resumed`/`cancelled` or `session.deleted` event runs first stamps a single clock reading that the other reuses, instead of each independently calling `runtime.clock.now()` and risking two different readings for the exact same event (Codex review, PR #597, "Reuse event timestamps for dedicated lifecycle listeners").

With `{ olderThan: milliseconds }` configured, a pruning pass deletes any audit record whose `timestampMs` is older than `olderThan` by the runtime clock—but never a record at or after the Weft fleet feed's own retention floor (`DurableEventHistory.retentionFloorTimestamp()`: the earliest `emittedAtMs` across every durable event the feed currently retains), even when `olderThan` alone would have allowed pruning it sooner. That clamp means audit evidence always outlives the durable events it describes: as long as the fleet feed still retains a run's own durable history, that run's audit records survive too, regardless of how old they are by the wall clock. Critically, this protection applies even while the floor is still `0`—nothing has ever been retired from the fleet feed yet is the normal, common state (`FleetEventFeed.retain()` is called by every durable maintenance pass under `retention.events`, 7 days by default, so the floor does advance; with `retention.events: 'forever'` it stays at `0`), not "nothing to protect" (Codex review, PR #597, "Preserve audit records while the fleet feed floor is zero"). The effective cutoff each pass uses is `min(now - olderThan, retentionFloorTimestamp)`, or just `now - olderThan` when the feed currently retains no events at all (an ephemeral bureau, a persistent backend with no durable event history, or one where every retained event has aged out). The global floor timestamp alone cannot express "protect this specific run's ENTIRE audit history" when that run's only currently-retained durable event is a single, later terminal transition (`run.completed`/etc.)—a pass also asks `DurableEventHistory.retainedRunOwnerIds()` for the full set of run ids the fleet feed still retains at least one event for, and never prunes a record whose `runId` names one of those runs, regardless of `timestampMs` (Codex review, PR #597, "Protect earlier audit records for retained owners"). Reading the floor and the retained-owner set both waits for any `DurableEventProducer` write already in flight for the SAME action first (`waitForAllActiveWrites()`), so an audit record that already committed can never have its protection computed from a snapshot that omits the still-in-flight durable event describing that same action (Codex review, PR #597, "Wait for durable event writes before reading the floor").

Retention also reaches a KV-backed bureau with no durable engine at all—a persistent storage backend configured with `durable: false`—not only one with `runtime.durable` composed (Codex review, PR #597, "Run audit retention for KV-backed non-durable bureaus"); such a bureau has no durable event history to consult, so its effective cutoff is always the unclamped `now - olderThan`. The automatic-profile background timer itself only starts for a KV-only bureau when `retention.audit` is actually active (not the default `'forever'`)—with no durable engine and no active retention policy, that bureau has nothing for the timer to do, so it is never started at all rather than ticking uselessly forever (Codex review, PR #597, "Start the KV-only timer only for active retention"); a durable bureau's timer still always starts regardless of `retention.audit`, since `pruneStaleRunOwnership` has its own, independent work to do.

Pruning is never driven on a schedule of its own—it runs inside the SAME durable maintenance pass `lastRunOwningPrincipals` pruning already uses (AB-363, described under "The Durable Event History Store" below): `bureau.runDurableMaintenance()` for a `maintenance: 'manual'` host's own alarm/Cron trigger, and, under the default `'automatic'` profile, the same background interval that already prunes stale run ownership every five minutes. The two sub-passes are independent—each runs under its own try/catch, on BOTH the manual and automatic paths, so a failure in one (diagnosed under its own message) never prevents the other from running that tick (Codex review, PR #597, "Isolate the manual audit-retention sub-pass"). A rejected `engine.runMaintenance()` call is isolated the same way: `runDurableMaintenance()` still runs both `pruneStaleRunOwnership()` and `pruneAuditTrail()` even when the engine's own maintenance rejects, re-throwing the captured engine failure only after both sub-passes have run, so a failed alarm no longer silently also skips audit retention (Codex review, PR #597, "Isolate audit pruning from engine maintenance failures"). Every manual `runDurableMaintenance()` call still in flight is tracked and awaited by `shutdown()` before backend teardown, alongside the automatic timer's own in-flight pass—a manual host's own alarm/Cron trigger racing `shutdown()` can no longer have its storage disposed mid-prune (Codex review, PR #597, "Await manual pruning before storage teardown").

A pass that actually prunes at least one record writes exactly one `audit.pruned` record back into the trail itself, `detail: { count, cutoffMs }`, naming how many records it removed and the effective cutoff it used; a pass that prunes nothing writes no record at all, so an idle retention policy never grows the trail it exists to bound. This summary write is strict (its failure rejects the pass, rather than the best-effort swallow every other out-of-band audit write uses) and bypasses `dispose()`'s "refuse new writes" abort check for a pass that was already admitted before `shutdown()` began (Codex review, PR #597, "Propagate failures to persist the prune summary" / "Finish the prune summary after shutdown begins")—permanently deleting records without the promised evidence, or losing that evidence to a mid-shutdown abort, would be worse than surfacing the failure. Each pass also persists the highest `sequence` it ever pruned—BEFORE deleting any record (Codex review, PR #597, "Persist the sequence watermark before deleting records"), so a crash partway through a pass never loses track of a sequence it already started removing—under a separate, non-`audit:v1:`-prefixed key, so it is invisible to `query()` and to the normal boot scan; `computeInitialAuditSequence` consults that persisted floor in addition to its usual scan, so a restart's shared sequence counter resumes correctly even when every one of the surviving records at boot postdates every pruned one (or nothing at all survived). Two overlapping `prune()` calls on the same `AuditTrail` instance (e.g. a manual host's own call landing mid-automatic-tick) are serialized through an internal queue rather than racing each other's reads and deletes (Codex review, PR #597, "Serialize concurrent audit-pruning passes"). A cross-process race between two Bureau instances sharing the same KV store is closed separately, via a CAS-guarded lease (`ConditionalTextValueStore.conditionalBatch`): only the instance whose lease-acquisition batch commits first actually lists, deletes, and updates the watermark for that tick, and every other instance skips the tick entirely rather than racing its own reads and deletes against the holder's—a lease older than its own TTL (a prior holder that crashed before releasing it) is taken over rather than blocking pruning forever (Codex review, PR #597, "Coordinate pruning across shared-store instances"). If `kv.delete()` rejects partway through a multi-record pass, the records deleted before the failure are still named in a partial `audit.pruned` summary (`detail.partial: true`) before the failure is re-thrown, so an already-committed deletion is never left with no corresponding evidence (Codex review, PR #597, "Record successful deletions when a later delete fails").

### Checkpoint retention and terminal-run cleanup (COR-625)

`BureauOptions.retention.checkpoints` controls whether a durable run's Weft checkpoint history is ever pruned once that run reaches a terminal state. It defaults to `'keep-all'`—unbounded, exactly the behavior described above—so a long-lived deployment must opt in before any checkpoint is ever removed:

```typescript
import { createBureau } from '@lostgradient/bureau';

const bureau = await createBureau({
  agents: {},
  storage: { type: 'sqlite', path: './bureau.sqlite' },
  retention: { checkpoints: { keepLast: 5 } },
});
```

`keepLast` must be a positive integer, and `timeoutMilliseconds`, when supplied, a finite non-negative number—both validated at `createBureau()` construction time (`BAD_REQUEST` otherwise), the same boundary `retention.audit` uses. Zero is rejected even though Weft's own `Engine.pruneCheckpoints` accepts it: retaining nothing would discard the newest checkpoint a postmortem needs, which is not what configuring _retention_ asks for.

Every terminal transition of a durable run—completion, error, abort, or a durable cancel through `bureau.tasks.cancel`—runs exactly ONE cleanup step for that run, however many of those triggers fire. The step is memoized per run id, which is what makes a durable cancel followed by the run's own terminal event a single step rather than two, and what covers a run cancelled while this process holds no live `ActiveRun` for it at all (no terminal listener ever fires there, so the cancellation path owes the step directly). Only a `'requested'` cancellation outcome reaches the step: the others describe a run that call never genuinely terminated.

The step re-reads the run's durable record through `engine.get()` and prunes only once the engine itself reports a terminal status. A Bureau terminal listener fires on operative's own event emitter, which is not proof the engine's final checkpoint write has committed, and Weft's prune rejects on a compare-and-swap race with a concurrent write—so pruning on the event alone would both risk removing a checkpoint ahead of the transition it belongs to and manufacture spurious failures out of a race that is really just "too early".

Each settled step writes exactly one `run.cleanup-settled` audit record, `detail: { acknowledgement }`, whatever the outcome—including the `not-required` of the default `'keep-all'` policy. An operator can only answer "did cleanup finish?" from a record that exists for every run, not only for the ones that pruned something.

The acknowledgement is operative's `CleanupAcknowledgement`: `{ status: 'completed' }` when the prune succeeded, `{ status: 'not-required' }` when no policy is configured or the bureau is not durable, `{ status: 'unresolved', reason: 'persistence-failed' }` when the store rejected the prune or the run was not terminal, and `{ status: 'unresolved', reason: 'timed-out' }` when a configured bound elapsed first. There is no `failed`-plus-`persistence-failed` pairing: `reason` exists only on `unresolved`, and `failed` stays reserved for a definite, observed teardown failure.

Weft exposes no engine-wide operation timeout to inherit, so `timeoutMilliseconds` is opt-in. When set, the bound sleeps on the Bureau's `RuntimeServices.timers`—never a real timer—and its abort signal is passed into `pruneCheckpoints({ signal })`, so Weft aborts before issuing any delete. Abandoning only the wait would leave unowned deletes running behind a cached `'timed-out'` result. Omitted, the step is unbounded and a caller bounds its own wait through `closed({ signal })`.

The step also folds into the durable run's `closed()`, where it only ever _downgrades_: a step reporting `completed` or `not-required` leaves a `completed` run `completed`, while `unresolved` or `failed` surfaces in its place. The run's own cleanup genuinely did finish; a retention step with nothing to prune is a separate fact, and it belongs in the audit record rather than in the run's acknowledgement. The hook is registered on a run's `closed()` only when a retention policy is actually configured—registering it disqualifies `closed()`'s `not-required` fast path (a run with cleanup registered does have cleanup left to do), which would otherwise change `closed()`'s answer for every bureau that never asked for retention. The audit record is written either way.

### Run-creation receipts (COR-424)

A `bureau.tasks.start` call that names `commandId` goes through a durable command ledger (`command-ledger.ts`) and resolves with a handle whose `receipt` is a `RunCreationReceipt`: `{ runId, requestId, createdAt, status }`, where `status` is the run's status when the receipt was recorded. The call must also carry a non-blank `principal`; without one it is a `BAD_REQUEST`. Receipts need a bureau with storage and a durable engine, because a receipt promises that a retry after a restart finds the original run. Without a durable engine the call is rejected with `BureauError` (`NOT_CONFIGURED`, subject `durable`). The restart guarantee holds only as far as the storage itself persists.

The ledger keys each entry on `(principal, agentName, commandId, operationVersion)`, with surrounding whitespace trimmed from the command id. The operation version is `bureau.task-start.v2`, so a receipt persisted by an older version of the start is not found and the retry runs as a fresh task. The principal is keyed exactly as the run records its owner, so a receipt only ever replays to the principal that owns the run. `agentName` is the agent the task is for, so one command id sent to two agents creates two tasks rather than a conflict. Beside the key, the ledger stores a SHA-256 digest of the payload that decides the task: `agentName`, `input` (an appended row contributes every field except the `createdAt` and `position` that appending re-stamps), `contextId`, and the part of `requestContext` that authorizes the run, each taken at the value the task will use. A retry that spells out a default it first omitted is therefore the same command. The credentials and tracing of a request context legitimately differ between retries, so they are not part of the digest. Entries live in the same key-value store as the bureau's sessions.

- **Exact retry.** The same principal, agent, request id, and payload return the original run and the original receipt. Nothing is written, and flow control is not consulted, so a retry is never rejected as a duplicate trigger. Concurrent identical requests in one process create one run.
- **Conflicting retry.** The same identity with a different payload rejects with `BureauLedgerConflictError` (`requestId`, `reason: 'payload-mismatch'`, and `originalReceipt` once the original has one). The attempt is recorded as its own failed entry, and the original entry is never changed. This is not a `BureauError`.
- **Retry while pending.** The ledger claims the identity, with the run and session identifiers it minted, before flow control admits the run, and records the receipt once the run is durably started. A retry that finds the claim pending waits for the attempt when it is in flight in the same process. Otherwise (after a restart) it looks for the claimed run. When the run exists, live or in the durable engine, the retry records the receipt with the status it observed, and every later retry receives that same receipt.
- **A claim whose run never started.** When the claiming process died before the run reached the durable engine, retries report the claimed run as `pending` and start nothing. Without a lease, a crashed claimant cannot be told apart from a slow one, so the request id stays bound to that claim until the retention window, measured from the claim, has passed. A caller that needs the run sooner must use a new request id.
- **Failure.** When no run results (flow control rejects it, or a session or durable write fails), the claim is released and a retry starts afresh. When the run was durably started but its receipt could not be recorded, `tasks.start` rejects with `RunCreationReceiptUnrecordedError`, which names the `runId`. The run keeps executing, and a retry of the same request records and returns its receipt.

**Retention.** Each rule above holds only while the binding is retained. A binding is kept for `BureauOptions.retention.receipts.olderThan` after its run settles: a positive integer, 86,400,000 (24 hours) by default (`receipts` takes `{ olderThan }` only, and `'forever'` is refused with `BAD_REQUEST`), the same as Weft's mailbox `terminalRetentionMs`. Time is the bureau's injected runtime clock. A run still in progress holds its binding however old it is, so a delayed retry of a long-running run never starts a second one. The window runs from the run's terminal action, as the bureau's run store recorded it, whether or not anyone queried the run in the meantime. The one exception is a run that settled before a restart and was not reattached: the ledger cannot see when it settled, so it records the first retry, receipt query, or prune that observes it settled, and the window runs from that moment. A claim whose run never started is measured from the claim.

Once the window has passed, `bureau.tasks.receipt({ principal, agentName?, contextId?, commandId })` reports `{ status: 'expired', requestId, expiredAt }`, and the same request id creates a new run as a fresh attempt, whatever its payload. The new claim replaces the expired entry and deletes its conflict records in the same compare-and-swap. Until then, those conflict records are ignored, because the binding they conflicted with no longer holds. Durable maintenance deletes expired bindings and their conflict records: `runDurableMaintenance()` on a `'manual'` host, and the bureau's own maintenance interval under the default `'automatic'` profile. A query for a pruned binding reports `not-found`. A request is keyed under the agent its run is, so a run that omitted `agentName` on a session bound to `alpha` is keyed under `alpha`, and a retry that spells `alpha` is the same command; name the context with `contextId` to look the command up without knowing the agent. Before expiry, the query reports `recorded` with the original receipt, or `pending` for a claim with no started run. Like a retry, a query that finds the claimed run started records its receipt.

`run-creation-fault-points.test.ts` covers the crash-before-claim, after-claim, after-work-start, after-effect-before-ack, and during-cancellation fault points over both SQLite and LMDB. Session-input admission, schedule mutation, review resolution, and cancellation do not use this ledger yet.

### The Durable Event History Store (AB-91)

```typescript
import type { Bureau } from '@lostgradient/bureau';

declare const bureau: Bureau;
declare const runId: string;

const page = await bureau.tasks.events(runId);
if ('outcome' in page) {
  // 'unsupported-capability' (ephemeral bureau) or 'gap' (since predates retention)
} else {
  console.log(page.events, page.hasMore, page.nextCursor);
}
```

`createBureau()` builds a durable event-history store over the workspace version of Weft's `FleetEventFeed` whenever a genuinely **persistent** storage backend is configured. It shares `runtime.durable.engine.storage`—there is no second durable log. `bureau.tasks.events(id, options?)` (and `contexts.events`, `schedules.events`, `goals.events`) provides a bounded, sequence-ordered read over one run's or session's events after an exclusive `since` cursor, while `bureau.tasks.subscribeEvents(id, listener, options?)` (and the matching `subscribeEvents` of each namespace) provides a replay-then-live subscription over the same events. If `since` predates the retention floor, `tasks.events()` returns a typed `DurableEventGap` (its pre-existing `firstRetainedSequence` is a sequence number), and `tasks.subscribeEvents()` delivers one `history.gap` event (`DURABLE_HISTORY_GAP_KIND`) through the listener, then continues from the floor. The event's payload is `{ requestedCursor, firstRetainedCursor }`, both cursor strings, and `firstRetainedCursor` is the canonical shape for a subscriber; `requestedCursor` is the cursor of the last event the listener received (a previous gap event included), or the `since` it started from when it has received nothing. The envelope `cursor` is the last cursor before the first retained event, so resuming from it lands on the floor. A subscription whose undelivered backlog the floor overtakes while it is open gets the same event before any later one; a subscription drained to the tail never does. The gap event is synthesized, never stored: `record()` rejects the reserved kinds `history.gap` and `frames.dropped` with `ReservedDurableEventKindError`.

`BureauOptions.retention.events` (default `{ olderThan: 604800000 }`, 7 days; `'forever'` opts out) bounds the history: each durable maintenance pass, manual or automatic, advances the floor over the contiguous prefix of events emitted before `now - olderThan`, never past an event that is not older than the window, and deletes the dedupe markers of the events it removed. The `run.removed` event that records a deletion is an ordinary event and ages out under the same window, after which a deleted run reads as an unknown one. `BureauOptions.retention.tasks` (default 30 days, `'forever'` opts out) bounds tasks: a pass removes each run that is older than the window from the run store, so its `run.removed` fires and everything keyed on the run releases its state. A run counts as old from its closing `run.completed` or `run.aborted` action, never from `run.error` alone (it is followed by `run.completed`). It stays while its COR-424 run-creation binding is stored, expired or not, so the pass ahead of the receipt sweep keeps it one more pass; one unreadable binding record makes the pass fail closed, deleting nothing and diagnosing it, until the record is repaired. The pass runs from `runDurableMaintenance()` and from the automatic maintenance timer, which starts only for a durable bureau or one with KV-backed audit retention; an ephemeral bureau with neither keeps its terminal tasks until something calls `runDurableMaintenance()`. Only runs in this process's run store are candidates: a terminal run from before a restart is never reattached, so it is never deleted by this pass and never receives `run.removed` from it. An ephemeral Bureau returns `no-persistent-storage` from `tasks.events()` and a closed subscription from `tasks.subscribeEvents()`.

`tasks.events(id, { principal })` authorizes a task's run against the run's owner of record (see [Owner of record](#owner-of-record-cor-718)) and fails CLOSED (`{ outcome: 'not-found' }`) whenever that ownership cannot be verified, including for a deleted run (AB-313). This holds across a process restart: the owner recorded when the task started is persisted on the run's owning session (`lastRunOwningPrincipals`) and rehydrated into the same in-memory attribution a live run uses the moment a durably recovered run is reattached, so a recovered run's real owner reads its durable history exactly as it did before the crash (AB-359). A `{ kind: 'session', ... }` owner is authorized by `isSessionHistoryReadAuthorized`: only the session's owner passes, and a session written before owners existed belongs to `anonymous:local`. A session whose recorded owner is malformed fails closed (`{ outcome: 'not-found' }`) for every principal. The same rule applies before the page is read, after a gap, and after the page resolves. A caller that states a principal reads only a live session it owns: a deleted session's history is `not-found` to it, its former owner included, because history is keyed by id alone and a deleted session has no owner left to compare, and only a trusted call (no `principal`) gets the `deleted-aggregate` outcome with the events. Every durable session event records the incarnation it was recorded for (`session.created`, `session.saved`, and `session.deleted` from their outbox entries; a `session.*` action from the `incarnation` its detail states), and a principal-stated read, page or subscription, keeps only the events recorded for the live session's incarnation, whatever `since` and `limit` it passes. An event recorded for no incarnation, which includes every event stored before the field existed, is never shown to a principal. This holds however an earlier incarnation ended: `bureau.contexts.delete`, or `SessionStore.cleanup()`, which also appends one `session.deleted` outbox entry per expired session so an expiry leaves the same deletion marker and audit entry a deletion does. Omitting `principal` entirely still bypasses the check for every owner kind (an internal/trusted caller).

This is a THIRD layer, distinct from both the operative store (Layer A, live) and the audit trail above (Layer B, KV-based, `AUDIT_EVENT_TYPES`-scoped—see that section for the exact set): the event history store is restart-durable by construction (proven by reopening the same SQLite/LMDB file across two independently constructed store instances—see `durable-event-history.test.ts`), owner-scoped rather than a flat log, and cursor/gap-aware for reconnect-safe paging.

A producer (`createDurableEventProducer`, wired into `createBureau()` alongside the audit trail) sinks the run/session/schedule-fire/schedule-definition families AB-87's matrix classifies as durable into `record()`—`run.completed`/`error`/`aborted`/`tripwire` (owner: the action's `runId`) and the durable `session.*` lifecycle rows (owner: the action detail's `sessionId`) from the bureau's own action stream; `schedule.completed`/`schedule.failed` (a scheduled fire is "an ordinary run" per AB-87, so these are recorded under the fired run's own `{ kind: 'run', id: runId }` owner) and, as of AB-320, `schedule.created`/`paused`/`resumed`/`cancelled` (recorded under `{ kind: 'schedule', id: scheduleId }`, the schedule's own owner kind) from the bureau's own schedule-lifecycle events. A schedule's durable page carries its four definition events only—never a fire; the fired run's own page carries the fire only—never a definition event. `schedule.attempted`/`schedule.skipped` (COR-660) are deliberately absent from both: one event per tick per schedule is a liveness pulse rather than a durable transition, and AB-87's matrix excludes high-rate pulses from cursor advancement, so they dispatch live on the bureau emitter and are recorded nowhere. Whether a dropped occurrence specifically deserves a durable row — it is the only observable trace of a tick that produced no run — is settled by COR-1224: neither is durable as an event row, and a dropped occurrence is instead recorded on Weft's own schedule record as `skippedCount` and `lastSkippedAt`. A schedule whose fires outlast its cadence collides on every tick, so a durable row per drop would grow without bound and advance the durable cursor for a fact whose content is that nothing happened; a counter answers the operator's question — is this schedule colliding, and when last — in constant space, and survives a restart that a live listener would not. AB-224 adds a fourth source, the same shape as `schedule.*`: the `review.*` lifecycle events (`review.requested`, when a review becomes pending, and `review.approved`/`denied`/`rejected`/`expired`/`revoked`/`canceled`/`superseded`), recorded under the reviewed run's own `{ kind: 'run', id: runId }` owner with a minimal, privileged payload (`reviewId`/`runId`/`principal`/`kind`; `review.requested` adds the `signalName` of a human wait or the `callId` of an approval, never a prompt or an argument). AB-372 adds a fifth, dedicated listener rather than another `'action'`-stream case: `bureau.contexts.delete` dispatches `SessionDeletedEvent` on the bureau emitter (never through the action stream—as of AB-389, replayed from the session commit outbox by `drainOutbox` rather than dispatched directly by `bureau.contexts.delete` itself; see "Session commit outbox" below), so this producer listens for it directly and records the same `{ kind: 'session', id: sessionId }` / `session.deleted` durable event the deleted-aggregate detection of the event-history reads reads—closing the gap where that detection was previously only ever exercised by synthetic records the test suite constructed directly. It de-duplicates a same-process duplicate dispatch (concurrent `bureau.contexts.delete` calls racing to delete the same session) with an in-flight `Map` keyed by owner AND `AgentSession.incarnation` (AB-384—before it, the key was owner alone, which conflated a session id recreated and deleted again WHILE the prior incarnation's own write was still pending with a duplicate dispatch of that prior deletion; see `SessionDeletedEvent`'s own doc comment), checked and set synchronously before any `await`; it does not scan the durable page for a prior record, so a session recreated under the same id and deleted again writes a second, later `session.deleted` row rather than being suppressed as a duplicate—the two dispatches are for different incarnations, not the same one, and now produce two records even when their writes overlap. This producer also exposes `waitForActiveWrites(owner): Promise<void>`, a snapshot-only sibling to `hasActiveWrite`: it awaits every write in flight for that owner AT THE MOMENT OF THE CALL (never one started afterward) and never rejects, so `resolveEventHistory` can await it before paging to close the read-your-writes race against this producer's own fire-and-forget writes without risking an unrelated caller's write leaving it hanging.

AB-384 adds a sixth and seventh source, closing a dead entry each: `SESSION_DURABLE_ACTION_TYPES` has listed `session.created`/`session.saved` since AB-91, but nothing ever dispatched either onto the `'action'` stream. `@lostgradient/operative`'s `SessionStore` dispatches both on the bureau-level emitter—as of AB-389, replayed from the session commit outbox, never dispatched directly by `save()`/`update()` themselves (see "Session commit outbox" below)—and this producer's two dedicated listeners record them under the same `{ kind: 'session', id: sessionId }` owner `session.deleted` already uses. Every one of these three listeners' `history.record()` calls now also passes an `options.dedupeKey` (the outbox entry's own `ordinal`, stringified) and `options.emittedAtMs` (the entry's own `committedAtMs`, so a delayed replay never misdates the event as happening "now")—never embedded in the recorded `payload` itself, so a caller's own payload carrying a same-named `dedupeKey` field is unaffected. `record()` writes the dedupe identity as an atomic storage compare-and-swap alongside the event append itself (in the SAME `conditionalBatch` `FleetEventFeed.append` commits), not a read-before-write scan: two processes racing to record the identical `(owner, kind, dedupeKey)` can never both succeed, closing the redelivery race a scan alone cannot (a crash between a durable write settling and the entry being acknowledged, or two drains racing over one shared backend, resolves to a no-op read of the winner's own record, never a second durable append).

### The AG-UI mount (COR-855)

`createBureauHandler(bureau, { publish: ['assistant'], agUi: {} })` mounts an AG-UI 1.0 adapter beside the operation catalog. It needs a Bureau with a durable engine (`bureau.internals.hasDurableEngine`), because its human-wait parks and run-creation receipts both depend on one, and it throws at construction without one. A **thread** is a Bureau session. The adapter selects agents from `publish` (code-defined agents) and from the persisted agents whose own file publishes them (`bureau.agents.definitions.publish`), and an agent served over it should be configured with `stopWhen: pendingApproval()`: without it a run keeps generating past a gated tool call and the interrupt reaches the client steps later.

The option is `agUi?: { pathPrefix?, maxStreamDurationMs?, liveBufferSize?, keepAliveIntervalMs?, leaseDurationMs?, runtime? }`. `pathPrefix` defaults to `/ag-ui`, `maxStreamDurationMs` to 900000 (fifteen minutes, set separately from the catalog subscriptions' deadline), `liveBufferSize` to 1000, `keepAliveIntervalMs` to 5000, and `leaseDurationMs` to 30000. `runtime` is the clock and timers the mount reads, for a test that drives the deadline with a manual clock.

| Route | Body | Answer |
| --- | --- | --- |
| `POST <prefix>/agents/<name>/run` | `RunAgentInput` (JSON); `Accept` must include `text/event-stream` | An AG-UI event stream. `resume` absent or empty starts a run; `resume` present resumes one. |
| `GET <prefix>/threads/<threadId>/run` | none | A stream attached to the thread's most recent root run while it is live, parked on a human wait, or settled with a tool approval pending; otherwise a one-event `RUN_NOT_FOUND` stream. |
| `GET <prefix>/threads/<threadId>/messages` | none | JSON `{ threadId, messages }`: the thread's conversation as AG-UI messages (the mapping the attach snapshot uses), whether or not a run is going, so a client can open a finished session. Decided by the attach route's predicate; a thread the caller may not read is a `NotFound` fault, as a missing one is. |
| `GET <prefix>/runs/<runId>` | none | The same, for that run by native id. A child run's owner attaches here too, by the child's own id: see **Events**. |
| `POST <prefix>/runs/<runId>/cancel` | none | JSON `{ runId, status }`, or a `NotFound` fault. |

Every route is authenticated by the handler first, and decides with the owner predicate the catalog operations use (see [Owner of record](#owner-of-record-cor-718)). **What a scope grants.** The owner of a thread does everything on it. `bureau.tasks:read` lets any other principal attach to it. `bureau.tasks:write` lets any other principal cancel its run and answer a _human-input wait_ on it (a question the agent put to a person, which an operator may be the one to answer), and nothing more: only the owner starts a run on an existing thread, and only the owner answers a _tool approval_, because approving a call authorizes a tool to run as the owner. A start by another principal on an existing thread is answered `THREAD_NOT_FOUND`; a resume by another principal that includes any tool-approval interrupt is answered `INTERRUPT_NOT_FOUND`, before any interrupt is resolved. A resume by a principal that may write but not read the thread (neither its owner nor holding `bureau.tasks:read`) gets a stream of only `RUN_STARTED` and `RUN_FINISHED` once its answer is applied, with no snapshot, replay, step, text, tool-call or tool-result event and no echo of the answer, because the continuation's output is what an attach reads. Both are the answers a missing thread or interrupt gets, and `tasks.start`'s own refusal of a context another principal owns (COR-718) is unchanged. A caller the predicate refuses is answered exactly as a missing resource is. A door refusal on a streaming route is a one-event stream with HTTP 200, because a client that reads events turns a non-2xx response into a thrown error: `RUN_ERROR` with a code from the closed set `THREAD_NOT_FOUND`, `THREAD_BUSY`, `RUN_NOT_FOUND`, `INTERRUPT_NOT_FOUND`, `INTERRUPTS_UNADDRESSED`, `RUN_CONFLICT`, `RESUME_CONFLICT`, `INVALID_INPUT`, `STREAM_DEADLINE`, `STREAM_OVERFLOW`, `RUN_FAILED`, `CONTINUATION_UNAVAILABLE` (an approval was left unapproved because no run can start from the thread's conversation as it stands; deny or cancel it instead), and `REVIEW_ROUND_CHANGED` (a resume entry named a round the approval has moved past, so nothing was decided). Transport problems stay status codes: 400 for a body that is not a `RunAgentInput`, 406 for a missing `text/event-stream` accept, 401 from the handler. **Which record decides.** A thread's owner is read from the session the route then serves, not looked up apart from it, and a run's from the run: a thread deleted and created again by another owner under the same id between two reads is therefore a missing thread to the caller authorized on the first, never the new owner's conversation. On a resume, the agent-routing refusal (a review with no recorded agent is matched against its session's agent) reads that session as the review's owner too: another owner's session under the same id names no agent, so the route is refused as an interrupt that does not exist. The same holds for the reads a stream makes after the route has decided (the thread's snapshot, the messages a run delivered, the run itself): a record of another owner than the one authorized is a missing one.

**Starting.** The mount reads `threadId`, `runId`, `messages`, `tools`, `protocolVersion`, and `resume`; `state`, `context`, and `forwardedProps` are accepted and ignored. The new rows are the messages whose ids the session lacks, and the run is `bureau.tasks.start(agentName, { append: appendMessages }, { contextId: threadId, principal: owner, commandId: runId })`, so a stable `runId` makes a retried start attach to the run it started. A `threadId` that names no session creates one, owned by the caller. A start is refused as `INVALID_INPUT` when `tools` is not empty (the mount runs the Bureau's tools only), when `protocolVersion` is anything but `1.0`, or when its last new row is not a user message, and as `THREAD_BUSY` when the thread's most recent run is unsettled, which is decided from what the store holds and so is the same answer in every process: the session says it is running and its durable record is unsettled (pending, running, or suspended; a run is pending until its launch has flushed) (a marker a crash left behind is settled by durable recovery, so it cannot hold the thread for ever), or it settled with a tool approval still pending (the session still holds the approval, which Bureau removes in the same write as whatever resolves it, from any process, and which stops holding the thread once its binding expires, read on the mount's clock, so it inherits the lease's skew assumption). A store that cannot be read counts as busy. A run's terminal session save writes the session's last-run fields (`lastRunId`, `lastRunStatus`, `lastFinishReason`, `lastError`) only while the stored `lastRunId` is still that run, so a save that lands late cannot make a newer run's session read as an older outcome. A known limit, which predates the mount: a start admitted after a run has settled durably but before that run's terminal save lands appends the settled run's final row after the new run's user row, so the transcript can read the first user message, the new user message, the first run's reply, then the new run's reply, and the new run's model never saw the first run's reply. Whether the thread is busy and the creation of the run that makes it busy are one decision, taken under a lease on the thread in the Bureau's own store (`ag-ui-lease:v1:thread:<threadId>`, a record of `{ claimant, expiresAt }` written by compare-and-swap, `expiresAt` read from the mount's clock): a start in any process that finds the lease held answers `THREAD_BUSY`, and the lease of a process that died expires after `leaseDurationMs` and is taken over by exactly one claimant. The Bureau's default `workflow-lease` posture lets several processes share a store, so the guarantee does not rest on one process. A start whose `runId` already names a run of another thread is `RUN_CONFLICT`. A start retried after the Bureau restarted attaches to the run it started and replays what the durable record holds: the conversation, and the outcome the run really had (its error, if it failed). A `threadId` of `.` or `..` that no session holds is refused as `INVALID_INPUT` with a message beginning `unopenable-session-identifier:`, because a browser resolves those out of the address a client would open the thread at (COR-1590); `tasks.start` and `createSchedule` refuse the same ids for a context that does not exist yet, as `BAD_REQUEST` with the same message.

**Events.** A start stream is `RUN_STARTED`, `STATE_SNAPSHOT`, then the run's events, then `RUN_FINISHED` or `RUN_ERROR`; a run that stops at its step limit (`finishReason: 'maximum-steps'`) is a failure, so its stream ends with `RUN_ERROR` whose `code` is `MAXIMUM_STEPS` and whose `message` is the error's, after the answer an `onMaximumSteps` handler leaves, which streams first as its own text row, and a peer's stream for the same run ends the same way whether it reads the end from the run's history or from the workflow's status; a run that itself took input from `bureau.contexts.input` also ends with a `MESSAGES_SNAPSHOT` of its thread just before its terminal event, whichever way it ended (a later run on the same thread that took none does not), and the stream waits for the session to record the run's end however long that takes (`Bureau.whenRunRecorded`); if the thread cannot be read back it ends with a `RUN_ERROR` (code `RUN_FAILED`) rather than a success without the snapshot, because the input never streams as an event of its own and a client holding its row (under the id it sent the input with) learns from the snapshot that the run delivered it, and where. A run that ended without this process saving its end (it reported an error and was then abandoned after losing a checkpoint compare-and-swap) ends with the run's own `RUN_ERROR` when its result settles, never at the stream's deadline, and the client attaches again to read what the owner recorded. A run whose engine's checkpoint or workflow-state write storage refuses (a refused `wf:` or `ev:` write) is retried in process, five attempts: the first and then four retries after waits of 50, 100, 200 and 400 ms (750 ms in all). A write that is still refused fails the run as a `system` failure, so the stream ends with the run's own `RUN_ERROR`, the run record and the session read `error`, and the thread takes new input, all before the deadline. One case leaves the engine's durable record `running` until the next boot: when the failure write itself is refused on all five attempts, the engine stops driving the run and rejects its result, so the run, the session and the stream end as `error` now, and the next boot resumes the run from its last committed checkpoint, which settles the session again with whatever outcome it reaches (a client can read `error` and, after a restart, `completed`). An attach stream opens with `RUN_STARTED`, `MESSAGES_SNAPSHOT` (the conversation, with `thinking` and `redacted_thinking` parts taken out first), and `STATE_SNAPSHOT`, replays the step still in flight, and follows the run. Steps are `STEP_STARTED` and `STEP_FINISHED` with `stepName: 'step-<n>'`. Row ids are derived from the native run id so a streamed id and a later snapshot's agree: the assistant text of step `n` is `<AgentRun.id>:step:<n>`, a call is `<AgentRun.id>:step:<n>:call:<callId>` (the first call of a step with no text takes the step's own id), and the result for call `c` is `<AgentRun.id>:step:<n>:result:<c>`. `toolCallId` is the native call id. `STATE_SNAPSHOT` carries `{ revision, status, assessment, pendingInterruptIds }`; for a run the Bureau no longer holds there is no liveness to assess, so it carries `status: 'terminal'` and no `assessment`. There is no `STATE_DELTA`, `ACTIVITY_DELTA`, or `REASONING_*`, and the only `ACTIVITY_SNAPSHOT` is an interactive surface's (activity type `a2ui-surface`), sent to a client that opted in to A2UI (see [Interactive surfaces](./documentation/interactive-surface.md#a2ui-over-ag-ui)); the full list is under [Unsupported](./documentation/interactive-surface.md#unsupported). A child run is a separate native run and never appears on its parent's stream. Its owner attaches to it at `GET <prefix>/runs/<childRunId>` and cancels it at `POST <prefix>/runs/<childRunId>/cancel` (through the child topology): the stream's thread is the parent's session, its `RUN_STARTED` carries `parentRunId`, and it opens with a `MESSAGES_SNAPSHOT` (the child's final text under its own row id, `<childRunId>:step:<n>`, once it has one) and a `STATE_SNAPSHOT` of its record, then streams that message if the child settles while attached, and ends (`RUN_FINISHED`, `cancelled` when it was cancelled, or `RUN_ERROR` `RUN_FAILED`). None of its events is labelled durable. Anyone else is answered `RUN_NOT_FOUND`.

**Multimodal content (COR-1547).** A user message may carry an asset a caller uploaded through `bureau.assets.uploads.*` as a part whose `source` is `{ type: 'file', provider: 'bureau', value: <assetId>, mimeType? }` (an `image`, `audio`, `video`, or `document` part). It becomes a `managed-asset` content source, so the run resolves it as the thread's owner; `mimeType` is optional because the asset's detected media type is authoritative. A start that names an asset its caller cannot read is refused as `INVALID_INPUT` with the message `Asset "<id>" was not found` (the same for another owner's asset as for a missing one), and one that names an asset the caller owns that is not `available` (pending, rejected, quarantined, expired or deleted) is refused as `INVALID_INPUT` with `Asset "<id>" is <state>`; either way nothing is added to the thread, because a run resolves every asset in the thread on every turn and a row naming an unusable one would fail every later turn. An agent's generated assets reach the stream as `CUSTOM` events named `bureau.asset-part` with the value `{ messageId, index, assetId, mediaType }`, one for each, in ascending `index` (the part's position among the step's parts), inside the step's message, after its `TEXT_MESSAGE_START` and before its `TEXT_MESSAGE_END`; a step with assets and no text gets a message of its own to hold them. A `MESSAGES_SNAPSHOT` (and `GET <prefix>/threads/<threadId>/messages`) carries a user row's assets in the same `file` shape, and an assistant row's in its `metadata['bureau:assetParts']` as `[{ index, assetId, mediaType }]`; nothing is sent again after a snapshot. A message whose every media part is refused because the selected model does not accept that kind of media (`modality-not-accepted` or `mime-family-not-accepted`) fails before generation as a `RUN_ERROR` with `code: 'UNSUPPORTED_MEDIA_TYPE'`; a message with any admitted part, and any other refusal (a flagged asset, a limit, an unbounded cost) or mix, keeps `MEDIA_NOT_ADMITTED`.

Every event carries `metadata['@lostgradient/bureau'] = { runId, sessionId, durable, cursor?, tripwire? }`, where `runId` is the native `AgentRun.id` and `durable` is defined by provenance: `true` exactly when the event is the projection of one record in the durable event history, which today is the event that ends the run (`run.completed`, `run.aborted`, `run.error`). Such an event carries the record's `cursor` when the Bureau keeps durable history (a SQLite or LMDB store; the in-memory store keeps none), and that cursor is also the frame's SSE `id`. Everything else is `durable: false` with no `id`, so a live delta can never advance a durable replay cursor. A client resumes durable history with `bureau.tasks.events` and `subscribeEvents`, never with these routes, which re-snapshot.

**Interrupts and resume.** A human-wait park, or a run that settles with a tool approval pending, ends the AG-UI run with `RUN_FINISHED` and `outcome.type: 'interrupt'`, one interrupt per pending review, under the review's own id. A resume is a new authorized command recorded in the command ledger: its entries are `{ interruptId, status: 'resolved', payload }` with a payload of `{ decision: 'approve' | 'deny' | 'reject', reason?, arguments?, answer? }` (`reason` is required, and non-blank, to reject; `arguments` overrides a tool approval's arguments; `answer` is delivered to a human wait), or `{ interruptId, status: 'cancelled' }`, which denies, and is how a client abandons an approval. Either kind of entry for a tool approval may carry the `round` its interrupt showed, as `metadata['@lostgradient/bureau'].round` (the key and field the interrupt's own metadata carries it under): a re-gated approval keeps its id and advances its round, so a resume whose entry names another round than the review's current one is refused `REVIEW_ROUND_CHANGED` before anything is decided, and an entry without one is not fenced (COR-1714). Cancelling a run that settled with an approval pending does not clear the approval, so the thread stays `THREAD_BUSY` until the approval is answered. A resume must answer every review pending on the run or it is refused as `INTERRUPTS_UNADDRESSED` with nothing applied. A human wait is answered on the same native run, and its stream carries the answer as a user row of its opening `MESSAGES_SNAPSHOT`, under the id the conversation holds it by (`<AgentRun.id>:signal:<signalName>:<n>`), when the run has not appended the row yet (a snapshot that already holds it is not given it again, and no user-role `TEXT_MESSAGE_*` is streamed for it, COR-1632); a tool approval ends in a new native run started from the updated conversation, whose stream replays the approved call (with the arguments it ran with, when the approval overrode them) and then carries the executed result under the pending row's id. When the policy gates an approved call again, no run starts: the stream re-emits the interrupt under the same id with `round` incremented. The command's key is the JSON of the sorted `[id, round]` pairs of its interrupts, so an exact retry attaches to the first attempt's run without touching a review, the same interrupts answered differently are a `RESUME_CONFLICT`, and a resume after a supersession is a new command. A resume is applied under a lease on its command and a lease on its thread (`ag-ui-lease:v1:resume:<key>`, same record), renewed before each step that cannot be taken back. A retry that finds the command's lease held is told `RUN_FAILED` (in progress) and touches nothing; a retry that finds it expired takes the command over: while any interrupt it answers is still pending the earlier attempt did not take effect and the retry applies it, and once every one is resolved the earlier attempt applied them and the retry finishes it (finding the run that continues from them, or starting it once, and streaming a human's answer if that is what was delivered). A tool that outlives its lease is the residual a lease cannot fence: inside one process Armorer's single-use approval binding stops it running twice, but that binding is held in the process's memory, so across processes only the ledger's compare-and-swap and the idempotent run-creation request id hold (one entry, one run) and the tool itself can run twice. Leases assume clock skew between processes below the lease length minus the renewal interval, and an unreadable lease record fails closed. If only some of a resume's answers could be applied the command is left for the retry, which applies the rest and starts one run. A resume that resolved nothing is released, so answering again works. Before it approves a tool call it checks that a run can start from the thread's conversation (one that ends in a user or tool-result message); if not it approves nothing and answers `CONTINUATION_UNAVAILABLE`, so a tool never runs to a dead end. A cancel, a deny, or a reject runs no tool, so it always resolves: with no run to start it writes the refusal as the outcome, starts no run, and streams the settled run's end, which frees the thread. When one step both asks a human and calls a gated tool, the human wait is offered first; once it is answered the run settles on the approval without generating again (the answer is part of the conversation the approval's continuation starts from). A tool approval is offered, and answerable, once its run has settled: while the run is still going (parked on a human wait, say) its conversation is not stored, so the outcome of an approval could not be written into it, and the approval is not in the interrupt, in `pendingInterruptIds`, or answerable (`INTERRUPT_NOT_FOUND`). A tool approval whose outcome could not be written into the conversation after it was decided ends the resume with `RUN_FAILED` and starts no run, because a run that continued from the stale conversation would ask the same question again; a retry that finds the conversation still shows an answered call as waiting refuses in the same way. Resume ledger entries past their retention window are dropped when the next resume comes.

**Ending.** A client that goes away, a stream that reaches `maxStreamDurationMs`, and a reader that falls behind `liveBufferSize` all end the stream and leave the native run running. The last two end it with `RUN_ERROR` `STREAM_DEADLINE` and `STREAM_OVERFLOW`, which a client treats as a reason to attach again, not as a failure. A reader that falls behind is closed rather than thinned, because a dropped text delta would corrupt a transcript rebuilt from deltas. A quiet stream writes an SSE comment (`: keep-alive`) every `keepAliveIntervalMs`, because `Bun.serve` closes a connection that sends nothing for ten seconds by default and a model step that does not stream can be silent for longer; every client skips a block with no `data:` line. Keep it below the server's idle timeout.

`bureau.reviews.resolve` now also writes a tool approval's outcome into the session's conversation (the executed result, or an error result carrying the reason on deny and reject), replacing the pending `action_required` row in place, for every caller of `bureau.reviews.resolve`, not only this mount. When that write cannot be made, `bureau.reviews.resolve` rejects with `ApprovalOutcomeNotWrittenError` after the decision has been recorded (the decision took effect; only the write failed), rather than reporting success. The one case it does not write is a conversation that never held a row for the call and whose run is no longer going (a review restored from persisted metadata alone); a run that is still going has not stored its conversation, so there the write is refused instead. An agent without `stopWhen: pendingApproval()` can overwrite the written row with the rest of its step.

### External control plane

`createBureauHandler(bureau, options)` is the entry point for a process outside the Bureau. It serves the management plane (`bureau.*` operations over JSON-RPC, and one subscription route over Server-Sent Events), the AG-UI mount when `agUi` is set, and the asset content route. [`documentation/external-control-plane.md`](./documentation/external-control-plane.md) is the reference: it began as the decision record for the contract (COR-901), and its "As built" section says what shipped, with the operations, the owner of record and its `anonymous:local` caller, the operator scopes, the authorization predicate, run-creation receipts and `BureauLedgerConflictError`, and the error contract. It also lists what the handler does not do, each limit in its own entry under "Unsupported behavior and limits". A host that runs the handler for people, such as Interborough, keeps its state in `~/.interborough` (`INTERBOROUGH_HOME`), which [its README](../../applications/interborough/README.md) describes.

This is the whole path of an outside consumer: authenticate with an API key, discover what the deployment serves, read a task, answer it with a command that a retry cannot repeat, and await the result by reading the task's event stream to its end. It runs in [`src/external-control-plane-guide.test.ts`](./src/external-control-plane-guide.test.ts), which imports from `./index` instead of `@lostgradient/bureau`, records each `console.log` and asserts it, and checks that its example is this code block:

```typescript
import { createBureau, createBureauHandler, createMemoryAssetStorage } from '@lostgradient/bureau';
import {
  createAgent,
  stopWhen,
  waitForCondition,
  type GenerateFunction,
} from '@lostgradient/operative';
import { principalFromApiKey } from '@lostgradient/weft';

const databasePath = './bureau.sqlite';

// The agent asks which environment to release to, waits for the answer, then thanks the person.
let calls = 0;
const generate: GenerateFunction = async () => {
  calls += 1;
  if (calls > 1) return { content: 'Releasing to the environment you named.', toolCalls: [] };
  const prompt = 'Which environment should the release go to?';
  const ask = {
    id: 'ask-1',
    name: 'requestHumanInput',
    arguments: { signalName: 'environment', prompt },
  };
  return { content: '', toolCalls: [ask] };
};
const releaser = createAgent({
  name: 'releaser',
  generate,
  stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
});

const bureau = await createBureau({
  id: 'acme', // required once the handler serves persistent storage
  agents: { releaser },
  storage: { type: 'sqlite', path: databasePath },
  durable: true,
  assets: { storage: createMemoryAssetStorage() }, // the handler serves the asset operations
});

// Authenticate: the host says which key stands for which principal. A principal with no scopes
// owns what it creates and reaches nothing of anyone else's.
const keys = { 'alice-key': 'alice', 'bob-key': 'bob' } as const;
const handler = createBureauHandler(bureau, {
  publish: ['releaser'],
  authentication: {
    auditSink: () => undefined, // every authentication decision is passed here
    resolveApiKeyPrincipal: async (key) =>
      key in keys
        ? principalFromApiKey({ subject: keys[key as keyof typeof keys], scopes: [] })
        : null,
  },
});

// One management call, answered with its HTTP status and JSON-RPC body.
async function call(method: string, params: object, key = 'alice-key') {
  const response = await handler(
    new Request('http://bureau.test/jsonrpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  return { status: response.status, body: await response.json() };
}

const unknownKey = await call('bureau.deployment.get', {}, 'no-such-key');
console.log(unknownKey.status); // 401

// Discover: the deployment's identity, the agents it publishes, and the operations it serves.
const { body: deployment } = await call('bureau.deployment.get', {});
console.log(deployment.result.id); // 'acme'
console.log(deployment.result.publishedAgents); // ['releaser']
const served = deployment.result.operations.map((operation: { name: string }) => operation.name);
console.log(served.includes('bureau.tasks.respond')); // true

// The handler starts no run of its own except through its AG-UI mount, so the host starts this
// one. `principal` is the owner of record: an API-key caller `alice` owns as `api-key:alice`.
const run = await bureau.tasks.start('releaser', 'Release it.', { principal: 'api-key:alice' });
await waitForCondition(
  () => bureau.reviews.list().some((review) => review.runId === run.id),
  'the run did not park on its question',
);

// Observe: the task is Alice's, it waits on her, and to Bob it does not exist.
const { body: waiting } = await call('bureau.tasks.get', { taskId: run.id });
console.log(waiting.result.status); // 'input-required'
const { body: hidden } = await call('bureau.tasks.get', { taskId: run.id }, 'bob-key');
console.log(hidden.error.data.httpStatus); // 404

// Command: answer the question. The `messageId` is Alice's own, so a retry is the same command.
const answer = { taskId: run.id, messageId: 'answer-1', answer: 'staging' };
const { body: answered } = await call('bureau.tasks.respond', answer);
console.log(answered.result.receipt); // 'applied'
const { body: retried } = await call('bureau.tasks.respond', answer);
console.log(retried.result.receipt); // 'applied', the original receipt and nothing delivered twice

// Await: the task's history ends at its terminal status, so reading the stream to its end waits
// for the result. A cursor in `Last-Event-ID` resumes a dropped stream where it stopped.
const query = new URLSearchParams({ taskId: run.id });
const stream = await handler(
  new Request(`http://bureau.test/v1/subscriptions/bureau.tasks.events?${query}`, {
    headers: { accept: 'text/event-stream', 'x-api-key': 'alice-key' },
  }),
);
const body = await stream.text();
const frames = body
  .split('\n\n')
  .filter((block) => block.includes('event: task.'))
  .map((block) => ({
    event: /^event: (.*)$/m.exec(block)?.[1],
    data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? 'null'),
  }));
console.log(frames[0]?.event); // 'task.snapshot'
console.log(frames.at(-1)?.data.status); // 'completed'
console.log(frames.at(-1)?.data.artifact.text); // 'Releasing to the environment you named.'

console.log(calls); // 2: the retry did not run the agent a third time

await bureau.dispose();
```

The handler has no run-starting operation of its own, so the host starts the run above with `bureau.tasks.start`. A client outside the process starts one through the AG-UI mount. A stream that ends without a terminal status is resumed with the `Last-Event-ID` header set to the `id` of the last frame that carried a cursor.

### A2A

`createBureauHandler` serves each published agent as an [A2A](https://a2a-protocol.org/v1.0.1/specification/) agent when it is given a `publicUrl`. This section is for the consumer and for the host that publishes: what is served, what makes an agent publishable, which capabilities the Agent Card declares, and a worked example that runs as a test. The as-built contract (state mapping, identity, retention, and every limit) is [`documentation/external-control-plane.md`](./documentation/external-control-plane.md#as-built); this section links to it instead of repeating it.

**Pinned versions.** A2A 1.0.1 over the JSON-RPC binding, with `A2A-Version: 1.0` on every request (a patch version such as `1.0.1` is read as `1.0`; any other value is a `VersionNotSupportedError`). The interoperability test, [`src/http/a2a-interop.test.ts`](./src/http/a2a-interop.test.ts), drives the handler with `@a2a-js/sdk` `1.3.0`, the version Weft's `@lostgradient/weft/a2a` subpath pins exactly. `bun run --filter=@lostgradient/bureau test:a2a-tck` runs the official A2A TCK against a Bureau host, at the commit that [`packages/weft/scripts/run-a2a-tck.ts`](../weft/scripts/run-a2a-tck.ts) pins (`A2A_TCK_COMMIT`); it needs Python 3.11 or later, `uv`, and network access, and it is outside `bun run validate`. One TCK test is deselected for Bureau, the message-response test, because every Bureau send creates a task and never answers with a bare `Message`.

**Publishing an agent.**

- A code-defined agent is published only by the `publish` allowlist of `createBureauHandler`; an agent file (COR-1524) is published by its own `published` frontmatter. Publication is read on every request, so publishing or withdrawing takes effect without a restart. An unpublished agent has no card, starts no task, and reads as not found.
- One agent, one interface: `<publicUrl>/a2a/<catalog-name>` for JSON-RPC, `<publicUrl>/a2a/<catalog-name>/.well-known/agent-card.json` for the card, and, when `signing` is set, `<publicUrl>/a2a/<catalog-name>/.well-known/jwks.json` for the key. The catalog name is a URL path segment, and the handler throws at construction for a `publish` name that is not in the agent catalog.
- The card is projected from the catalog and the agent's definition: `name` (the display name, else the catalog name), `description`, `version` (the definition revision), the agent's skill descriptors as `skills` (or one skill standing for the agent), and the input and output modes. It carries no tools, no internal endpoint, no credential, and no capability the deployment does not serve; `securitySchemes` and `securityRequirements` describe the credentials the handler enforces and nothing more.
- The card is public, and every JSON-RPC request needs the handler's authentication (an API key resolved by `authentication.resolveApiKeyPrincipal`, or `unauthenticatedAccess: 'allow'` on a loopback host). A caller owns the tasks it creates, and another owner's task reads as missing.
- `publicUrl` needs a Bureau with a durable engine and a `retention.tasks` of at least the 24 hours a send's idempotency binding is kept, or construction throws. The Bureau's `id` must be explicit when storage persists.

**Methods.**

| Method | Served | Notes |
| --- | --- | --- |
| `SendMessage` | Yes | Always answers with a `Task`. Without `taskId` it admits a new run; with `taskId` it continues an open wait. Retry-safe on the caller, the agent, and `messageId`. |
| `SendStreamingMessage` | Yes | The same send, then a Server-Sent Events stream: the task first, then only later events, closing when the task is terminal. It stays open through `INPUT_REQUIRED`. |
| `GetTask` | Yes | The caller's task, with `historyLength` applied. |
| `ListTasks` | Yes | The caller's tasks with the mounted agent, filtered by `contextId`, `status`, and `statusTimestampAfter`, newest first, paginated. |
| `CancelTask` | Yes | Cancels a task that has not ended and answers once the task has stopped (up to five seconds; a task still stopping then is answered as it stands). Cleanup may still be pending when it returns; the cleanup extension reports it. |
| `SubscribeToTask` | Yes | Resumable with `Last-Event-ID` where the durable-history extension is declared. A terminal task answers `UnsupportedOperationError` (`-32004`). |
| `CreateTaskPushNotificationConfig`, `GetTaskPushNotificationConfig`, `ListTaskPushNotificationConfigs`, `DeleteTaskPushNotificationConfig` | Only where push is declared | Elsewhere each answers `PushNotificationNotSupportedError` (`-32003`), as does a send carrying `taskPushNotificationConfig`. |
| `GetExtendedAgentCard` | No | Answers `UnsupportedOperationError` (`-32004`); the card never declares `extendedAgentCard`. |

**Capabilities the card declares.** `streaming` is always `true`. `pushNotifications` is `true` only when `createBureauHandler` is given `pushNotifications` (Weft's outbox push sender and its outbox) and the Bureau keeps a durable event history, because a push notification is a projection of that history; the host drives delivery with `startPushDelivery` on the same outbox. `extendedAgentCard` is `false`. Every extension below is `required: false`, so a plain A2A client works without knowing any of them.

| Extension | Declared | What it adds |
| --- | --- | --- |
| Cleanup | Always | Reports whether a canceled task's cleanup finished, beside its terminal state. [Specification](../weft/documentation/a2a/extensions/cleanup-v1.md). |
| Durable history | Where the Bureau keeps a durable event history | Makes `SubscribeToTask` resumable from a cursor in `Last-Event-ID`. [Specification](../weft/documentation/a2a/extensions/durable-history-v1.md). |
| Command receipts | Always | The send's receipt and the task's revision, `expectedRevision` and `deadline` on a send, and a typed error for a reused `messageId`. [Specification](../weft/documentation/a2a/extensions/command-receipts-v1.md). |
| A2UI v0.9.1 | Always | Carries A2UI surfaces to a client that renders them. A human wait with an input schema projects its form as A2UI only for a request that activated the extension; every other read, stream, and push notification carries the prompt text alone. See [interactive surfaces](./documentation/interactive-surface.md#human-input-forms-cor-1487-and-cor-1309). |

**Content.** A message carries text, file, and data parts. A file part's `url` must be exactly this server's asset route, `<publicUrl>/assets/<id>/content`, naming an asset the caller owns and may read (`bureau.assets:read`); inline `raw` bytes are admitted as the caller's own asset (`bureau.assets:write`) and the task's history keeps the route, never the bytes. Any other address, and an asset that is another owner's, missing, expired or deleted, is `-32602` (the last four read alike), and a part whose media type the card does not advertise is `ContentTypeNotSupportedError` (`-32005`), before any model call. The card's `defaultInputModes` are `text/plain` and `application/json` plus the media types of the modalities the agent's backend descriptors take in, narrowed by the asset policy's `allowedMediaTypes`; a Bureau without an asset service advertises text and data only. Generated media leaves a completed task as file parts whose `url` is the authenticated asset route `<publicUrl>/assets/<id>/content`, never inline bytes, and a small generated JSON document is a data part; the card's `defaultOutputModes` follow the agent's backend descriptors. The shape mapping is [Conversationalist's A2A content mapping](../conversationalist/README.md#a2a-content-mapping).

**Not available.** Do not promise these to your own users:

- `GetExtendedAgentCard`, and any binding other than JSON-RPC (HTTP+JSON and gRPC).
- Delivery of `task.resynced` over push notifications and A2A streams. The Bureau appends the event to repair a failed durable append and `bureau.tasks.events` serves it, but push and the A2A stream do not yet deliver it (COR-1669 part 2b-3c).
- Authentication other than an API key, and the `bureau.deliveries.*` management operations.
- Wiring a human-input form from an agent file or the catalog (COR-1674). An author can configure `inputSchemas` on Operative's `requestHumanInput` tool today, and the form is projected to the A2UI data part the extension row describes.

**Worked example.** The consumer path end to end: discover the card, send, read the task, list tasks, stream, cancel, and meet an operation the deployment does not serve. It runs in [`src/a2a-guide.test.ts`](./src/a2a-guide.test.ts), which imports from `./index` instead of `@lostgradient/bureau` and keeps its body equal to this block, so the two cannot drift. The client is the official `@a2a-js/sdk` client with its requests routed to the handler in process; over a network it needs only the agent URL and the API key.

```typescript
import { type Message, Role, TaskState } from '@a2a-js/sdk';
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
} from '@a2a-js/sdk/client';
import { createBureau, createBureauHandler, createMemoryAssetStorage } from '@lostgradient/bureau';
import { createAgent, waitForCondition, type GenerateFunction } from '@lostgradient/operative';
import { principalFromApiKey } from '@lostgradient/weft';

const publicUrl = 'https://agents.example.com';

// Two agents. `summarizer` answers at once; `watcher` runs until somebody cancels it.
const summarize: GenerateFunction = async () => ({ content: 'Three findings.', toolCalls: [] });
const watch: GenerateFunction = ({ signal }) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('canceled')), { once: true });
  });
const bureau = await createBureau({
  id: 'acme', // required once the handler serves persistent storage
  agents: {
    summarizer: createAgent({
      name: 'summarizer',
      description: 'Summarizes a document.',
      generate: summarize,
    }),
    watcher: createAgent({ name: 'watcher', description: 'Watches a feed.', generate: watch }),
    private: createAgent({ name: 'private', generate: summarize }),
  },
  storage: { type: 'memory' },
  durable: true, // A2A needs a durable engine: every send creates its task through it
  assets: { storage: createMemoryAssetStorage() },
});

// The `publish` allowlist is the only thing that makes a code-defined agent visible. `private`
// is not on it, so it has no card and starts no task.
const handler = createBureauHandler(bureau, {
  publish: ['summarizer', 'watcher'],
  publicUrl, // mounts A2A at <publicUrl>/a2a/<name>
  authentication: {
    auditSink: () => undefined,
    resolveApiKeyPrincipal: async (key) =>
      key === 'alice-key' ? principalFromApiKey({ subject: 'alice', scopes: [] }) : null,
  },
});

// Discover: a card is public. Fetching it needs no credentials, and a withdrawn agent has none.
const cardUrl = `${publicUrl}/a2a/summarizer/.well-known/agent-card.json`;
const publicCard = await handler(new Request(cardUrl));
console.log(publicCard.status); // 200
const hiddenUrl = `${publicUrl}/a2a/private/.well-known/agent-card.json`;
const hiddenCard = await handler(new Request(hiddenUrl));
console.log(hiddenCard.status); // 404

// The consumer is the official A2A client, with its requests routed to the handler in process
// and the API key on each one. Over a network this is just `ClientFactory` with its defaults.
const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('X-API-Key', 'alice-key');
  return handler(new Request(input, { ...init, headers }));
}) as typeof fetch;
const factory = new ClientFactory(
  ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    transports: [new JsonRpcTransportFactory({ fetchImpl })],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
  }),
);
const summarizer = await factory.createFromUrl(`${publicUrl}/a2a/summarizer/`);
const card = await summarizer.getAgentCard();
console.log(card.capabilities?.streaming); // true
console.log(card.capabilities?.pushNotifications); // false: no outbox is composed
console.log(card.capabilities?.extendedAgentCard); // false

// Send: a message becomes a task. A Bureau send answers with a Task, never a bare Message.
const userMessage = (text: string): Message => ({
  messageId: crypto.randomUUID(), // a retry with the same id returns the original task
  contextId: '',
  taskId: '',
  role: Role.ROLE_USER,
  parts: [
    {
      content: { $case: 'text', value: text },
      metadata: undefined,
      filename: '',
      mediaType: 'text/plain',
    },
  ],
  metadata: undefined,
  extensions: [],
  referenceTaskIds: [],
});
const send = (text: string, returnImmediately: boolean) => ({
  tenant: '',
  message: userMessage(text),
  configuration: {
    acceptedOutputModes: [],
    taskPushNotificationConfig: undefined,
    returnImmediately, // false waits for the task to settle or stop for input
  },
  metadata: undefined,
});
const reply = await summarizer.sendMessage(send('Summarize the quarterly report.', false));
if (!('status' in reply)) throw new Error('a Bureau send answers with a task');
console.log(TaskState[reply.status?.state ?? 0]); // 'TASK_STATE_COMPLETED'
console.log(reply.artifacts[0]?.parts[0]?.content); // { $case: 'text', value: 'Three findings.' }

// Observe: read the task again, and list the caller's tasks with this agent.
const fetched = await summarizer.getTask({ tenant: '', id: reply.id });
console.log(TaskState[fetched.status?.state ?? 0]); // 'TASK_STATE_COMPLETED'
const listed = await summarizer.listTasks({
  tenant: '',
  contextId: '', // empty filters match everything
  status: TaskState.TASK_STATE_UNSPECIFIED, // no state filter
  pageToken: '',
  statusTimestampAfter: undefined,
});
console.log(listed.tasks.some((task) => task.id === reply.id)); // true

// Stream: the stream opens with the task, then carries only later events, and ends when the task
// is terminal. Dropping a stream never cancels the task.
const events: string[] = [];
for await (const event of summarizer.sendMessageStream(send('Again, as a stream.', false))) {
  const payload = event.payload;
  events.push(payload?.$case === 'statusUpdate' ? 'status' : (payload?.$case ?? 'none'));
}
console.log(events[0]); // 'task'

// Cancel: ask for a task that keeps running, wait for it to start, then cancel it.
const watcher = await factory.createFromUrl(`${publicUrl}/a2a/watcher/`);
const running = await watcher.sendMessage(send('Watch the feed.', true));
if (!('status' in running)) throw new Error('a Bureau send answers with a task');
await waitForCondition(() => bureau.tasks.detail(running.id)?.status === 'running', 'it never ran');
await watcher.cancelTask({ tenant: '', id: running.id, metadata: undefined });
await waitForCondition(async () => {
  const task = await watcher.getTask({ tenant: '', id: running.id });
  return task.status?.state === TaskState.TASK_STATE_CANCELED;
}, 'the task never read as canceled');
console.log('canceled'); // the task is terminal once the cancel settles

// An operation the deployment does not serve is an error, not a silent no-op.
const extended = await handler(
  new Request(`${publicUrl}/a2a/summarizer/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'alice-key',
      'a2a-version': '1.0',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetExtendedAgentCard', params: {} }),
  }),
);
console.log(((await extended.json()) as { error: { code: number } }).error.code); // -32004

await bureau.dispose();
```

**The outbound client.** Calling another A2A agent is a separate surface and is built (COR-905): Weft's `createA2APeerClient` from `@lostgradient/weft/a2a` reads and validates the peer's Agent Card, refuses a peer whose card requires an extension the client does not implement, applies an egress policy to every URL, retries transient failures, and cancels a task that outlives its timeout. Operative's `createPeerCallTool` wraps a client as a tool: the call is a child run in the parent's child registry with the peer's task identity, aborting it sends `CancelTask`, and a peer's reply is returned marked `untrusted: true`. By default the call is synchronous and persists nothing, so a restart of the caller does not resume it; pass `durable: bureau.peerCalls` and a durable run's call records the peer task it started, so the replay after a restart follows that task instead of sending again (COR-1670). Bureau does not call peers on its own; a host composes the tool into an agent's toolbox.

```typescript
import { createPeerCallTool } from '@lostgradient/operative';
import { createA2APeerClient } from '@lostgradient/weft/a2a';

const peer = createA2APeerClient({
  url: 'https://agents.example.com/a2a/summarizer/', // the card is read from .well-known/agent-card.json under it
  authenticate: async () => ({ 'X-API-Key': 'alice-key' }),
});

export const askSummarizer = createPeerCallTool({
  name: 'askSummarizer',
  description: 'Ask the remote summarizer agent to summarize a document.',
  peer,
});
```

Agents are built before the Bureau, so a durable tool reaches the journal through a reference set once the Bureau exists:

```typescript
import { createPeerCallTool } from '@lostgradient/operative';
import type { Bureau } from '@lostgradient/bureau';
import { createA2APeerClient } from '@lostgradient/weft/a2a';

declare const peer: ReturnType<typeof createA2APeerClient>;
let bureau: Bureau | undefined; // assigned from createBureau(...) once it resolves

export const askSummarizerDurably = createPeerCallTool({
  name: 'askSummarizer',
  description: 'Ask the remote summarizer agent to summarize a document.',
  peer,
  durable: {
    read: (key) => bureau!.peerCalls.read(key),
    write: (key, entry) => bureau!.peerCalls.write(key, entry),
  },
});
```

### Interactive surfaces (COR-1631)

`bureau.surfaces` keeps a task's interactive surfaces: an `input-form` (a JSON Schema form, the kind every host must render), an `a2ui` surface pinned to A2UI v0.9.1, or an `mcp-app`. Each surface belongs to its task, is owned by the task's owner, and changes only by compare-and-swap on its `revision`; every change is one event in the task's durable history, written in the same storage batch as the surface's state. `create`, `update`, `snapshot`, `close`, `abort`, and `cleanup` answer with typed receipts, `list` reads every surface of a task, and `act` admits or denies an action from a renderer and returns the continuation (`bureau.reviews.resolve` or `bureau.contexts.signal`) the caller runs. A task's surfaces freeze, still readable, when it is cancelled or ends, and are deleted with it. `bureau.surfaces` is `undefined` on a Bureau without persistent durable execution (`durable` over persistent storage), because surfaces live in the durable history the engine keeps. [`documentation/interactive-surface.md`](./documentation/interactive-surface.md) is the contract (`bureau.interactive-surface.v1`), with how A2UI, MCP Apps, and human-input forms map onto it and how it grows.

### MCP adapter (COR-839, COR-910)

`createBureauHandler(bureau, { mcp: {} })` mounts Bureau's `mcpExposable` management operations as MCP tools, at `/mcp` unless `mcp.pathPrefix` says otherwise. It is a thin wrapper over Weft's [`createOperationMcpMount`](../weft/README.md#mcp-for-an-operation-catalog), so it serves both protocol eras (2026-07-28 and 2025-11-25) statelessly, and every call runs through the catalog pipeline as the caller the handler authenticated: the same access policy, owner predicate, and scopes as `POST /jsonrpc`. A caller sees only what it could already read there. Omit `mcp` and nothing is mounted.

The target is an AI host that observes and steers existing work: Claude Desktop and Claude Code, over Streamable HTTP. Interborough mounts the adapter at `/bureau/mcp` (not `/mcp`, which is the engine's own endpoint) and its on-demand `smoke:claude-code-mcp` script connects a real Claude Code to it. Other hosts that speak Streamable HTTP MCP should work, but none is tested or supported.

Twenty-one operations are exposed, as tools of the same name:

| Area             | Tools                                                                |
| ---------------- | -------------------------------------------------------------------- |
| Tasks            | `bureau.tasks.list`, `get`, `events`, `inspect`, `respond`, `cancel` |
| Reviews          | `bureau.reviews.list`, `get`, `resolve`                              |
| Contexts         | `bureau.contexts.list`, `get`, `input`                               |
| Goals, schedules | `bureau.goals.list`, `get`; `bureau.schedules.list`, `get`           |
| Workflows        | `bureau.workflows.list`, `get`; `bureau.workflows.runs.list`, `get`  |
| Agents           | `bureau.agents.list`                                                 |

`bureau.tasks.events` is the one subscription: a call answers with the events recorded after its `fromCursor`, up to `maxEvents`, and the cursor to resume from, so a client polls it rather than holding a stream. `respond`, `cancel`, `resolve`, and `input` change state and carry the matching tool annotations. Nothing here starts a run, creates or edits a goal, schedule, or workflow, reads memory or assets, or touches agent definitions: those stay on the management plane, and `bureau.surfaces` commands have no MCP tool.

```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { createBureauHandler } from '@lostgradient/bureau';

// A handler created with `createBureauHandler(bureau, { authentication, mcp: {} })`.
declare const handler: ReturnType<typeof createBureauHandler>;

const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
  fetch: (url, init) => {
    const request = new Request(url, init);
    request.headers.set('X-API-Key', 'alice-key');
    return handler(request);
  },
});
const client = new Client({ name: 'review-desk', version: '1.0.0' });
await client.connect(transport);

// Find the reviews waiting for this caller, then approve the first one.
const pending = await client.callTool({ name: 'bureau.reviews.list', arguments: {} });
console.log(pending.structuredContent);
await client.callTool({
  name: 'bureau.reviews.resolve',
  arguments: { id: 'review-1', decision: 'approve' },
});
await client.close();
```

#### MCP Apps on the adapter

Two further options let an application publish MCP Apps beside the tools. `resources` injects `ui://` resources the server lists and reads, and `toolMeta` attaches `_meta` to a tool's listing by operation name. Both are injected because Bureau must not depend on an application's bundle: Interborough builds the pages and hands them in. Bureau adds no operation for an app; each page uses the tools above, as the signed-in caller.

| Resource | Linked tool | What it does |
| --- | --- | --- |
| `ui://bureau/run-inspector/v1` | `bureau.tasks.inspect` | One task's liveness, ownership tree, progress, result, and abort. Reads `bureau.tasks.inspect` (`bureau.task-inspection.v1`: no transcript, prompt, tool argument, result, or checkpoint) and aborts through `bureau.tasks.cancel`. |
| `ui://bureau/pending-review/v1` | `bureau.reviews.list` | The caller's pending reviews. Reads through `bureau.reviews.get` and decides through `bureau.reviews.resolve`: approve, deny, or reject with feedback, which `reject` carries as its `reason`. It sends the `round` it displayed, so a decision on a review that was re-gated meanwhile is refused as a `Conflict` instead of landing on the replacement. |

The inspector also follows a task through `bureau.tasks.events`. Both declare an empty content-security policy (no network origin, frame, or base URI) and no permissions, which a host reads as denied, and neither asks for a dedicated sandbox origin. The version is part of each URI: a changed contract is a new URI. Closing an app never cancels a run; abort is the explicit `bureau.tasks.cancel`. The MCP Apps contract Bureau uses for tracked surfaces, including the `mcp-app` representation, is [`documentation/interactive-surface.md`](./documentation/interactive-surface.md); the adapter's apps are plain tool-linked pages and do not create surfaces.

### Owner of record (COR-718)

Every resource has one **owner**: the principal that owns it, stored once when the resource is created. The **actor** is whoever performed an action, and is recorded on the audit entry's `principal`. A service principal (`system:scheduler`, `system:recovery`, `system:expiry`) is only ever an actor: work the scheduler, recovery, or expiry starts or changes keeps the owner of the resource it acts on.

An owner is a string. An API-key caller served by `createBureauHandler` owns as `api-key:<encodeURIComponent(subject)>`, and an in-process host states it with `CreateRunRequest.principal`, `DurableScheduleDefinition.principal`, or the goal request's `principal`. A host that states none owns as `anonymous:local` (`ANONYMOUS_LOCAL_OWNER`), and so does a record persisted before owners existed. That is a read rule, not a migration. A principal that is neither text nor absent is refused before anything is persisted: `BAD_REQUEST` from `tasks.start`, `createSchedule`, and `children.dispatch`, and the `invalid-configuration` rejection from `bureau.goals.create`. The `system:` and `anonymous:` namespaces never come from a credential.

`bureau.getOwner(resource)` reads an owner back. The kinds, and where each owner lives:

- **run** (an A2A task is a run): session metadata `lastRunOwningPrincipals`, rehydrated into the in-memory attribution after a restart, and `LivenessSnapshot.owner`.
- **session**: the owner of the run that created it, in the session's `sessionOwner` metadata. It is written once and never replaced, so it survives the pruning of `lastRunOwningPrincipals`. A different principal starting a run on the session (`tasks.start` throws `NOT_FOUND`), submitting session input, or reading its history gets the answer a session that does not exist gets.
- **child run**: its own child record, equal to its parent's owner.
- **goal**: the goal record's `principal`.
- **schedule**: `ScheduledAgentRunInput.principal`, written by `schedules.create`. A fire's run, and the session the fire creates, are owned by the schedule's owner; a fire into a recurring session another principal owns is refused as a session that was not found, but it is still recorded: its run keeps the schedule's owner and it writes its `schedule.fired` entry. Each fire records one `schedule.fired` audit entry with `principal: 'system:scheduler'`.
- **review**: its run's owner.
- **audit entry**: derived from its `runId`, never stored. A run id gives that run's owner, `schedule:<id>` the schedule's, and `session:<id>` (a `session.deleted` entry) the `owner` its `detail` records. Bureau writes that owner to its own store before it deletes the session and removes it once the audit entry is written, so the answer never reads the live session, which may be gone or recreated under another owner. An entry for a deletion that bypassed Bureau has no `detail.owner`, so its owner is undefined and only operator scopes can see it. A run reattached after a restart keeps its owner and records one `run.recovered` entry with `principal: 'system:recovery'`; an expired review keeps its run's owner and records `principal: 'system:expiry'`.

An in-process host must restate the session's owner on every later `tasks.start`: an omitted `principal` is a trusted call for children and goals, but for `tasks.start` it means `anonymous:local`, which is refused on a session another principal owns.

Session-scoped memory, transcripts, and events belong to their session or run. Agent-, skill-, and experience-scoped memory, delivery records, delegation grants, the steering log, the command ledger, session-input identity, asset upload sessions, and skills and proposals have no owner of record.

### Parent-child topology (COR-772)

`bureau.children.dispatch({ parentRunId, agentName, input, childRunId?, parentCancellation?, authority? })` starts a catalog agent as the child of a run Bureau already knows—a task, or another child—and writes the relationship to Bureau's key-value store before the child starts. The record carries the parent and child run identifiers, both agent names, the status, `createdAt`/`updatedAt`/`settledAt`/`reattachedAt` timestamps, and the child's workflow identity (`{ kind: 'durable', workflowType: 'agentRun', workflowId }` when the durable engine runs it, `{ kind: 'process-local' }` otherwise). Every later transition is a compare-and-swap on the record's revision, so a stale writer changes nothing, and supplying the same `childRunId` twice—even concurrently—returns `duplicate` instead of starting a second workflow. A `childRunId` becomes the child's durable run identifier, so one that already names another run or workflow Bureau knows is rejected as `child-run-id-conflict` before anything is reserved, recorded, or started; it can never take over that run's attribution, recovery record, or place in the topology. An identifier beginning `goal:`, `goal-`, or `bureau-goal-audit:` belongs to durable goals and is rejected as `reserved-child-run-id` (see [Durable goals](#durable-goals-cor-851)).

A parent is a task (its handle's `id`) or another child (its `childRunId`). A task's `id` is the id of its durable workflow from the moment `bureau.tasks.start` resolves, and children can be dispatched under it once `bureau.tasks.workflow(id)` returns the workflow. `bureau.tasks.workflows()` is not a way to find a parent: it lists every durable run newest first, including other callers' runs and every durable child. A task on a Bureau with no durable engine can own children too, but they are process-local. A child is durable—a Weft workflow recovery can reattach—when Bureau has a durable engine and the catalog agent supports definition resolution (every `createAgent` or `createLazyAgent` result does); otherwise it is process-local and dies with its process. For the cross-package contract, including what is unsupported, see [Multi-agent lifecycle and communication](../../documentation/multi-agent-lifecycle.md).

- **Addressing.** `list(parentRunId)`, `get`, `wait`, `signal`, and `cancel` all name the owning parent, and naming an unrelated parent reads as `not-found`. A child's record carries its parent's owner of record, which is `anonymous:local` for a parent started with no principal. `dispatch` compares the caller's principal with the parent's; `list`, `get`, `wait`, `signal`, and `cancel` compare it with the child record's. A mismatch reads as `not-found`, and omitting the principal is a trusted internal call. So under a parent without a principal, only `anonymous:local` (or a trusted call) can dispatch, and every child belongs to it.
- **Signals.** A child whose agent has a contract in `BureauOptions.children.signals` gets a typed COR-814 channel; `signal` resolves to `acknowledged` or the channel's typed rejection.
- **Parent cancellation.** A child never receives its parent's abort signal. `bureau.tasks.cancel` on a parent, aborting a parent through its own `TaskHandle`, or `children.cancel` on a child that is itself a parent applies each running child's `parentCancellation`: `'cascade'` (the default) cancels it and its own cascade children, `'detach'` leaves it running. From the moment its cancellation is requested, a parent admits no new child (`parent-terminal`), even while its own run still reads as running, so no child escapes a cascade that recovery would apply. A `children.cancel` that fails, or finds the child already finished, cancels nothing below it; a cascade the engine cannot perform is diagnosed, leaves that subtree running, and is retried when the parent settles. During `dispose()`, shutdown ends every live run itself, and boot recovery applies the policy to whatever it left running from the cancelled parent's durable state.
- **Recovery.** Boot recovery never starts a child workflow. A child whose workflow is still running is reattached (its signal channel reopened before the workflow resumes); one that finished while nobody was watching is recorded with its real outcome; a process-local child, or one whose workflow is missing, is recorded as failed. A child of a parent that was cancelled, or that cannot be recovered, follows its `parentCancellation`, with one exception: a child that holds a grant is cancelled when its parent cannot be recovered, even under `'detach'` (see **Delegation grants** below). Under an unrecoverable parent, only a `'detach'` child without a grant keeps running.
- **Audit.** When persistence is configured, `child.started`, `child.completed`, `child.failed`, `child.aborted`, and `child.reattached` are written to the audit trail under the child's run identifier, plus `delegation.revoked`/`delegation.rejected` on recovery. A dispatch rejected before the child's record is registered (`unknown-agent`, `parent-terminal`, `child-run-id-conflict`, `reserved-child-run-id`, `delegation-invalid`, `depth-exhausted`, `authority-exceeded`, or `budget-exhausted`) returns its outcome to the caller and writes no audit entry. `start-failed` is decided after registration: it writes `child.started` and `child.failed` and leaves a `'failed'` record, so a retry with the same `childRunId` returns `duplicate`.
- **Delegation grants.** Without `BureauOptions.children.delegation`, a dispatch's `authority` is ignored, not rejected: it is not validated, no grant is issued, nothing is budgeted, and depth, fan-out, and capabilities are unbounded. With it, each dispatch issues a signed `DelegationGrant` (`@lostgradient/operative`), attenuated from the parent's own grant, and reserves `concurrentChildren`/`totalDescendants` in a durable reserve/release ledger keyed by dispatch attempt, so an attempt that loses a registration race releases only its own reservation. A request for more depth, budget, or capability than the parent's grant allows is rejected, never clamped; a requested `delegatedAuthority` is intersected with the parent's instead. A top-level parent (a task) holds no grant, so its dispatches are neither checked against a grant nor budgeted, and its own fan-out is unbounded. There, `authority` sets the child's ceilings as given rather than narrowing them, and an omitted capability list or budget ceiling is unrestricted. `authority.depth` defaults to `0` under a top-level parent and to the parent's `depth - 1` below it, so pass `depth` on the top-level dispatch to allow grandchildren. Recovery re-verifies each running child's grant (signature, expiry, revocation) and reconciles its ledger before reattaching it; a child whose parent cannot be recovered has its grant revoked on recovery and is cancelled, whatever its `parentCancellation`.

Expected results are values, not exceptions. Malformed input (an empty identifier, an unknown `parentCancellation`, invalid agent input, or an invalid `authority` when delegation is configured) throws `BureauError` with `BAD_REQUEST`, and a failure of the underlying key-value store rejects the returned promise.

| Operation | Resolves |
| --- | --- |
| `dispatch(request)` | `started` (with the record and, with delegation, a `grant` summary), `duplicate`, `not-found`, or `rejected` with `code` `unknown-agent`, `parent-terminal`, `child-run-id-conflict`, `reserved-child-run-id`, `delegation-invalid`, `depth-exhausted`, `authority-exceeded`, `budget-exhausted`, or `start-failed` |
| `list(parentRunId, { principal? })` | Every `BureauChildRecord` under that parent the principal may see; `[]` for an unknown parent |
| `get(reference)` | The record, or `undefined` |
| `wait(reference, { signal? })` | `settled`, `not-found`, `wait-aborted`, or `unobservable` (still running, but nothing in this process is watching it) |
| `signal({ ...reference, name, payload })` | `acknowledged` (`signalId`, `sequence`), `rejected` (the channel's `code`, `reason`, `delivered`), `not-found`, `child-terminal`, or `unsupported` (`no-signal-contract` or `child-not-live`) |
| `cancel({ ...reference, reason? })` | `requested`, `already-terminal`, `not-found`, or `failed` |

The public types are `BureauChildren` (the `bureau.children` surface); `BureauChildrenOptions` (`BureauOptions.children`) and `BureauChildDelegationOptions` (its `delegation` field); the requests `BureauChildDispatchRequest`, `BureauChildAuthorityRequest` (`authority`), `BureauChildReference`, `BureauChildSignalRequest`, and `BureauChildCancelRequest`; the outcomes `BureauChildDispatchOutcome` (with `BureauChildDispatchRejection` codes and a `BureauChildGrantSummary`), `BureauChildWaitOutcome`, `BureauChildSignalOutcome`, and `BureauChildCancelOutcome`; and the record types `BureauChildRecord`, `BureauChildStatus`, `BureauChildTerminalStatus`, `BureauChildOutcome`, `BureauChildParentCancellation`, and `BureauChildWorkflowIdentity`. `CHILD_AGENT_RUN_WORKFLOW_TYPE` (`'agentRun'`) is the `workflowType` a durable child's record names.

A child's `status` is `'completed'` when its run ends with `finishReason: 'stop-condition'`, `'aborted'` when it ends aborted, and `'failed'` for every other finish reason; `outcome.finishReason` keeps the original. A parent that finishes normally does not stop its children—they keep running and stay addressable through its identifier—but it admits no new child.

A grant's summary carries `grantId`, `policyVersion`, `depth`, `expiresAt`, and `artifactDigest` (present when the input is a conversation), plus `budget` only under a `'full'` `disclosurePolicy`; the default is `'redacted'`. The stored grant is always complete. `timeToLiveMilliseconds` defaults to `children.delegation.defaultTimeToLiveMilliseconds` (one hour), and a child's `expiresAt` never outlives its parent's. Bureau enforces the signature, revocation, expiry, `depth`, `concurrentChildren`, and `totalDescendants`. It signs and attenuates the capability lists, the grant's `delegatedAuthority`, and the `steps`, `tokens`, `cost`, `toolCalls`, and `duration` ceilings, but does not apply them to the running child. Expiry and revocation are checked when a descendant is dispatched and during recovery; neither stops a child already running. There is no public revoke operation. Rotating `children.delegation.secret` invalidates every existing grant.

```typescript
import { createBureau, type Bureau } from '@lostgradient/bureau';
import type { StandaloneAgent } from '@lostgradient/operative';

declare const planner: StandaloneAgent;
declare const delegationSecret: string;
declare function durableRunId(
  bureau: Bureau<{ planner: StandaloneAgent }>,
  task: { readonly id: string },
): Promise<string>;

// `planner` is a long-running `createAgent` agent, `delegationSecret` comes
// from the host's secret store (and must not change across restarts), and
// `durableRunId` waits until `bureau.tasks.workflow(root.id)` finds the
// task's workflow, and returns `root.id` (see the
// multi-agent guide's durable example).
const bureau = await createBureau({
  agents: { planner },
  storage: { type: 'sqlite', path: 'bureau.sqlite' },
  children: { delegation: { secret: delegationSecret } },
});

const root = await bureau.tasks.start('planner', 'Plan the corvid report');
const parentRunId = await durableRunId(bureau, root);

const lead = await bureau.children.dispatch({
  parentRunId,
  agentName: 'planner',
  input: 'Lead the research',
  childRunId: 'lead',
  authority: {
    depth: 1,
    budget: { concurrentChildren: 1 },
    capabilities: { tools: ['search'] },
  },
});
// { outcome: 'started', child, grant: { grantId, policyVersion: 'bureau-delegation/1', depth: 1, expiresAt } }

const helper = await bureau.children.dispatch({
  parentRunId: 'lead',
  agentName: 'planner',
  input: 'Collect sources',
  childRunId: 'helper',
});
// { outcome: 'started', grant: { depth: 0, ... } } — attenuated from lead's grant

const widened = await bureau.children.dispatch({
  parentRunId: 'lead',
  agentName: 'planner',
  input: 'Run a shell command',
  authority: { capabilities: { tools: ['shell'] } },
});
// { outcome: 'rejected', code: 'authority-exceeded' }

const secondHelper = await bureau.children.dispatch({
  parentRunId: 'lead',
  agentName: 'planner',
  input: 'Collect more sources',
});
// { outcome: 'rejected', code: 'budget-exhausted' } — lead allows one concurrent child

const grandchild = await bureau.children.dispatch({
  parentRunId: 'helper',
  agentName: 'planner',
  input: 'Go one level deeper',
});
// { outcome: 'rejected', code: 'depth-exhausted' }

root.abort('report planned');
await bureau.children.wait({ parentRunId: 'lead', childRunId: 'helper' });
await bureau.dispose();
```

`src/bureau-children-guide.test.ts` runs this example, and the lifecycle example in the [multi-agent guide](../../documentation/multi-agent-lifecycle.md#durable-example), asserting each commented result. Aborting `root` cascades to `lead` and then to `helper`, because both use the default `'cascade'` policy.

Not supported: observing a child's signal `events` (Bureau only sends signals; a child's `emit` buffers until it is refused as `buffer-full`), replaying signals that were unacknowledged when a process died, messaging between siblings or any peer (communication is parent-mediated only, per COR-807), and recovering a process-local child, which recovery records as `'failed'`. Bureau children are not registered in the parent `AgentRun`'s `ChildRunRegistry`, so the parent's `children()` and `closed()` do not see them.

### Durable goals (COR-851)

`bureau.goals` runs one goal across attempts and keeps it across a process restart. An attempt is one durable run of a catalog agent, followed by one validator execution that decides whether the goal is met; the attempt is the retry unit, and the decisions (when to retry, when a budget is spent, which terminal reason a goal ends with) are the same ones the in-memory `startGoal` controller makes, because both call the same pure functions.

```ts
import { createBureau } from '@lostgradient/bureau';
import type { StandaloneAgent, Validator } from '@lostgradient/operative';

declare const worker: StandaloneAgent;
declare const testsPass: Validator;

const bureau = await createBureau({
  agents: { worker },
  validators: [testsPass], // identity: { name: 'tests-pass', version: '1' }
  storage: { type: 'sqlite', path: './bureau.sqlite' },
  durable: true,
});

const created = await bureau.goals.create({
  agentName: 'worker',
  prompt: 'Make the failing tests pass.',
  identity: { name: 'fix-tests', version: '1' },
  validator: { name: 'tests-pass', version: '1' },
  bounds: { maximumAttempts: 3, maximumTotalDurationMs: 600_000 },
  retryPolicy: { retryOn: ['validator-fail-retryable'] },
  goalRunId: 'fix-tests-1',
});
// { outcome: 'created', goal, controller: { status: 'started' } }

await bureau.goals.active('fix-tests-1'); // { kind: 'attempt', runId: 'goal-fix-tests-1-a0', ... }
await bureau.goals.cancel('fix-tests-1'); // { outcome: 'canceled', goal }
```

Three things hold a goal together. Its record (`GoalState`, in Bureau's key-value store) is the truth: every transition is a revision compare-and-swap, and a controller transition carries a sequence number and an id, so a replayed or duplicated commit is recognized and a late one is refused. Its controller is a Weft workflow named `goalRun`, one per goal under the id `goal:<goalRunId>`, which Weft's workflow lease fences to a single engine; it holds no state of its own and re-reads the record before every decision. Each attempt is a durable run under the deterministic id `goal-<goalRunId>-a<n>`, so a restart that repeats a start finds the run instead of starting another.

Those ids, the goal's sessions (`goal-<goalRunId>-s<n>`), and the workflow-shaped id its audit events are recorded under (`bureau-goal-audit:<goalRunId>`) are the goal's alone. Weft deletes every event carrying a workflow's id when it purges that workflow, so an ordinary run that merely shared an id with a goal's audit trail would erase the trail when it was purged, and checking ownership at the point of use cannot prevent that. Every id an ordinary caller chooses is therefore refused when it begins `goal:`, `goal-`, or `bureau-goal-audit:`: a child run's `childRunId` is rejected as `reserved-child-run-id`, and a `contextId` given to `tasks.start`, or a `sessionId` given to `createSchedule`, throws `BureauError` `BAD_REQUEST` with a message starting `reserved-identifier:`. A `childRunId` is also refused when it begins `run:`, `session:`, or `schedule:`, the ids durable event history records those owners under, because a child's workflow id is its run id and purging the child would erase the owner's history. A goal's own starts build these ids themselves and never pass through that admission; the host-level operate-by-id APIs carry no principal by design and are host-trusted, so a host that forwards a user-supplied id to one of them is responsible for authorizing it. That covers the operators (`bureau.tasks.cancel`, `bureau.contexts.delete`) and the readers (`bureau.tasks.detail`, `workflow`, `snapshot`, `events`, `bureau.reviews.get`, and the run event feeds keyed by run id), and a goal's attempt run id (`goal-<goalRunId>-a<n>`) is guessable from the goal id where an ordinary run's is random; the ownership checks stay as defence in depth for a store something else wrote. A schedule persisted before this reservation existed whose session id begins with one of the three prefixes is not migrated: each of its fires is refused as `unavailable` and logs why, so such a schedule must be re-registered under another session id.

`create` writes the record before it starts the controller, and refuses before writing anything when the agent is unknown or cannot run durably, when the validator is not registered at that exact name and version (`validator-missing`, `validator-version-mismatch`), when the budget, retry policy, or objective breaks COR-638's rules, when the conversation policy is invalid or, for `fresh-from-artifact`, its handoff artifact fails COR-894's validation (`invalid-configuration`, which includes `resolveFreshAttemptSource` being unable to vouch for the artifact's source run), or when the goal id cannot name what a goal is made of (`invalid-goal-run-id`: a control character, a lone UTF-16 surrogate, or an id so long that a signal derived from it would pass Weft's 128-byte limit and never be delivered). A goal that requires deterministic validation but names a stochastic validator ends `failed` with `unsupported-validation` before any controller starts; that check also runs wherever a controller is about to be started for a goal nothing has run yet, so a process that died between recording the goal and ending it does not run attempts for it. Passing the same `goalRunId` with the same request answers `existing`, and for a goal that has not ended also makes sure its controller exists, which is how a `create` that died between recording the goal and starting the controller is healed by repeating it. A repeat of a `fresh-from-artifact` goal's request after its artifact's retention window has closed still answers `existing`: the artifact checks that depend on the time they run decide only a goal that is not already stored. A different request under the id answers `conflict`, and carries the stored goal only for a caller who may read it: another principal learns that the id is taken and nothing else.

`cancel` is an answer about durable state, not about a request having been sent. It writes a cancellation marker to the record first (after which the store accepts no transition but `canceled`), wakes the controller, cancels the controller's workflow, stops the attempt's run, commits `canceled` from the host, and then reads everything back once. Each outcome means exactly this:

- `canceled`: the fresh read found the goal record `canceled`, the controller's workflow terminal, its finalizer `succeeded` or not owed (a goal controller declares a finalizer that stops the attempt's run after a hard cancel, so a cancelled controller owes one unless it ended without ever reaching a decision point, or ended on its own as `completed` or `failed`), and the attempt's run terminal or absent. Nothing else is answered `canceled`.
- `cancellation-pending`: the marker is durable, so the goal will end `canceled` and nothing can overtake it, but the read found something unfinished, and `awaiting` names every such thing: `goal-record`, `controller`, `finalizer` (pending, running, or its status could not be read), `attempt-run`, `durable-engine`, or `finalizer-failed`. `durable-engine` is a bureau with no durable engine (`durable: false` over a store that still holds goals): it can record the marker and the commit but can neither stop nor read the controller, its finalizer, or the attempt's run, so it never claims a workflow-level acknowledgement and stays pending until a bureau with an engine settles it. The first four are in progress, so call `cancel` or `recover` again: under the default `workflow-lease` ownership the engine runs a cancelled controller's finalizer in the background, so a `cancel` that has just hard-cancelled a running goal commonly answers `cancellation-pending` awaiting `finalizer`, and the next `cancel` answers `canceled` once it has run. `finalizer-failed` is different: the engine retried the finalizer, gave up, and recorded the failure, so asking again re-reads the same failure. It is written to the diagnostics with the engine's error, and the goal is never reported `canceled` while it stands, because whatever the finalizer was to stop may still be running. The failure is permanent: Weft retries a finalizer 8 times with backoff and then dead-letters it, so once that has happened `cancel` answers `finalizer-failed` every time, even when Bureau's own step (stopping the attempt's run) has already succeeded and nothing is running. Bureau has no way to re-drive a dead-lettered finalizer, so an operator does not wait or call `cancel` again. Read the engine's error in the diagnostics to learn why the abort kept failing, then check the attempt's run yourself with the durable engine's `cancel('goal-<goalRunId>-a<n>')` (`bureau.durableEngine()`; idempotent for a run that has ended) and treat the goal as settled by hand once the run is terminal; the goal record is already `canceled`, so only the read-back answer stays `finalizer-failed`.
- `record-unreadable`: a record is stored under the id but cannot be decoded, which is a fault to repair and not absence (`close` and `create` answer the same way; `get` and `list` still treat the record as absent).
- `already-terminal`, `contended`, `not-found`: respectively, the goal ended for a reason other than cancellation and nothing was changed; the marker lost its compare-and-swap every time the store retried, so nothing was recorded and nothing will cancel the goal (call again); and there is no such goal, or one the principal does not own.

A goal whose record already says `canceled` is not finished by that alone: calling `cancel` again stops what is still running and reads back again, so a retry after `cancellation-pending` answers `canceled` once the world agrees, and `already-terminal` is only for a goal that ended for another reason. A start that is in flight when the cancellation lands cannot escape it: an attempt's start does not answer until its workflow exists, refuses to start for a goal whose marker is already there, and stops the run it just created if the marker appeared while it was starting. A validator that is executing when the goal is canceled is not told to stop (durable validation runs under a signal that never aborts, because shutdown is a crash for the next process to recover, not a verdict); it runs to completion and its verdict is discarded. Mailbox and Outbox settlement are not part of this: a goal is a workflow plus a child run, so the acknowledgement is the workflow's own, and remote-activity ledger cancellation is out of scope.

`recover` (also run once at boot, after Weft resumes workflows; with a `principal` and no id it sweeps only the goals that principal may see) makes the world agree with each unfinished goal's record. It starts a controller that was never started, restarts one that ended abnormally from the record (up to `MAXIMUM_CONTROLLER_RESTARTS`, counted in the record's `controllerRestarts` by a compare-and-swap on the count the recovery read, so of several recoveries that saw the same ended controller exactly one restarts it, after which the goal is reported `unrecoverable` and left as it is), completes a cancellation whose marker was written but never acted on (a suspended controller whose cancellation was marked is cancelled rather than resumed, since a resumed one would park again on a signal the marker never sends; reporting `cancellation-pending` rather than `canceled` when a run it could not stop still reads as running), and reconciles the attempt a running goal is waiting on: an attempt whose run already ended has its signal sent again under a stable id, one still running gets a forwarder, and one that never started is started. A goal interrupted by shutdown is deliberately left unfinished for the next process; its attempt's run is not aborted by `shutdown()`.

The boot sweep also runs on a bureau with no durable engine (`durable: false` over a store that still holds goals): it can commit a recorded cancellation but can read nothing back, so that goal is reported `cancellation-pending` awaiting `durable-engine`, and every other unfinished goal is reported `unrecoverable` (there is no engine to run its controller), so an engine-less boot over a store that holds unfinished goals is `partial`. A controller that ended abnormally but whose restart cannot happen yet (its finalizer is still owed or could not be read, or its teardown is pending) is reported `restart-pending`: it has no controller and nothing retries it, so `recover` again does. Every entry of the sweep that is stuck rather than in progress is a per-run failure of `waitForRecovery()` (`outcome: 'partial'`), not a clean boot: `unrecoverable` (including a record that cannot be decoded, and a goal whose audit log has no room to record a restart), `restart-pending`, `cleanup-pending`, an `attempt` of `failed`, and a `cancellation-pending` awaiting `finalizer-failed` or `durable-engine`. A running or suspended controller under a recorded cancellation is always ended and its cancellation completed from the host, never signalled and waited for: a live controller may sit inside an activity (a validator, a start) that no signal reaches.

Recovery starts, resumes, and restarts nothing once the bureau is shutting down, and spends no restart on it. Such a goal is reported `shutting-down`, which is not a failure: nothing is wrong, the next boot recovers it. A closed goal that still owes its checkpoint cleanup is reported `shutting-down` too, not `already-terminal`, because its pruning was not started.

A goal that ended while an attempt's start could still be in flight may have a run its ending overtook: a start Weft timed out that keeps running in the background, the host's own recovery start, or a process that died after the engine started the run and before the start's own stand-down check stopped it. Those goals are `canceled`, `exhausted`, and `failed` because an attempt's start failed (`attempt-run-failed` with a start-failure detail), and they stay in the boot sweep until closed and cleaned up: the sweep and `recover(id)` stop the run they find, and `close` does it first, so a closed goal never strands one. A run that cannot be stopped, or cannot be looked for because the bureau has no durable engine, is reported `cleanup-pending`, which is a failure of `waitForRecovery()` (`partial`), and leaves the goal open. An engine-less bureau therefore never closes such a goal, as it never closes a `canceled` one: with no engine it cannot tell that no run was left, so the goal waits for a bureau that has one.

Stopping a run that exists cannot reach a start that has claimed its attempt's run but not yet created it, and no check from outside can: the engine's start takes no precondition on the claim, so there is no transaction across the two. So before it looks for a run, `cancel`, the sweep, `recover(id)`, and `close` tombstone the attempt's claim, by compare-and-swap from the claim's exact bytes or, where none exists, by creating a tombstoned one. A start that claims afterwards finds the tombstone and starts nothing. A run that was already past its claim carries a fence: before every step it reads the goal and its own claim, and it takes no step when the goal is over, the claim is tombstoned, or either cannot be read. The fence also enforces one invariant that closes the class of late starts, acknowledged-only runs: a goal attempt's run takes no agent step until the goal's record shows that attempt opened as running (the attempt at the run's index names the run's id, is `running`, is the last attempt, and is the goal's active work), which is the controller's open-attempt commit after the start settles. A start that Weft timed out, or that a crash or a failed controller stranded, can create its run long after anyone could adopt or stop it, and such a run is never acknowledged, so it never steps. In the ordinary window between the engine's start and that commit the run waits instead of stopping, polling the record with the fence's abortable backoff for at most the start activity's own bound (`START_ATTEMPT_MAXIMUM_TRIES` tries of `START_ATTEMPT_TIMEOUT_MS`, or what remains of the goal's aggregate duration if that is less); when the budget runs out, or the goal ends or is marked, or the claim is tombstoned, it takes zero steps. The wait does not hold the controller up, because the commit follows the start's return and waits on nothing the run does, and a controller that crashes after the start returned replays the recorded start and commits while the resumed run waits for it. A read that fails is tried five times, backing off on the runtime's clock for a few seconds, and a step is never taken on an unknown; the same verdict cancels the step's context compaction, which can reach a model before the step's own preparation reaches the fence. Recovery also tombstones these claims when it gives up on a goal's controller, and no tombstone is created for an attempt index at or past `maximumAttempts`, which no start can use. Such a run ends with the finish reason `tripwire` and zero agent steps, and no `onError` hook can retry or skip that. The most a start the goal's ending overtook can leave is a workflow that ended after zero steps under the attempt's deterministic id, which is pruned with the rest of the goal's history at `close`. A claim that cannot be tombstoned leaves the goal open: `cleanup-pending` for an ended goal, and `cancellation-pending` awaiting `attempt-run` for a canceled one.

Each attempt is its own durable run under its deterministic id; what carries a conversation from one attempt to the next is the goal's session in the bureau's `SessionStore`, so all three COR-638 conversation policies hold across a restart. The session ids are deterministic too (`goal-<goalRunId>-s<n>`), and every attempt's run is recorded in its session as one `RunRef` keyed by the attempt's run id. The turn an attempt receives is `goalAttemptInput` from operative, the same function the in-memory controller uses: attempt 0 runs the prompt as written, so the agent's own instructions frame it.

- `continue`: every attempt runs in one session, `goal-<goalRunId>-s0`. A retry is seeded with that session's history and its turn is the validator's feedback alone, appended as the next user message, so the transcript really carries over.
- `fork-from-baseline`: attempt 0 runs in `s0` and every retry runs in a new session `s<n>` forked from `s0` through the goal-declared `throughRun`, never from the last attempt. Its turn is the prompt followed by the feedback. A retry therefore sees the baseline transcript and nothing a later attempt added. A durable goal has no session before its first attempt, so the only run a retry can fork through is run 0 (the first attempt); `goals.create` rejects any other `throughRun` as `invalid-configuration` rather than let a goal spend an attempt before it could never retry.
- `fresh-from-artifact`: attempt 0 runs in `s0` and every retry starts a brand-new session `s<n>` from the goal's `instructions` and the validated handoff artifact (`createFreshAttemptSession`), then its turn is the prompt. It inherits no transcript. The artifact is validated at `create` and again before each retry that consumes it (so the retention window is measured when it is used). Because nothing in Bureau can vouch for an artifact's producing run, `BureauOptions.resolveFreshAttemptSource` supplies that, as `SessionHandleContext.resolveFreshAttemptSource` does; without it a `fresh-from-artifact` goal is refused at `create`.

A retry's seed is `{ conversation }` handed to the catalog agent, which snapshots it, and it is stored in the run's recovery record, so a recovered run resumes from the same seed. Starting an attempt is: adopt the run if its workflow exists; otherwise seat it (commit the previous attempt's transcript from the engine's checkpoint with operative's `reconcileTerminalRunRef`, which also writes the conversation boundary a fork reads; create the fork or fresh session if absent; build the seed), start it, and record its `RunRef`. Each step is safe to repeat. A crash between creating a fork or fresh session and starting the run finds that session on the next try instead of making a second; a crash between claiming the run and starting its workflow re-derives an equivalent seed and starts the claim once; a crash between the workflow's start and the session write is completed by the adopt path, which upserts the one `RunRef`. The user turn is not written to the session until the attempt's transcript is committed, and the forwarder commits that transcript before it tells the controller the attempt ended, so the next attempt always finds it. A transcript is not committed for an attempt that ends after its goal was canceled or ended. A goal's sessions record its `principal` as their authority, so another principal cannot read or continue the transcript through the session verbs. A durable goal does not accept a caller's existing session as its baseline. The validator is the same `Validator` interface as in memory and receives a `RunResult` rebuilt from the attempt's checkpoint. A validator can run twice if the process dies while it executes, and only the first committed decision counts, so a validator should be safe to run again. Validation evidence is stored inline, projected to JSON and capped at 64 KiB per attempt (an oversized outcome keeps its verdict and replaces each evidence detail with its size). The objective is capped at 64 KiB and refused above it.

A goal's audit events are recorded in the durable event history under a `goal` owner: `goal.started`, `goal.attempt.started`, `goal.attempt.validated`, the terminal `goal.succeeded`, `goal.exhausted`, `goal.failed`, and `goal.canceled`, and the durable-only `goal.recovered` for each controller restart. They are derived from the committed record and recorded idempotently under the key `<goalRunId>:<transitionSeq>`, so a replayed commit adds nothing. Events carry ids, names, statuses, reasons, and a digest of validator feedback; never evidence, raw feedback, the objective, or an error's `cause`. Reading them follows the goal: a `principal` that does not own the goal reads `not-found`, and omitting it is a trusted call. The owner is stored as `bureau-goal-audit:<goalRunId>` rather than `goal:<goalRunId>`, because `goal:<goalRunId>` is the controller's workflow id and Weft deletes every event carrying a workflow's id when it purges that workflow, which would erase the history when a restart replaces the controller. Every transition (and every counted controller restart) appends an entry to the goal record's append-only `auditLog` in the same compare-and-swap commit, holding the already-derived, JSON-safe events it implies. Boot replays the whole log idempotently, so a projection that failed is repaired whenever it was committed, even after later transitions: no audit event is permanently lost, and a repaired event is appended after the ones recorded since, carrying its own commit's timestamp. The log is bounded because attempts are: a durable goal's `maximumAttempts` is capped at 256 (`GOAL_MAXIMUM_ATTEMPTS`), and the log at `4 * 256 + 8` entries; the store refuses a write that would pass the cap rather than drop an entry. The record's `schemaVersion` is now 2 with no migration (the template is pre-release), so a version-1 record reads as corrupt.

`close` is for a goal that has ended. It sets `closedAt` once and answers with the truthful cleanup acknowledgement for the checkpoint history of the controller workflow and of every attempt's run under the bureau's `retention.checkpoints`, the least favorable of them: `not-required` when the policy keeps everything or the goal never had a workflow, `completed` once pruned, `unresolved` or `failed` when any could not be. Attempt histories are pruned here, not as each attempt ends, because the goal reads an ended attempt's checkpoint until it is terminal. Calling it again retries the cleanup. A `canceled` goal is closed only once the same read-back `cancel` answers from finds its controller, finalizer, and attempt run ended: until then `close` answers `cancellation-pending` with `awaiting` and leaves `closedAt` unset, because a closed goal leaves the boot sweep and nothing would be left to finish it.

Not supported: `retry-now`, pause and resume, goals on an ephemeral bureau (`create` answers `durable-unavailable`), and the Bureau test harness's `startManagedGoal`.

### Multimodal content and managed assets

Bureau carries images, audio, video, documents, and files as **managed assets**: bytes that Bureau's asset service admitted, inspected, and now owns, referenced everywhere else by a `{ kind: 'managed-asset', assetId, revision? }` content source. This section is the map and the contract in one place: which package documents each surface, how an asset moves through its lifecycle, a worked example that runs as a test, and what is not supported. It links to the detailed sections instead of repeating them; the as-built wire contract is [`documentation/external-control-plane.md`](./documentation/external-control-plane.md#assets).

**Where each surface is documented.**

| Surface | What it carries | Documentation |
| --- | --- | --- |
| Content vocabulary | `ContentSource`, `Modality`, `MediaLimits`, the portable parts and their A2A mapping | [Conversationalist](../conversationalist/README.md#a2a-content-mapping), `src/multi-modal.ts` |
| Tool results | `toolContent(parts, { value })` from a native tool, and MCP content blocks both ways | [Armorer README](../armorer/README.md) ("Text and media parts") and [MCP](../armorer/documentation/mcp.md) |
| Agent input | An ordered list of parts, the admission invariant, safety verdicts, selection, and cost | [Operative: Media input](../operative/README.md#media-input-cor-716), [Bureau: Media input](#media-input-cor-716) |
| Model output | Response `parts`, streamed parts, and generated media admitted before anything sees it | [Operative: Response parts](../operative/README.md#response-parts-and-generated-media-cor-713), [Bureau: Generated media](#generated-media-cor-713) |
| Management plane | `bureau.assets.uploads.create`, `append`, `complete`, `bureau.assets.get`, and `GET /assets/{assetId}/content` | [External control plane](./documentation/external-control-plane.md#assets) |
| AG-UI | A user row's `file` parts, the `bureau.asset-part` events, and `UNSUPPORTED_MEDIA_TYPE` | [The AG-UI mount](#the-ag-ui-mount-cor-855) ("Multimodal content") |
| A2A | Inbound text, file, and data parts, outbound file parts on the asset route, and the card's input and output modes | [A2A](#a2a) ("Content") |

**The asset lifecycle.** An asset is admitted from bounded inline bytes, a completed upload, an authorized URL, a provider file identifier, or an existing asset, and `admit` answers at once with the asset's identity while the rest of the admission runs as started work (`work.result()` settles as `completed`, `failed` with the rejection, or `aborted`, and never throws). It starts `pending` and settles `available`, `rejected` (for example `media-type-mismatch`), or `quarantined` (a safety gate flagged it); later it can be `expired` or `deleted`. Only an `available` asset resolves. Each asset has one owner, the principal that admitted it, and a monotonic revision. A row that references an asset claims it, so retention cannot expire one a persisted row names. Events and audit records never carry bytes, secrets, or signed URLs.

**Authority.** Three boundaries hold on every surface. An asset is the owner's: another principal's read, a guessed identifier, an expired asset, and a deleted asset all read as missing, with nothing that tells them apart. A scope (`bureau.assets:read`, `bureau.assets:write`) gates who may ask and never grants access across owners. And the route `GET /assets/{assetId}/content` is an address, not a credential: it needs the same authentication as every other call and is never a signed URL.

**Setup.** Media needs `assets` on `createBureau` (a storage, and optionally a `policy` of limits, an allowed media-type list, and retention). Without it, Bureau refuses media input, the Agent Card advertises text and data only, and `createBureauHandler` throws at construction. What an agent can take or give is its backend descriptors, not a guess: a function with no descriptor is a text-only agent, and none of the shipped catalog rows advertises media output, so generated media comes from a backend you describe.

**Worked example.** The path end to end: admit an asset, run an agent on it, receive generated media as an asset, read it back as its owner, and fetch it over the asset route as the owner and as someone else. It runs in [`src/multimodal-guide.test.ts`](./src/multimodal-guide.test.ts), which imports from `./index` instead of `@lostgradient/bureau` and keeps its body equal to this block, so the two cannot drift. [`src/http/a2a-ag-ui-contract.test.ts`](./src/http/a2a-ag-ui-contract.test.ts) pins the A2A and AG-UI views of one multimodal exchange.

```typescript
import { createBureau, createBureauHandler, createMemoryAssetStorage } from '@lostgradient/bureau';
import {
  createAgent,
  createModelCatalog,
  withBackendDescriptors,
  type GenerateFunction,
} from '@lostgradient/operative';
import { principalFromApiKey } from '@lostgradient/weft';

// A backend's descriptor says which media it takes in and gives out. Bureau admits only what a
// descriptor advertises, so a function with no descriptor is a text-only agent.
const visionBackends = createModelCatalog().descriptors.filter(
  (descriptor) => descriptor.provider === 'anthropic',
);
const drawingBackends = visionBackends.map((descriptor) => ({
  ...descriptor,
  modalities: {
    ...descriptor.modalities,
    image: { ...descriptor.modalities.image, output: true },
  },
}));

// The viewer reads an image. The painter answers with one: a 1x1 PNG standing in for the bytes
// a model returns.
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const pixel = Uint8Array.from(atob(png), (character) => character.charCodeAt(0));
const view: GenerateFunction = async ({ conversation }) => {
  const kinds = conversation
    .getMessages()
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .map((part) => part.type);
  return { content: `I received: ${kinds.join(', ')}`, toolCalls: [] };
};
const paint: GenerateFunction = async () => ({
  content: 'Here it is.',
  parts: [
    { type: 'text', text: 'Here it is.' },
    {
      type: 'image',
      mimeType: 'image/png',
      source: { kind: 'inline', encoding: 'base64', data: png },
    },
  ],
  toolCalls: [],
});
const bureau = await createBureau({
  agents: {
    viewer: createAgent({
      name: 'viewer',
      generate: withBackendDescriptors(view, visionBackends),
    }),
    painter: createAgent({
      name: 'painter',
      generate: withBackendDescriptors(paint, drawingBackends),
    }),
  },
  // The asset service is what makes media possible: without `assets`, Bureau refuses media input
  // and has nowhere to put generated media.
  assets: { storage: createMemoryAssetStorage() },
});

// Admit: bytes become an asset the principal owns. `admit` answers at once with the asset's
// identity, and `work.result()` waits for inspection and the safety gates to settle it, as a
// value (`completed`, `failed` with the rejection, or `aborted`) and never a throw. The id is the
// one the handler derives from an API key whose subject is `alice`.
const alice = { id: 'api-key:alice' };
const admission = await bureau.assets!.admit(
  { source: { kind: 'inline', bytes: pixel }, declaredMediaType: 'image/png' },
  alice,
);
const settled = await admission.work.result();
if (settled.outcome !== 'completed') throw new Error('the asset was not admitted');
console.log(settled.value.state, settled.value.mediaType); // 'available' 'image/png'

// Input: a run takes an ordered list of parts. The asset travels as a reference, never as bytes.
const viewing = await bureau.tasks.start(
  'viewer',
  [
    { type: 'text', text: 'What is in this picture?' },
    { type: 'image', mimeType: 'image/png', source: admission.source },
  ],
  { principal: alice.id },
);
const seen = await viewing.result();
console.log(seen.content); // 'I received: text, image'

// Output: media a model generates is admitted as the run's owner before anything sees it, so the
// result holds a reference to an asset, and the bytes are read back through the asset service.
const painting = await bureau.tasks.start('painter', 'Draw a pixel.', { principal: alice.id });
const painted = await painting.result();
const image = painted.parts.find((part) => part.type === 'image');
if (image?.source.kind !== 'managed-asset') throw new Error('generated media is an asset');
console.log(image.source.kind); // 'managed-asset'
const owned = await bureau.assets!.resolve(image.source, alice);
console.log(owned.content.kind === 'bytes' && owned.content.bytes.byteLength > 0); // true

// Authority: the owner reads the asset, and anybody else is told it does not exist.
const bob = { id: 'api-key:bob' };
const refusal = await bureau.assets!.resolve(image.source, bob).catch((error: unknown) => error);
console.log(refusal instanceof Error); // true

// Wire: over HTTP the bytes come from the authenticated asset route, as the credential's owner.
const keys: Record<string, string> = { 'alice-key': 'alice', 'bob-key': 'bob' };
const handler = createBureauHandler(bureau, {
  authentication: {
    auditSink: () => undefined,
    resolveApiKeyPrincipal: async (key) =>
      keys[key] === undefined
        ? null
        : principalFromApiKey({ subject: keys[key], scopes: ['bureau.assets:read'] }),
  },
});
const route = `http://localhost/assets/${admission.assetId}/content`;
const fetched = await handler(new Request(route, { headers: { 'X-API-Key': 'alice-key' } }));
console.log(fetched.status, fetched.headers.get('Content-Type')); // 200 'image/png'
const other = await handler(new Request(route, { headers: { 'X-API-Key': 'bob-key' } }));
console.log(other.status); // 404: another owner's asset reads as missing

await bureau.dispose();
```

**Not supported, and pending.** Do not promise these to your own users.

- **Media the backend does not advertise.** An unadvertised modality, source form, MIME family, or limit is refused before any provider call (`MediaAdmissionError`; `UNSUPPORTED_MEDIA_TYPE` over AG-UI, `-32005` over A2A). Bureau does no silent OCR, captioning, extraction, or transcoding to make a part fit.
- **Remote URLs** are deny-by-default: an A2A file part is accepted only on this server's own asset route or as inline bytes, and a URL admitted as an asset needs an asset policy that authorizes it.
- **The MCP adapter** does not read assets or carry media. Its tools are the observe-and-steer set; upload and read stay on the management plane. A tool's own result can carry MCP content blocks ([Armorer MCP](../armorer/documentation/mcp.md)); Bureau does not project them through its adapter.
- **Asset deletion and upload abort** are not served on the management plane: an upload that is never completed expires, and aborting one is for the embedding host through `AssetService`.
- **One protocol's private blocks** do not appear on another. A2UI surfaces, AG-UI `CUSTOM` events, and MCP Apps stay on their protocol.
- **An unreferenced asset** (a step admitted it and then no persisted row named it) stays `available` until the policy's default retention expires it; no reconciliation runs. [Generated media](#generated-media-cor-713) lists each path.
- **An ambiguous ledger claim** on an inbound A2A send can delete assets an exact retry then expects: when the claim write commits but its response is lost, the discard runs without checking. [COR-1680](https://linear.app/lost-gradient/issue/COR-1680) tracks it.
- **Not goals of this project:** an OpenAI-compatible endpoint, an MCP Apps renderer, arbitrary public asset URLs, one hard-coded object-storage vendor, treating validated JSON output as conversational media, and a host's own upload interface.

### Generated media (COR-713)

Media a model generates leaves the provider boundary as a managed asset, never as inline bytes. When `assets` is configured, every run carries a `RunOptions.generatedMediaAdmitter` built by `createAssetGeneratedMediaAdmitter(assets, principalId)`: it admits the part's bytes through `AssetService.admit` (or `admitAll` for one response's parts, which applies the policy's aggregate limits across them; a streaming wrapper admits each part on its own, so the single-part call fails closed with a `GeneratedMediaNotAdmittedError` when the policy has an aggregate limit for the part's media type, and streamed generation of a type therefore requires that type to have no aggregate limit) as the run's owner of record (the same principal rules as `contentSourceResolver`), with the service's `inline` provenance, and a part an agent supplies its own admitter for keeps that one. Operative admits each media part right after `generate` returns, before any hook, event, row or persisted result sees it, so `RunResult.parts`, `StepResult.parts`, the committed row, the run events, the run-envelope frames and the persisted workflow result carry a `managed-asset` reference. The asset is the owner's: no other principal can read it. The policy's ceilings (`maxInlineBytes`, `maxAssetBytes`, the media-type allow list) and the safety gates refuse an oversized, disallowed or flagged part as a failed admission, which ends the run with `finishReason: 'error'` and a `GeneratedMediaNotAdmittedError` naming the part. A cancellation aborts the pending admission through the run's signal, and the asset service settles an aborted pending record as `rejected` with code `aborted`, so no descriptor stays `pending`. A Bureau with no asset service has no port, and a generated media part fails the same way (`reason: 'no-admitter'`).

A row's claim on the assets it references belongs to the session that holds the row. Every managed-asset reference in a row counts, user or assistant, supplied or generated, and each is claimed with the asset service's own reference mechanism (`retain`) under the holder `session-row:<session id>:<incarnation>:<row id>` (the incarnation keeps a session recreated under a deleted one's id from sharing, or releasing, its claims), with no end date, so the policy's retention floor cannot expire an asset a persisted row references. A step's committed row is claimed as it commits, and every other way a row enters a session's history (a supplied `appendMessages` row, a goal retry under `fork-from-baseline`, a session fork) is a session commit that the session outbox drain replays, which claims the rows it finds before it acknowledges the entry (a claim that fails leaves the entry pending for the next drain, and a Bureau with no asset service skips the claim and the read behind it); a row copied into another session is claimed there under that session's own holder, so deleting either session leaves the other's claim alone. Deleting a session releases its claims right after the store removes it, and an expiring session releases them when its `session.deleted` entry drains. A catalog dispatch with no session (a child, a goal attempt, or a workflow step; a task always has a context) keys its claims by run id (`run-row:<run id>:<row id>`), and Bureau releases them when the run ends (COR-1630): the claims do not lapse by themselves, so a run that ended and let go of nothing would keep every asset it touched for ever. An end is a run that completes, fails (by a failure finish reason, or by an engine failure), is canceled (`tasks.cancel`, a parent's cancellation of a child, a goal that closes over an attempt, a workflow instance that cancels a step), or fails before its first step because its seeding claim failed (whatever it had claimed is released), and a run recovered after a restart ends in any of those ways too. Only the pairs actually held are released: for each managed asset referenced by any row of the run's final conversation (read from the handle's result, or from the durable checkpoint before cleanup can prune it), Bureau reads the asset's privileged `retention.references` and calls `release` only where `run-row:<run id>:<row id>` is among them, as the run's owner. An asset the run never claimed, such as one in an earlier seeded row (only the last seeded row is claimed), gets no `release` call and so no `asset.released` event; an asset another holder also claims (a session that holds the same row, another run) stays claimed by that holder; an asset whose inspect or release fails as not found, access denied or unavailable is skipped, and any other failure is a `warn` diagnostic naming the run, the row and the asset, with the other assets still released. A conversation that cannot be read releases nothing and is a `warn` diagnostic naming the run. The rule is that a run that has durably ended releases and a run that will resume does not, shutdown or not. A child run that `dispose` aborts (the default `abort` policy cancels its durable workflow for good) has ended, and so has one that completed while a `drain` shutdown waited for it, so both release; Bureau awaits the releases under way, bounded by the grace it gives aborted runs, before the asset service closes, and a release that starts after that does nothing and raises no diagnostic. A run whose durable record still reads running or suspended when `dispose` returns (a goal attempt, a workflow step or a recovered run that `dispose` leaves in flight) is lost, not ended: it releases nothing at shutdown, resumes at the next boot and releases when it ends there. A durable record that cannot be read counts as still going and is a `warn` diagnostic naming the run. A run this process lost to another engine over the same store releases nothing either, because the engine that owns it releases when it ends there. A run parked on a human wait or a wakeup has not ended. The catalog dispatcher releases a fresh child or workflow step; the catalog-run settlement hook releases a recovered run, including a recovered goal attempt whose goal is already terminal, canceled or gone, which no forwarder will see; and the goal forwarder releases an attempt of a goal that goes on, but only after the goal's session holds the attempt's rows (it takes the session's `session-row` claims first, and keeps the attempt's claims, with a `warn`, if that fails), so the next attempt's seed is never left unclaimed. Releasing is idempotent per run, row and asset. A run that was claimed before this release existed, or that ended in a process that died before it could release, keeps its claims as they were: nothing releases them at boot. Every catalog dispatch is such a run (a child, a goal attempt, a workflow step), registered with the run store or not, and it claims both the rows it commits and the input row it is seeded with (Operative's `retainSeededInput`, called on the durable workflow and the in-process loop alike, and only for a run with no session: a session run's input is claimed by its commit, and a claim made at seed time would end the run before its first step where the drain retries), so a supplied image survives the retention floor while the run is in flight. Once the run ends, the assets its result, task artifact, child record or goal attempt references expire on the policy's retention floor unless something else claims them. A session fork keeps its source's owner, so its rows are claimed as an owner who can read them. `run.closed()` waits for every admission the run started: `completed` once each has settled, `unresolved` with `unknown-effect` for one whose outcome cannot be confirmed, and `unresolved` with `timed-out` when the caller's signal aborts first. Run frames follow: `assistant-final` is emitted for any step with parts (a thinking block and a tool call has no text and still gets one), carries `parts` and the committed row's `messageId`, and the terminal `RunReport` carries the run-wide `parts` (run-envelope schema version 4). `RunDetail.stepDetails` carries each step's `parts` and `messageId`. A child's persisted outcome carries `parts` too, so the child record is at schema version 2; a version 1 record fails a direct read with `UnsupportedChildRecordVersionError`, and a list (the recovery pass) skips it and reports it through `diagnose`, so the other children still recover. A claim the drain can never make does not hold back every session's events: an asset whose stored record is corrupt (JSON that does not parse, or a record lacking a member the service reads) fails with `AssetRecordCorruptError`, the one failure the drain treats as permanent. It is reported once as an `error` diagnostic naming the session, the row and the asset, remembered with the claims already taken so a later save neither retries nor reports it again for the life of the process, and the entry is acknowledged once every failed claim in it is permanent; any other failure (a backend error, `AssetConflictError`, `AssetServiceClosedError`, `AssetStorageCapacityError`) leaves the entry pending for the next drain, and a restart replays it before it is acknowledged. A reference the asset service reports as not found, unavailable or access-denied is skipped quietly, except for a session that records no owner (it is claimed as the local principal, which cannot see another principal's asset), where the skip is a `warn` diagnostic. A record counts as corrupt when its JSON does not parse, a member the service reads is missing or has the wrong type, a date it parses (`retainUntil`, a reference's `until`) is not a date, or its `assetId` names another asset than the key it is stored under; the error names the member, never the record. A corrupt record must be repaired before the asset can be claimed, inspected or resolved, and because the collection pass reads every record, one corrupt record halts the whole pass (no asset expires anywhere) until it is repaired. The remembered skip lasts for the life of the process, and the entry that skipped it is already acknowledged, so a restart alone does not claim a repaired record: it is claimed again only by a later `retain` of it, or by the session's next save after a restart.

Claims whose release path never ran are reconciled from the asset side (COR-1664). `AssetService.heldClaims({ holderPrefix })` reads the asset records and reports each claim with its owner, and boot (after durable recovery, beside the caller) and every durable maintenance pass use it to release two kinds. A `run-row:` claim is released when its run is durably terminal (completed, failed or canceled): that covers a process that died between the terminal commit and the release, for which no settlement is published again. A run still in flight keeps every claim, because it resumes; a run with no durable record, or one whose record cannot be read, keeps them and is warned about once; a goal attempt of a goal that goes on is left to the goal forwarder, which claims for the goal's session first. A `session-row:` claim is released when its session, or that incarnation of it, no longer exists. Two cases are also handled where they arise. When history compaction replaced rows of a run's conversation, the rows it removed are no longer in the checkpoint, so the run's end releases the run's whole holder prefix from the asset side (only for a conversation holding a compaction summary, because the lookup reads every asset record). And a claim pass for a session loads the session again after claiming and, if it was deleted meanwhile, releases the incarnation's claims by prefix, so a goal hand-over or an outbox drain holding a snapshot loaded before the delete leaves nothing behind. Releasing a holder that is not present is a no-op that emits no `asset.released` event.

Known limit: a step that admits an asset and then does not reference it in a persisted row leaves that asset `available` and unreferenced until the policy's default retention expires it. Every one of these paths ends there: a crash between admission and the step record (a durable step runs whole inside one memo, so the step re-runs and generates again; if the crash came after the row's claim, the first asset keeps that claim under the re-run row's holder and is kept, unreferenced, until it is released explicitly, because no session row names it), an `afterGenerate` hook that returns `content` without `parts`, a `validateResponse` redaction or an output guardrail's rewrite, a parts mismatch or validation retry after admission, a retried stream whose failed attempt had already admitted a completed part, and a sibling admission that is rejected while another part is already `available`. None references a missing asset and none loses data; no reconciliation runs.

### Media input (COR-716)

A run's input can be an ordered list of user-admissible text and media parts, not only a string: `bureau.tasks.start(name, parts)` (a non-empty list that passes the content schema, or a `BAD_REQUEST` rejection), a child dispatched through `children.dispatch` (its grant binds the list by a digest over the parts as submitted, including each media part's source reference, with objective `content-parts`), a `bureau.contexts.input` payload, and the `input` of `createSchedule`. A `contexts.input` payload is still text unless it carries parts.

- **Resolving assets.** When `assets` is configured, every run resolves a `managed-asset` part through `AssetService.resolve` as the run's owner of record (the request principal, the session's owner on a recovery, the schedule's owner on a fire). Bureau-held bytes reach the provider as inline base64, a provider-fetch declaration as its URL; the stored message keeps the asset id and revision. An asset the owner may not read, one that is not `available`, and a source kind Bureau holds no bytes for (`upload`, `local-file`, `a2a-reference`, and `mcp-resource` unless `mcpResources` is configured) fail the step with a `MediaAdmissionError` before any provider call. `mcpResources` (COR-1634) is a host-supplied reader, `(resource, { principalId, signal }) => Promise<{ data, encoding, mimeType? } | undefined>`: Bureau holds no MCP connections, so it asks the host that connected the server for the linked resource's contents each time a row holding the link goes to a provider, as the run's principal, and sends them as inline bytes with an `unknown` safety state. The stored row keeps only the link. Only a tool result introduces an `mcp-resource` part: a run input, a `bureau.contexts.input` payload and a schedule's `input` are refused with `BAD_REQUEST` when they carry one. The reader still has to authorize the principal, the server and the URI on every call, and it is called again at every step that sends the row (there is no cache). `createMcpResourceContentSourceResolver(reader, principalId)` builds that resolver for a Bureau with a reader and no asset service. `createAssetContentSourceResolver(assets, principalId)` builds the same resolver for a host that composes runs itself.
- **Recovery.** A durable catalog run's recovery record accepts a part-array input (it stays at `schemaVersion` 1: readers and writers ship together and the widening is additive), and a recovered run gets the same resolver and unverified-asset policy as a fresh one, resolving as its recorded principal. The asset service is built before the scheduler can fire, so a fire never finds it missing.
- **Safety.** The resolver reports `clean` when every safety gate cleared the asset, `flagged` when any did not, and `unknown` when none inspected it (always the case for a provider-fetch URL). A flagged asset is always refused. The input guardrail's `assetSafety: { unknown: 'block' }` (in `guardrails.input`) refuses unverified assets, including ones a `beforeGenerate` handler adds.
- **Selection.** A selection gate built by `createSelectionGateFor` receives the step's media at each `revalidate`, using the source form each part takes once resolved, so a run whose backend cannot accept it fails with a `SelectionRevalidationError` instead of a provider error. `PlanSelectionRequest.inputMedia` does the same for `models.plan`.
- **Caller-owned input.** `bureau.tasks.start`, a child dispatch, `bureau.contexts.input`, and `schedules.create` copy the parts they validated before their first await and persist the copy, so a caller editing its array after the call returns cannot change what was validated.
- **Persisted input.** A stored session input carries `schemaVersion` (`CURRENT_SCHEMA_VERSION` of `conversationalist`). The mailbox reader refuses any other value with `error:unsupported-schema-version`, and `bureau.contexts.input` refuses a payload that fails the content schema (or an empty list) with `BAD_REQUEST` instead of admitting input no run could read. A schedule's input is checked the same way when it is registered. An unpinned `managed-asset` in a schedule's input (no `revision`) resolves to the asset's latest revision at each fire, not the one current when the schedule was created; pin a `revision` to fix it.

### Session commit outbox (AB-389)

`SessionStore.save()`, `update()`, and `delete()` (`@lostgradient/operative`) no longer dispatch `SessionCreatedEvent`/`SessionSavedEvent`/`SessionDeletedEvent` directly—that fire-and-forget dispatch, immediately after each commit but not transactionally coupled to it, was a known limitation (AB-384, PR #592): a crash between a commit succeeding and its listener's write running lost the fact forever, and two `SessionStore` instances sharing one persistent backend could record events out of true commit order. Each commit now appends a `SessionOutboxEntry`—payload, incarnation, and the store's own monotonically increasing commit ordinal—to the SAME atomic batch as the write it describes, and dispatches only a best-effort `SessionOutboxAppendedEvent` drain trigger. `cleanup()` appends the same way (COR-718): one `session.deleted` entry per expired session, consecutive ordinals, one trigger naming the last.

`drainOutbox` (`create-bureau.ts`) is the ONE place those entries are replayed as the real events, in ordinal order: it reads `sessionStore.outbox.pending()` and, for each entry, first calls `sessionStore.outbox.claim(ordinal, { owner, until })` (AB-390)—a compare-and-swap on the entry's own `claim` field, keyed by this bureau instance's own drain-owner id (minted once via `RuntimeServices.identifiers.next()`) and `RuntimeServices.clock.now()`. Only a WON claim proceeds to dispatch the matching event onto the bureau-level emitter (isolated in its own try/catch—a throwing `bureau.toObservable()` subscriber is diagnosed and skipped, never allowed to leave the reserved lowest-ordinal entry permanently un-acknowledged and starve every later fact behind it); a claim that fails (a different, still-unexpired owner holds it) stops the WHOLE pass at that entry rather than skipping ahead to a later ordinal, preserving true commit order across drainers. After dispatch, it awaits `DurableEventProducer.waitForActiveWrites(owner)` for the durable write that dispatch triggers, then verifies the write actually SUCCEEDED—`waitForActiveWrites` resolving proves only that it settled—via `eventHistoryInstance.wasRecorded(owner, kind, dedupeKey)` (an O(1) storage read, skipped only when no durable event history is configured) and, for a `session.deleted` entry specifically, via a read-your-writes `auditTrail.query({ runId })` against the out-of-band audit record (skipped only when no KV persistence is configured)—and only once every configured verification passes does it call `sessionStore.outbox.acknowledge(ordinal, owner)`, which itself re-verifies this same owner still holds the claim before removing the entry. A failed verification, or a lost claim at acknowledge time, leaves the entry pending for a later drain to retry, rather than discarding it. Three drivers call this same function: the post-commit `SessionOutboxAppendedEvent` trigger (promptness only—tracked via `RuntimeServices.deferred`, so a test can `await runtime.deferred.drain()` for it deterministically), `runDurableMaintenance()` and the automatic run-ownership-pruning timer (both "on the runtime clock inside the durable maintenance pass"—the timer's own pending pass is awaited, and the pass's chained drain settles, BEFORE `shutdown()` aborts the durable event producer's signal, so a drain still in flight when disposal begins can still durably record what it dispatches), and `recoverDurableRuns()` (boot recovery, so a crash between a commit and its own drain is caught up before this bureau serves reads)—plus an authority-independent catch-up pass that runs unconditionally at the very start of boot, even when durable run reattachment itself is deferred pending a request-authority validator attachment. It is single-flighted per bureau instance—a caller invoking it while a drain is already running gets the SAME promise, and a join landing exactly as that drain is about to complete forces one more full pass before the promise resolves, so the post-commit trigger and an overlapping maintenance tick never both drain the same pending entry from within one process, and no join is ever silently dropped at the completion edge. A lost claim schedules its own retry (a single-slot timer, never more than one outstanding) armed at the CURRENT winning claim's own `until`—read directly off `outbox.claim()`'s own result, never off the pass's earlier `pending()` snapshot, which a peer's intervening `claim()` call could already have made stale—so a KV-only or manual-maintenance bureau still recovers an entry once the blocking lease expires, rather than waiting on an unrelated future trigger. Shutdown clears that retry timer and, because a timer whose callback already started running before the clear cannot be un-fired, also awaits any drain already in flight (whether from that retry or any other driver) before the durable event producer's signal is aborted.

`performDeleteSession` additionally calls `drainOutbox()` directly, right after `sessionStore.delete()` commits and gated on that call having actually removed a live record—"immediately after each commit" for the one call site that can know synchronously that its own commit just happened, so a caller awaiting `bureau.contexts.delete()` observes the durable `session.deleted` record without needing to wait for the next trigger or maintenance tick.

**Claim lease across processes (AB-390):** the AB-389 residual—`pending()`/`acknowledge()` claiming nothing exclusively across bureau PROCESSES sharing one persistent backend—is closed by the claim described above. The maintenance-timer and boot-recovery drains no longer both dispatch the same still-unacknowledged entry: whichever process's `claim()` wins the compare-and-swap proceeds; the other's `claim()` fails and its pass stops there, picking the entry back up on a later tick once the current claim either acknowledges it or its lease lapses. A drainer that crashes between winning a claim and acknowledging leaves the entry claimed but undelivered only until its own lease's `until` passes—a later drain (this same process's next tick, or a peer's) reclaims and completes it exactly once, closing the AB-389 residual where `audit-trail.ts`'s `session.deleted` listener and a direct `bureau.addEventListener('session.deleted', ...)` consumer could each see a replay twice.

Two follow-on mechanisms close gaps a fixed lease alone would leave open (Codex P1 review findings, PR #599). First, a renewal timer runs for the ENTIRE stretch between winning a claim and acknowledging—the durable-write wait, `wasRecorded`, and the audit-trail read-your-writes query have no upper bound under real backpressure, so a claim taken once, before any of that, could otherwise lapse mid-wait and let a peer reclaim and dispatch the SAME entry again before this drainer ever discovers the loss. Second, when `claim()` loses to a still-live peer, this bureau arms a single-slot timer at that peer's own known `claim.until` (read directly off the `pending()` snapshot) rather than depending on whichever unrelated trigger happens to fire next—a KV-only or manual-maintenance bureau with no other commits arriving would otherwise have no way to notice the blocking claim expired. The drain-owner id itself is minted from `RuntimeServices.identifiers.next()` plus `crypto.randomUUID()`, not the runtime sequence alone—two independently constructed manual/deterministic runtimes with the same `identifierSeed` are documented to intentionally mint identical sequences (exact reproduction is the point of that seam), which would otherwise let two real bureau processes collide on the same drain-owner value and treat each other's claims as same-owner renewal.

### Review-transition audit records ride the outbox (AB-391)

`bureau.reviews.resolve`'s approve/deny/reject decisions, and the `reviewResolutionCleanupPending` retry path for a decision whose session-store commit previously failed, used to write their durable `review.<kind>.<approved|denied|rejected>` audit record via a SEPARATE, fire-and-forget `AuditTrail.record()` call AFTER the session-store commit (`persistReviewResolution`) that marks the review resolved. A crash between the two lost the audit record forever: the session commit already marks the review resolved, so nothing ever retries the write.

`SessionStore.update()` (`@lostgradient/operative`) now accepts an `options.outbox` list of `{ namespace, payload }` attachments, appended as `SessionOutboxEntry` values of kind `'session.attachment'` in the SAME `conditionalBatch` as the update's own body/summary/outbox-ordinal writes, at the ordinals immediately following the update's own `session.created`/`session.saved` entry. `persistReviewResolution` passes the pending decision's audit payload (`{ runId, type, detail, principal }`—exactly `AuditTrail.record()`'s own input shape) under the `'audit-record'` namespace. `drainOutbox` (generalized from `drainSessionOutbox`, which drained only session-lifecycle entries) replays a `session.attachment` entry into the real audit trail via `AuditTrail.record()`, stamped with the entry's own `committedAtMs` so a delayed replay never misdates the record, and verifies the write against the audit trail (by `runId`/`type`/`timestampMs`/`detail` identity) BEFORE acknowledging—the only idempotency guard here, since `record()` always mints a fresh key and a duplicate replay would otherwise produce a second, distinct record rather than a no-op. `bureau.reviews.resolve` calls `drainOutbox()` itself immediately after the resolution commit succeeds—the durable outbox entry (and the eventual audit record it names) is never lost regardless, but WHEN it becomes visible to an immediate `getReview(id)` depends on how many Bureau instances share this outbox (Codex P2 review finding, PR #601, "Ensure the new attachment is drained before returning"): `drainOutboxPass` stops the whole pass at the first still-claimed earlier ordinal rather than skipping ahead (see the claim-ordering doc comment above), so if a PEER instance currently holds the claim on an earlier entry, this call's own `drainOutbox()` can resolve normally without ever reaching THIS resolution's own attachment—`auditAlreadyAppended` is still correctly `true` (the coupled commit did land) and skipping the direct write is still correct, but the record is not yet audit-trail-visible. In that case (or in a single-instance deployment with nothing else contending for the outbox, where this is never observable) the record becomes visible on the peer's own drain, this bureau's next maintenance tick, or the claim's expiry-triggered retry—eventually consistent, not immediate. Verifying THIS SPECIFIC attachment synchronously would need `SessionStore.update()` to return the ordinal it assigned the attachment, which it does not today—tracked as a follow-up rather than solved in this pass.

This coupling covers exactly the transitions the fix targets—a review's terminal decision. `expired` (the expiry sweep), `revoked`/`canceled` (`revokePendingApprovalsForRun`), and `superseded` (`bureau.reviews.resolve`'s tool-approval re-gate branch) have no preceding session-store commit to couple to (the first two never persist a session-store write on that path at all; `superseded`'s own preceding commit, `persistPendingApprovalOverrideWithRetry`, writes the REPLACEMENT approval, and bundling the superseded review's own audit payload—which embeds its now-revoked ORIGINAL approval token—into that same batch would put both tokens in one commit, a real behavioral difference, not just an implementation detail)—all three keep writing their audit record directly, exactly as before.

`SessionStore.update({ outbox })` is explicitly session-agnostic (any caller can append any `namespace`), so `drainOutboxPass` checks a `session.attachment` entry's namespace BEFORE claiming it: an unrecognized namespace is left pending and, critically, never claimed at all—claiming an entry this bureau will never acknowledge would only extend its lease on every maintenance tick (a same-owner `claim()` renews an existing lease), starving a different consumer that DOES recognize the namespace. `SessionStore.outbox`'s own contract requires replay exactly once, in ordinal order—a store-wide ordinal, never a per-session one—so an unrecognized namespace stops the WHOLE pass right there (Codex P1 review finding, PR #601, "Stop before later ordinals when an attachment is unknown") rather than draining a later, recognized ordinal first, which would reorder past a fact a different consumer has not replayed yet. A later trigger—this process's own next tick, or a peer's—gets a fresh look at it. A payload under this bureau's OWN `'audit-record'` namespace that fails shape validation is a different case—there is no future version of that namespace to defer to, so it is diagnosed and acknowledged without replay, same as always. The attachment replay's idempotency is `AuditTrail.record`'s own `dedupeKey` (Codex review finding, PR #601, "Make attachment replay deduplication atomic")—`session.attachment:<sessionId>:<ordinal>`—mirroring `durable-event-history.ts`'s own `dedupeKey` (see above): an atomic storage-level compare-and-swap, not a read-before-write existence query, so two Bureau processes both reclaiming this entry after a claim-lease renewal race can never both durably write it, and the write stays correct regardless of how much unrelated history shares the same `runId`/`type` (a read-scoped-by-`AuditTrail.query()`'s-default-`limit` check would not). `record()` rejects on a genuine storage failure when `dedupeKey` is supplied—unlike its default best-effort path—so `drainOutboxAttachmentEntry` leaves a failed write's entry claimed-but-unacknowledged for a later drain to retry rather than losing it. `bureau.reviews.resolve` and the cleanup-retry path both isolate this post-commit drain call in its own try/catch (Codex review finding, PR #601, "Isolate post-commit drain failures from review resolution"): a transient drain failure diagnoses and leaves the attachment pending, but never prevents the already-succeeded resolution from returning its result or dispatching its live event. `persistReviewResolution` reports whether its `sessionStore.update()` call actually committed (Codex review finding, PR #601, "Detect when the resolution update appends nothing")—`false` when the session vanished concurrently (the updater then returns `undefined`, appending neither the resolution nor the audit attachment)—so `recordReviewDecision` falls back to its own direct write instead of wrongly assuming the coupled write already covered it. Finally, `persistReviewResolution`'s own updater guards against an AMBIGUOUS commit failure (Codex P1 review finding, PR #601, "Avoid reattaching audits after an ambiguous commit")—the fault-engine's own `fail-after-commit` boundary names exactly this: `conditionalBatch` durably commits the resolution and its coupled attachment, but the call back still rejects (a lost acknowledgement). Retrying blindly (either `persistReviewResolutionWithRetry`'s own in-loop retry, or a wholly separate later call from the `reviewResolutionCleanupPending` path) would call `persistReviewResolution` again, which unconditionally appends ANOTHER `session.attachment` entry at a fresh ordinal—a distinct `dedupeKey` from the one the ambiguous attempt already committed, so the same decision would be recorded twice once both drained, even though the `dedupeKey` mechanism correctly prevents either individual entry from being replayed on its own. So the updater itself detects this on every attempt: if `reviewId` is already present in the CAS-fresh session's `resolvedReviewIds`, some earlier commit already durably landed this exact decision, and the updater returns `undefined`—`sessionStore.update()` never calls `commit()` at all, appending nothing more—while `persistReviewResolution` still reports success. Every write in this file—the action-stream listener, every out-of-band `record()` call (ordinary or `dedupeKey`-guarded), and the retention summary—now commits through the SAME `attemptKeyFencedWrite` helper (Codex P1 review finding, PR #601, "Fence ordinary writes against deduplicated audit keys"): a not-exists `conditionalBatch` precondition on the derived audit key itself, with a bounded fresh-sequence retry on collision, so a plain unconditional `kv.set` can never silently overwrite a record a DIFFERENT writer (dedupe-guarded or ordinary) already committed at the same key—which, for a `dedupeKey`-guarded record specifically, would otherwise be a PERMANENT, undetectable loss once the surviving marker makes a later replay treat it as already recorded. A best-effort caller degrades to diagnose-and-drop on retry exhaustion, never rejecting; a `strict`/`dedupeKey` caller still rejects. Separately, `bureau.reviews.resolve` fences a losing resolver BEFORE its irreversible action runs (Codex P1 review finding, PR #601, "Fence concurrent resolutions before performing the action"): before `resumeApproval`, `revokeApproval`, or the `bureau.contexts.signal` calls that deliver an approve/deny/reject decision, a plain `SessionStore.load` read checks whether a DIFFERENT resolver's decision is already durably recorded for this review id, throwing `CONFLICT` before any action rather than only after (`persistReviewResolution`'s own conflict detection, described above, still runs afterward as a second, DURABLE check). This is a plain read, not an atomic claim—a genuinely simultaneous pair, neither yet committed when the other reads, can still both pass it and both act; closing that residual window needs a two-phase durable resolution claim, tracked as a follow-up rather than shipped here.

That `resolvedReviewIds.includes(reviewId)` check alone cannot tell apart two situations that look identical from the id list alone (Codex P1 review finding, PR #601, "Distinguish concurrent resolvers from commit retries"): THIS call's own retry after an ambiguous commit (described above), versus a genuinely DIFFERENT resolver's decision having already won a race—two Bureau instances sharing a session store, both resolving the same still-pending review, is a scenario this codebase already documents and tests elsewhere (see "AB-390—outbox claim lease" tests). Conflating the two meant a losing resolver's call would report success and dispatch its own `ReviewApproved`/`ReviewDenied`/`ReviewRejectedEvent`, contradicting the sole durable audit record—which names the WINNING resolver's decision. Fixed by persisting the decision's own identity (`decision`, `principal`, `reason`) alongside `resolvedReviewIds`, in a sibling `resolvedReviewDecisions` metadata map. When `reviewId` is already resolved, the updater compares the persisted decision against this call's own: a match is the benign self-retry case (`alreadyLanded`, as before); a mismatch means a different resolver won, and `persistReviewResolution` throws `BureauError('...', 'CONFLICT')`—mirroring the existing `reviewResolutionCleanupPending` "already resolved" CONFLICT shape rather than inventing a new one. `persistReviewResolutionWithRetry` fails fast on this CONFLICT rather than retrying (it is not transient—retrying only re-throws the identical error), and `bureau.reviews.resolve`'s own catch skips registering `reviewResolutionCleanupPending` for it, since a losing resolver's call committed nothing and has nothing to clean up. A resolution recorded before this field existed (no persisted identity) is treated as the benign case, for backward compatibility with sessions resolved by an earlier version.

Two more fixes to the `dedupeKey` mechanism itself, both in `audit-trail.ts`. First, `writeOutOfBandRecord`'s `dedupeKey` branch now calls `trackWrite` (Codex P2 review finding, PR #601, "Track deduplicated audit writes before returning")—a non-rejecting derivative of the `conditionalBatch` promise, so `query()`, `runtime.deferred.drain()`, and `dispose()` all observe this write the same as every other path, while the REJECTING `conditionalBatch` promise itself is still what a `dedupeKey` caller awaits. Second, `prune()` now reconciles orphaned `audit-dedupe:v1:` markers (Codex P2 review finding, PR #601, "Prune dedupe markers with expired audit records")—every `record({ dedupeKey })` write leaves one of these permanently, and nothing previously deleted them, so retention bounded the audit records themselves but not this marker family. `runPrunePassLocked` lists every marker each pass (matching its own existing cost profile, which already lists every audit-record key each pass regardless of the retention floor) and deletes any whose named record no longer exists—a true RECONCILIATION rather than a filter over just this pass's own deleted candidates, so it also heals a marker orphaned by an EARLIER pass crashing between deleting a record and deleting its marker, which could never be re-discovered by matching against a fresh candidate list. Runs even on the "nothing qualified" early-return path, and is isolated in its own try/catch—a marker-cleanup failure never turns an otherwise-successful record prune into a rejected pass, and marker deletions are never counted in `prunedCount` or the `audit.pruned` summary, which describe audit records, not markers. `durable-event-history.ts`'s own `outbox-dedupe:` marker family has no equivalent cleanup—a separate, tracked gap (see `followUps`), since that file's pruning story is independent of this one.

Two more fixes, both Codex findings against the `dedupeKey` mechanism's own remaining edges. First (P1, "Guard the audit record key against cross-instance collisions"): the audit `key` a `dedupeKey` write commits under is derived from `sequence`, a LOCAL per-instance counter seeded from a boot-time scan—two `AuditTrail` instances booting from the same persisted floor, before either has written anything, can independently allocate the SAME `sequence` for the SAME `runId`/`timestampMs` (exactly the scenario `dedupeKey` exists to support: two Bureau processes racing over one still-pending review). The original single-attempt batch fenced only on the dedupe marker, so two DIFFERENT `dedupeKey`s colliding on the same derived `key` would both commit, the second silently overwriting the first's record. Fixed by fencing on the audit `key` too, as a second CAS precondition: when the batch fails, a direct read of the marker distinguishes a benign duplicate (marker present—this exact fact was already recorded) from a genuine key collision (marker absent—an unrelated record occupies this key), and a collision mints a fresh `sequence`/`key` and retries, bounded to 3 attempts before failing loudly. Second (P2, "Renew the prune lease during marker reconciliation"): `reconcileOrphanedDedupeMarkers`'s own scan can run long enough on a trail with many markers to outlast the prune lease's TTL, same as the record-delete loop it sits beside—now renews every 200 markers (sharing the delete loop's own `RENEW_EVERY_N_DELETES` cadence) and aborts the pass on a lost renewal, mirroring the delete loop's own partial-summary-then-throw contract exactly.

Finally, `@lostgradient/operative`'s `SessionStore.update()` now validates `options.outbox` entries synchronously, before `commit()`'s `conditionalBatch` ever runs (Codex P2 review finding, PR #601, "Validate attachments before committing malformed outbox entries")—an untyped caller (or a cast past `JSONValue`) passing `payload: undefined` would otherwise commit a `session.attachment` entry `JSON.stringify` silently strips that field from, and every LATER `outbox.pending()` call would then throw on it forever (`parseOutboxEntry` requires `payload`), permanently blocking delivery of that entry and everything queued behind it with no self-healing path. `update()` now throws `TypeError` for a non-string or empty `namespace`, or a `payload` that is `undefined` or not JSON-serializable, before anything commits.

`lastRunOwningPrincipals` is never pruned on a run's terminal transition, and never on a count (AB-363's coordinator ruling): pruning on either signal would reintroduce the exact denial AB-359 fixed for a run whose durable history is still pageable long after it completed. The only pruning is `pruneStaleRunOwnership`, which drops an entry once its run's ENTIRE durable event history has fallen below the fleet feed's retention floor, because a history that can no longer be paged needs no owner. It runs on every `bureau.runDurableMaintenance()` call (the manual/serverless host's own driver) AND, under the default `maintenance: 'automatic'` profile, on its own in-process interval—Weft's engine already runs its own `engine.runMaintenance()` automatically in that profile, but exposes no hook to run extra work after each cycle, so Bureau starts a second, `pruneStaleRunOwnership`-only interval (never re-invoking `engine.runMaintenance()` itself) rather than leaving pruning unreachable for the default profile (Codex review, PR #568, "Run ownership pruning in the automatic maintenance profile"). This timer is injectable-clock-aware (`RuntimeServices.timers`), and a failed pass is diagnosed rather than thrown. A tick that fires while the prior pass is still running skips starting a second one rather than overlapping them (Codex/Copilot review, PR #579, "Prevent overlapping automatic pruning passes"); `shutdown()`/`dispose()` both clear the interval AND await a pass still in flight before disposing the event history and storage it reads and writes (Codex review, PR #579, "Await running pruning passes before backend teardown"). The in-flight pass is tracked in a plain local variable, not `RuntimeServices.deferred`—nothing in production ever calls `deferred.drain()`, so tracking a recurring five-minute tick there would grow that ledger unboundedly for the life of the process (Codex review, PR #579, "Bound deferred tracking for recurring passes").

A candidate run is excluded from pruning—left for a later cycle—on any of four signals, none of them a read of run state through `engine.get` (an earlier revision used that and got the unknown-run case and the write-in-flight race wrong, Codex/Copilot review, PR #568): its `lastRequestAuthorities` entry still being present (still live, or terminal-but-awaiting-a-pending-approval-decision, which can still produce a future `review.*` durable event—a value present but NOT a plain record fails the WHOLE session closed rather than being read as "no live runs", Codex review, PR #568, "Preserve owners when the authority map is malformed"); `DurableEventProducer.hasActiveWrite({ kind: 'run', id })` reporting a `history.record()` write for it still in flight—closing the window between a run's terminal transition removing its authority entry and that SAME transition's own durable write actually committing (Codex/Copilot review, PR #568); or the run still being present in the in-memory run store (`store.getRun(runId) !== undefined`)—task retention can remove any such run at any future point, and records a brand-new, retained `run.removed` durable event under this SAME owner (Codex review, PR #568, "Preserve ownership for a later run removal event"). That third signal is why pruning a still-live process's own runs is rarer in practice than the retention floor alone suggests: nothing in this codebase evicts a run from the store except run removal, which `retention.tasks` (30 days by default) performs, so a completed run stays protected until retention removes it, however far the floor advances past its history—pruning only reaches it after such a deletion (whose own `run.removed` then also ages past the floor) or on a later process's maintenance pass, since a terminal run is never reattached into the store at boot (only in-flight ones are), which is also why that later process needs no protection for a run it never held: retention only considers runs in its own store, so no future `run.removed` is possible for it there either. The fourth signal, under `durableOwnership: { ownership: 'workflow-lease' }` (the default), is `Engine.claimHolder(runId)` reporting the run's workflow claim held by any process (COR-204). It is checked last, only for a candidate the other three did not exclude, because it is one storage read per candidate per update attempt, and it is never called under `{ ownership: 'none' }`. It reads claim liveness, not run state, and it can only add an exclusion: no claim record or a stranded claim leaves the decision to the other three. Signals two and three are process-local, so this is what protects a run still executing on another instance whose `lastRequestAuthorities` entry is already gone from the shared session store (for example after a recovered run's invalid approval state is pruned); an ordinary live run is already protected everywhere by its authority entry. A claim a crashed instance never released reads as held until its grace-adjusted expiry, so pruning that run waits at most that long, and a rejected `claimHolder` read aborts the session's write and is diagnosed like any failed pass.

The retained-owner set itself is revalidated fresh immediately before each session's write (inside `SessionStore.update`'s callback, re-run on every conflict retry, and passed `{ refreshActivity: false }` so this maintenance write never itself reads as session activity—Codex review, PR #568, "Avoid refreshing session activity during retention pruning")—a run can dispatch, complete, and have its terminal event land in the feed entirely within the time this pass spends paging through other sessions, which would make a single up-front snapshot stale by the time that run's own session is reached (Codex review, PR #568, "Revalidate retained owners before pruning"). That revalidation is a cheap, cursor-resumed `DurableEventHistory.refreshRetainedRunOwnerIds()` call, not a second from-scratch `retainedRunOwnerIds()` full replay per candidate session—the latter would turn one maintenance pass into O(candidate sessions × retained events) storage reads (Codex review, PR #568, "Avoid replaying the full fleet feed per candidate session"); the initial snapshot (one full replay) is still taken once, up front, per pass. `refreshRetainedRunOwnerIds()` also mutates that ONE snapshot's owner set in place rather than cloning it on every call—a per-candidate, per-retry `Set` copy of every retained owner would have kept CPU/allocation cost at O(candidate sessions × retained owners) even after the storage-read cost above was fixed (Codex review, PR #579, "Stop copying the full owner set on every refresh"). Across instances sharing one backend, no primitive spans the fleet feed and the session store in one atomic operation, and `claimHolder`, like Weft's `holderStatus` beneath it, is a point-in-time read, not a lock. So an event for a pruned run can still land after the delete: a terminal run whose claim was already released can still be deleted (`run.removed`) or have a review resolved (`review.*`) by an instance that holds it in memory, and another instance's event can commit between a pass's fresh refresh and its session write. Both sides therefore verify after they write (COR-1380), and whichever read comes second restores the entry with an idempotent union write that preserves `updatedAt`. The pruner reads the feed again after each committed delete and puts back, with the principal it removed, every deleted run that is now retained, whatever kind of event made it so; a rejected restore write is diagnosed and the pass moves on to the next session. Run removal and every `review.*` transition (approve, deny, reject, expired, revoked, canceled, superseded) wait for their own durable write to settle, then read the run's entry and restore it with the run owner's principal, never the acting principal; a failed restore is diagnosed and never changes the call's own outcome. The guarantee: once a pass and a run removal or `review.*` transition on the same run have both settled, the run's entry exists whenever a retained `run.removed` or `review.*` event for it exists, provided the recording instance holds the run's principal in memory. What remains: the entry is briefly absent between a prune commit and its restore; a pass that crashes, or whose post-delete refresh rejects, between its commit and its restore can leave the entry absent; an instance with no in-memory principal or session incarnation for the run (one rehydrated at boot after the entry was already pruned, or recovered without an incarnation), or a run recorded without a principal, gets no writer-side restore, and neither side ever restores into a session deleted and recreated under the same id since the entry was removed; and `run.completed`, `run.error`, `run.aborted`, `run.tripwire`, `schedule.completed`, and `schedule.failed` events under a run owner have no writer-side restore, so they are covered only by the exclusion signals and, when they land before the pruner's re-read, by the pruner-side restore. Under the opt-out `{ ownership: 'none' }` the claim signal is absent and every exclusion beyond the shared authority entry is process-local. Durable maintenance calls `FleetEventFeed.retain()` under `retention.events` (7 days by default), so the floor advances and this pass has work whenever runs are older than the window.

```typescript
import type { Bureau } from '@lostgradient/bureau';

declare const bureau: Bureau;
declare const runId: string;
declare const lastKnownCursor: string;

const subscription = bureau.tasks.subscribeEvents(
  runId,
  (event) => console.log(event.kind, event.payload),
  { since: lastKnownCursor },
);
// later
subscription.unsubscribe();
```

`subscribeEventHistory` replays every event after `since`, then transitions to live delivery with no gap and no duplicate at the handoff, built entirely on `FleetEventFeed.subscribe()`—Weft's own race-free replay-then-tail composition—so this module adds no sequencing of its own. Disposing one subscription (`unsubscribe()`, or aborting `options.signal`) stops delivery to that listener only; a second, independent subscription to the same owner is unaffected, and the underlying `FleetEventFeed` is released only when the whole store's `dispose()` runs (Gateway's paging/SSE/WebSocket projection—AB-91's `ab91-03`—remains a separate, not-yet-built slice).

`bureau.shutdown()`/`bureau.dispose()` dispose the producer, then this store (an `'event-history'` `BureauShutdownOwnerReport` row) in the same drain ordering as the audit trail, before the durable engine and raw storage are torn down.

### Governed memory (COR-41)

Pass a `GovernedMemory` as `BureauOptions.memory`, and every run Bureau composes recalls through mandatory recall admission and stores its final answer through write admission, both under an authority derived from the run's persisted request. The host builds the instance with `createGovernedMemory()` from `@lostgradient/memory`, so the host owns its storage, ledger, and policy. Bureau calls `memory.init()` while it composes and calls `memory.close()` without awaiting it when it shuts down. `bureau.memory` is the same instance, for the governance work the host does itself. The [memory README's governed memory section](../memory/README.md#governed-memory) is the API reference, and [Memory governance and lifecycle evaluation](../../documentation/memory-governance.md) covers the lifecycle across packages.

This example runs in [`src/memory-governance-guide.test.ts`](./src/memory-governance-guide.test.ts), which imports from `./index` instead of `@lostgradient/bureau` and asserts every commented result. It uses `tasks.start`, because only the runs Bureau composes itself get memory hooks:

```typescript
import { createBureau } from '@lostgradient/bureau';
import {
  createGovernedMemory,
  createMemoryAuthority,
  createMemoryGovernanceLedger,
  createMemoryGovernancePolicy,
  createMockEmbedder,
  createWeftMemoryRecordStorage,
} from '@lostgradient/memory';
import {
  createAgent,
  createMockGenerate,
  stopWhen,
  waitForRunState,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/weft';

const storage = new MemoryStorage();
const memory = createGovernedMemory({
  storage: createWeftMemoryRecordStorage(storage),
  ledger: createMemoryGovernanceLedger(storage),
  embedder: createMockEmbedder(64), // use a real embedder in production
  policy: createMemoryGovernancePolicy({ revision: 'governance:1' }),
});

const bureau = await createBureau({
  id: 'acme', // the tenant: memory is partitioned by the Bureau's identifier
  agents: {
    default: createAgent({
      generate: createMockGenerate([{ content: 'Booked seat 14C for Alice.', toolCalls: [] }]),
      stopWhen: stopWhen.noToolCalls(),
    }),
  },
  memory,
  // A caller-supplied request authority is re-validated before every run.
  requestAuthorityValidator: () => true,
});

const run = await bureau.tasks.start('default', 'Book the 9:40 to Denver.', {
  principal: 'alice', // the task's owner of record, whose partition its memory is written to
  contextId: 'session-42', // the memory belongs to the agent, so every chat of Alice's shares it
  requestContext: {
    authority: {
      principalId: 'user:alice',
      tenantId: 'acme',
      ownerId: 'alice',
      capabilities: ['tools:execute'],
      authorizationRevision: 'authorization:7',
    },
  },
});
await run.result();

// The host reads memory with its own authority, never with the run's.
const auditor = createMemoryAuthority({
  principal: { kind: 'governance', id: 'governance:auditor' },
  tenantId: 'acme',
  ownerId: 'alice',
  purpose: 'audit',
  capabilities: ['memory:list', 'memory:inspect'],
  policyRevision: 'authorization:7',
  projection: 'audit',
});
const [stored] = await bureau.memory!.list(auditor, { collection: 'default' }); // the agent's name
console.log(stored?.content); // 'Booked seat 14C for Alice.'
console.log(stored?.source); // 'conversation'
console.log(stored?.trust); // 'untrusted'
console.log(stored?.governance?.attribution.delegationChain.map((link) => link.principal.kind));
// ['service', 'user', 'run']

await bureau.dispose();
```

**Which runs get memory.** Bureau registers its two memory hooks in every run it composes itself: tasks, durable schedule fires, and durable runs it recovers after a restart. A `bureau.children` child, a goal attempt, or a workflow step, which are catalog runs, gets neither hook. Those hooks close over a Bureau session, and a catalog run has none (see `createRuntimeComposition`'s comment on Bureau invariants). A recovered run whose persisted request authority cannot be restored gets no memory hooks at all.

**How a run's authority is derived.** `createRunMemoryAuthority(requestContext, { runId, tenantId, ownerId }, options.memoryAuthority)` builds a three-link delegation chain: a `service` principal with id `bureau` holding `memoryAuthority.runCapabilities`, then the request principal (`requestPrincipal(principalId)`) holding the capabilities granted to it, then the run itself as a `run` principal whose id is the run id. The authorization revision comes from the request authority, the purpose from `memoryAuthority.purpose` (`'conversation-memory'` by default), and the projection is `bureau`. `runCapabilities` defaults to `DEFAULT_RUN_MEMORY_CAPABILITIES`, which is `memory:search` and `memory:write`. When the request authority names explicit `memory:*` capabilities, they can only narrow that grant. A request that names none receives it unchanged. An empty grant does not turn memory off. With `runCapabilities: []`, or with explicit request `memory:*` capabilities that share nothing with `runCapabilities`, both hooks stay attached, and every run's recall and write are refused as `missing-capability`. Each refusal is recorded in the governance ledger as a `memory.access.denied` event and passed to `onEvent`, so a sink that throws still fails the run. To attach no memory hooks at all, leave `BureauOptions.memory` unset.

**Where a run's memory lives.** The tenant is the Bureau's identifier (`Bureau.id`), and the owner is the run's owner of record: the owner already persisted on its session, which is `anonymous:local` when none was recorded, and for a schedule's fire the schedule's owner. It is never the request authority's `tenantId` and `ownerId`, which are the tool-execution authority. The collection is the agent's identifier, so an agent remembers across every chat its owner has with it and not across agents, and the persist hook writes the chat that produced a record into the record's `metadata` as `sessionId`. This is the partition `bureau.memory.list`, `search`, `get`, `forget`, and `correct` read for the caller they serve (see the [control plane](./documentation/external-control-plane.md)). A Bureau with persistent memory needs a stable `id`: the generated default changes on every restart, and a restarted Bureau would read and write a partition that holds none of what it remembered before. Nothing refuses or warns.

The request authority is the run's `requestContext` when the caller supplies one. An authority whose `authorizationRevision` is not Bureau's own must pass `requestAuthorityValidator` before every run, or `tasks.start` throws `CONFLICT`. Without a `requestContext`, Bureau builds one for the tools: principal `request.principal`, or `run:<runId>` when there is none, tenant `bureau`, and owner the agent name (`bureau` by default). Scheduled work, meaning schedule fires, runs under a `service` request principal whose id is `system:scheduler`.

**What the hooks do.**

Both hook factories are exported from `@lostgradient/bureau`. Bureau builds its hooks once per run, from the run's memory authority and a target: the memory collection, which is the agent's identifier, and the run's session id.

| Factory, registered as | When | What it does |
| --- | --- | --- |
| `createMemoryRecallHook(memory, authority, { collection, sessionId })`, registered as `bureau:memory-recall` (`prepareStep`) | Step 0 only, when the conversation has a user message with string content | Calls `recallForModel(authority, latestUserMessage, { collection, limit: 5, contextId: authority.principal.id })`. The `contextId` is the run id. When any evidence is admitted, it appends `bundle.rendered` as a system message whose metadata is `memoryEvidence: { sessionId, recordIds, withheld }`. |
| `createMemoryPersistHook(memory, authority, { collection, sessionId }, runId?)`, registered as `bureau:memory-persist` (`onStep`) | The final step, when its content is not blank | Calls `write(authority, content, { collection, source: 'conversation', memoryClass: 'episodic', metadata: { step, replay: 'effectful', sessionId }, dedupeKey })`. `dedupeKey` is `'<runId>:<step>'` when the hook was built with a `runId`. A replayed step's write then returns `duplicate` without storing anything, provided the governed memory's storage implements `getByDedupeKey()` and `putOnce()`, as both bundled backends do. On storage with neither method the key is ignored and the replayed write is stored again, and without `putOnce()` a replay racing the original write can store it twice. A hook built without a `runId` writes with no dedupe key. A rejected or quarantined write is recorded in the governance ledger and never reaches the run; a rejected one, which stores no record, is also reported to `onDiagnostic` as a `warn` with scope `memory`, naming the reason and never the content. A write that throws does reach it: see **What Bureau leaves to the host** below. |

Bureau passes a `runId` to the persistence hook for every run it composes. For tasks, durable schedule fires, and recovered runs, it is the run id, so a run's answer is written with the dedupe key `'<runId>:<step>'`.

Both hooks are classified `replay: 'effectful'`: recall writes ledger events and can quarantine a poisoned record, and persistence writes a record. When a recovered step runs again, recall is safe to repeat: the step's conversation is rebuilt, and a record quarantined the first time is simply absent. A repeated step has the same run id and step index as the first, so its write stores nothing, provided the governed memory's storage honors dedupe keys, as described above.

**One predicate for every projection.** Bureau adds no memory check of its own and has no path around the governed memory: every hook call goes through `decideMemoryAccess()`, the same predicate every projection uses, with the same redaction decision. The memory package's `test/governance/predicate.test.ts` checks every projection against every operation and resource shape and expects identical decisions.

| Projection | What ships for it |
| --- | --- |
| `bureau` | The two hooks above, under `createRunMemoryAuthority()`; `createBureauHandler`'s `bureau.memory.*` operations, which build a `user` authority for the caller's own partition on every call; and the maintenance pass's retention sweep, under a one-link `service:bureau` authority holding only `memory:retention` and `memory:delete` (revision `bureau:maintenance`). |
| `tool` | `createGovernedMemoryTools()`'s default authority. Bureau does not add these tools to runs. A host that adds them to a toolbox must give the request explicit `memory:*` capabilities, because the tools read the request authority, not `runCapabilities`. |
| `agent`, `child` | `attenuateMemoryAuthority()` for a host to derive a narrower authority. Bureau derives none for catalog agents or children. |
| `a2a`, `mcp` | Nothing: this repository has no A2A or MCP memory adapter. An adapter records the projection on the authority it builds and calls the governed memory like any other caller. |
| `audit`, `administrative` | The host's own reads, legal holds, retention sweeps, and deletions through `bureau.memory`, under the host's own authority. |

**What Bureau leaves to the host.** Governance events go to the governed memory's ledger and its `onEvent` sink. Bureau does not copy them into `bureau.internals.auditTrail`, whose `AUDIT_EVENT_TYPES` has no memory entries. Read them with `bureau.memory.listEvents()`. Bureau does not catch what a memory hook throws, and governed memory awaits `onEvent` inside each call, so a sink that throws fails the run. Step 0's recall records an event, so the run ends with status `error` and an `AgentRunError` of kind `generate`, before any answer is written. A sink that throws only on the final answer's `memory.write.admitted` event ends the run with an `AgentRunError` of kind `policy`, after the answer is stored. Give governed memory an `onEvent` that never throws. Bureau's maintenance pass, `runDurableMaintenance()` and its automatic timer, first calls `sweepRetention()` and then `processDeletionPropagation()`, so an expired record is deleted, and the deletion's bounded-async targets settle, without the host scheduling either (the automatic timer also runs for a Bureau with memory and no durable engine, and a `maintenance: 'manual'` host drives both through `runDurableMaintenance()`). The sweep runs under an authority Bureau builds once, when it composes with `BureauOptions.memory`: a one-link chain holding the `service` principal `bureau`, with the Bureau's identifier as tenant and owner, purpose `retention`, projection `bureau`, policy revision `bureau:maintenance`, and exactly `memory:retention` and `memory:delete`. It walks every scope of the tenant, so a collection that reached `maxRecordsPerCollection` accepts writes again once its records have expired. Records still inside retention stay, and a quota is the host's policy to raise. A sweep that throws, or that governed memory answers `denied` or `rejected`, is reported to `onDiagnostic` at level `error` with scope `durable-maintenance`, and the rest of the pass still runs. A sweep that deletes and prunes nothing records no `memory.retention.swept` event. Bureau never calls `expireWorkingMemory()`: its hooks write only `episodic` records, so a working-memory record never comes from Bureau, and a host that writes working memory schedules that call itself, under a service or governance authority. Bureau deletes memory otherwise only when a caller of `bureau.memory.forget` asks.

## `AgentDefinitions` and the Agent Catalog

`AgentDefinitions` (AB-15, AB-22) is a plain literal object—the `agents` map passed to `createBureau({ agents })`—of agent name to `RunnableAgent` (an `@lostgradient/operative` `createAgent()` or `createLazyAgent()` result). There is no register/unregister lifecycle: the map is fixed for the bureau's lifetime. `bureau.agents` exposes an immutable, read-only `BureauAgentCatalog` view over it (`get`/`find`/`has`/`names`/`entries`/`query`), and `bureau.tasks.start(name, input, options?)` starts a task of a named entry: it resolves with a `TaskHandle` once the run exists, typed by the entry's output for a name in the catalog.

```typescript
import { createAgent, type GenerateFunction } from '@lostgradient/operative';
import { createBureau } from '@lostgradient/bureau';

declare const generate: GenerateFunction;

const bureau = await createBureau({
  agents: {
    researcher: createAgent({ generate, instructions: 'You are a research assistant.' }),
    writer: createAgent({ generate }),
  },
});

bureau.agents.has('researcher'); // narrows to a known agent name where TypeScript permits it
bureau.agents.names(); // ['researcher', 'writer']—definition order

const run = await bureau.tasks.start('researcher', 'Summarize the Q3 report.');
for await (const event of run) {
  // ...
}
const result = await run.result();
```

`bureau.tasks.start` refuses before anything is persisted: an unknown `name` is `NOT_FOUND`, an agent with no definition resolver is `UNSUPPORTED_CAPABILITY`, a disposed bureau and malformed `input` or `options` are `BAD_REQUEST`, and a refusal rejects the returned promise rather than throwing. `StartTaskOptions` (`contextId?`, `principal?`, `commandId?`, `requestContext?`, `signal?`, `traceContext?`, `withTraceContext?`) carries only call-scoped concerns—there is no per-call `systemPrompt`/`maximumSteps`/`maximumTokens` override; anything that shapes how an agent runs is fixed on its own definition (`createAgent({ instructions, maximumSteps, ... })`). A task runs in a context and, on a Bureau with a durable engine and an agent that supports AB-21's definition-resolution capability (every `createAgent`/`createLazyAgent` result does), through that durable engine, so it survives a crash and resumes; otherwise it runs in memory. `principal` owns the task and a context it creates. See [Tasks](#tasks-bureautasks).

### Agent files (COR-1524)

`createBureau({ agentSource: agentFileDirectory(path, { tools }), models: { generate } })` loads agents from Markdown files in a directory the host names (`agentFileDirectory` comes from `@lostgradient/bureau/sources`, so a bundle that imports only `createBureau` carries no `node:fs`). A file `researcher.md` is the agent `researcher`: YAML frontmatter (`name`, `description`, `model` written `<provider>/<model>`, `tools`, `skills`, `published`) followed by the instructions. Bureau watches the directory, so adding, editing, or deleting a file takes effect without a restart, and `bureau.agents.create`, `update`, `publish`, `withdraw`, and `delete` write through the same files (`createBureauHandler` serves them as `bureau.agents.definitions.*`, with the models and tools a file may name as `bureau.agents.catalog`). `bureau.agents.list()` lists code-defined and file agents together; a file that cannot be used is listed with `state: 'invalid'` and a typed `problem`, never runs, and leaves every other agent working. A file agent runs through `bureau.tasks.start(name, input)` with the same options as a code-defined one.

A run uses the definition it started with. Bureau stores that definition as a snapshot keyed by the file's SHA-256, the run records the hash, and a run resumed after a restart is rebuilt from the snapshot even if the file is gone. `bureau.agents.revisions(id)` lists the snapshots that have run. A file agent's `definitionRevision` (on `bureau.agents.list()`, `bureau.agents.list` over HTTP, and `bureau.agents.definitions.get` and `list`) is 1 on first sighting and rises every time the file's content changes, kept in a conditional per-agent record that survives a restart and is safe across Bureau processes on one store; a run keeps the revision it started with. See [`documentation/agent-files.md`](documentation/agent-files.md) for the format and the full contract. Four limits are worth knowing:

- **Snapshot retention**: a snapshot is kept while any run that references it is retained and pruned after the last one's retention ends. A task's snapshot reference ends `retention.tasks` (default 30 days) after the task settles. A run that has not settled keeps its snapshot, and the maintenance pass settles a reference whose run the durable engine says has ended, or releases one with no run behind it after ten minutes. Pruning is not atomic across Bureau instances sharing a store; agent files support one Bureau per store.
- **Steering**: the agent-identity steering override still validates against the code-defined `agents` map only, so a file agent is not a steering target.
- **Create race**: a write goes to a temporary file in the same directory and is renamed into place, under a lock in this process. There is no cross-process file lock, so another process writing the same file between a write's last check and its `rename` is not detected, and `create` cannot refuse an existing target at that instant.
- **Rewrites**: an API write that changes the frontmatter replaces the lines of the keys Bureau knows and keeps every other line, comments included, byte for byte, so an unknown key keeps its value and its YAML type for other tools (a quoted `created: '2024-01-01'` stays a string, an unquoted date stays a date). Bureau reads the result back and, if a line edit cannot be verified (a quoted key, say), re-emits the whole frontmatter instead, which keeps values and types but drops comments and layout. The body survives byte for byte, and an update that changes nothing writes nothing. An update or delete of a symbolic-linked agent file replaces the link with a regular file.

### Workflow files (COR-1527)

`createBureau({ workflowSource: workflowFileDirectory(path) })` loads agent-authored workflows from JSON files in a directory the host names, and needs a durable engine. A file `nightly-digest.json` is the workflow `nightly-digest`: Weft's workflow document (`name`, `trigger`, `steps`) plus an optional `agent` (who wrote it) and `paused`, and nothing else. The trigger is `{ kind: 'schedule', spec, overlap? }` or `{ kind: 'signal', name }`, and the one activity is `agent`, `{ agent, message }`, which starts a standalone durable run of that agent as the deployment's owner and passes `{ content, output, finishReason }` to the next step. Bureau registers each file as its own Weft workflow type, keeps one native schedule per workflow that matches its file, watches the directory so a change takes effect without a restart, and `bureau.workflows.create`, `update`, `pause`, `resume`, and `delete` write through the same files with the agent files' rules (a temporary file renamed into place, `expectedHash`). A file that cannot be used is listed with `state: 'invalid'` and a typed `problem` and leaves every other workflow working.

A run keeps the revision it began on. Bureau stores each registered document in its database under its Weft `workflowVersion`, and at startup registers every file's current document plus each older revision that still has an instance in flight, before the engine recovers, so an instance parked in a `sleep` or an `await-signal` whose file was edited or deleted resumes on its original revision. `bureau.workflows.revisions(id)` lists the revisions that have run, newest first. `bureau.workflows.signal` delivers a named payload to the running instances waiting for it and then starts the workflows whose signal trigger has that name. With a `workflowSource`, Bureau also adds the tools `workflows-create`, `workflows-update`, `workflows-pause`, `workflows-resume`, and `workflows-list` to the tool catalog (the agent source's `tools`), for an agent file that lists them, and appends every write to the audit trail under `workflow:<identifier>`. See [`documentation/workflow-files.md`](documentation/workflow-files.md) for the format and the full contract, and `bureau.workflows.*` in [`documentation/external-control-plane.md`](documentation/external-control-plane.md) for the owner-scoped operations under the scopes `bureau.workflows:read` and `bureau.workflows:write`.

### `createSupervisor` and `createAgentDiscoveryTool`

Both moved here from `operative` (AB-22), rebuilt against `BureauAgentCatalog<D>` in place of the deleted `AgentRegistry`.

```typescript
import {
  createAgentDiscoveryTool,
  createFanOutRouting,
  createSupervisor,
  type Bureau,
} from '@lostgradient/bureau';

declare const bureau: Bureau;

const supervisor = createSupervisor({
  agents: bureau.agents,
  routing: createFanOutRouting(), // or a custom `RoutingStrategy<D>`
});

const { agentResults, synthesis } = await supervisor.delegate('Draft a Q3 summary.');

const discoveryTool = createAgentDiscoveryTool(bureau.agents);
```

`createSupervisor` delegates a task to one or more catalog agents chosen by a pluggable `RoutingStrategy<D>` (`(task, descriptors) => name | name[] | Promise<...>`; built-ins `createRoundRobinRouting`/`createFanOutRouting` only load the agents they actually select) and synthesizes their results—`delegate` (one task), `delegateAll` (many, sequential or parallel), and `pipeline` (chain each stage's output into the next stage's input). `createAgentDiscoveryTool` exposes a tool an orchestrating agent can call to search the catalog (case-insensitive substring match) across each agent's name, its `description`, and each `skillDescriptors` entry's name, description, and tags. Each match comes back as `{ name, description, skillDescriptors }`, the last two omitted for an agent that declares none. The search reads only metadata already on the catalog's agent objects, so it never loads a lazy agent; supply `description` and `skillDescriptors` to `createLazyAgent` for a lazy agent to be searchable by more than its name.

## Test utilities

```typescript
import {
  createBureau,
  createBureauTestHarness,
  createLmdbStorageFixture,
  createMemoryStorageFixture,
  createSqliteStorageFixture,
} from '@lostgradient/bureau';
import { waitForCondition, waitForRunState } from '@lostgradient/operative';
```

The root exports `createBureau` and the Bureau-specific test harnesses. `waitForCondition` and `waitForRunState` remain Operative test helpers because they observe Operative-owned runs and state.

### `createBureauTestHarness(options)` (AB-261)

Composes a real `Bureau` over an injected `ManualRuntimeServices` (`options.runtime`, defaulting to a freshly constructed one) and an owned `BureauStorageFixture` (`options.storage`, required). The returned promise resolves only once `bureau.ready` is `true` and boot recovery has completed. Every other `BureauOptions` field passes through unchanged. `createManualRuntimeServices` and the `ManualRuntimeServices` type are re-exported from `@lostgradient/bureau` (and `@lostgradient/operative`); their source owner, `@lostgradient/lifecycle`, is a private workspace inlined into these packages, so a consumer never imports it directly (COR-89).

```typescript
import { createAgent, type GenerateFunction } from '@lostgradient/operative';
import {
  createBureauTestHarness,
  createManualRuntimeServices,
  createSqliteStorageFixture,
} from '@lostgradient/bureau';

declare const myGenerate: GenerateFunction;

const runtime = createManualRuntimeServices();
const storage = createSqliteStorageFixture({ runtime });

const harness = await createBureauTestHarness({
  agents: { worker: createAgent({ generate: myGenerate }) },
  runtime,
  storage,
});

const run = await harness.startTask({ agentName: 'worker', input: 'hello' });
await run.result();

await harness.bureau.dispose();
await storage.dispose();
```

The harness exposes `bureau`, `runtime`, `storage`, `scope`, and `childRegistry` directly, plus thin lifecycle drivers over the corresponding public `Bureau` method—`startTask` (`Bureau.tasks.start`, and registers the held run onto `scope`), `startChild` (dispatches through `bureau.agents` and operative's public `dispatchChildRun`, correlated to a caller-supplied `parentRunId`, registering into `childRegistry` by default unless `options.registry` overrides it), `createRecurringSchedule` (`Bureau.createSchedule`), `bureau.reviews.resolve`, `deliverSignal` (`Bureau.contexts.signal`), and `reattachDurable` (`Bureau.tasks.workflow`). None of them reach a private map or a raw Weft workflow handle.

`harness.supports(capability)` reports `false` for `'managed-goal'`—a product surface that doesn't exist on this baseline yet (AB-101/AB-102). Calling `harness.startManagedGoal()` throws a typed `BureauHarnessUnsupportedError` naming the owning issues rather than silently no-oping.

Two harnesses constructed independently in one process—each with its own `runtime`/`storage`—share no state: their clocks, timers, identifier sequences, storage paths, and events are fully isolated.

`harness.registerDurableRun(runId, { detached? })` and `harness.close()` are AB-262's slice—see "Quiescence report and `close()`" below. Out of scope for this harness: packed-consumer tarball verification (AB-264).

### Quiescence report and `close()` (AB-262)

```typescript
import { assertBureauQuiescent, BureauQuiescenceError } from '@lostgradient/bureau';
```

`harness.close(shutdownOptions?): Promise<BureauQuiescenceReport>` calls `bureau.shutdown(shutdownOptions)` (AB-207)—via `assertBureauQuiescent(harness, shutdownOptions)`—disposes `harness.storage`, then resolves with the report, or rejects with a `BureauQuiescenceError` (its `.report` carries the full structured detail) when anything Bureau owns was not quiescent. It never substitutes `bureau.dispose()` for `shutdown()`, and it is idempotent: a second call returns the exact same settled outcome without shutting down twice (a second call's own `shutdownOptions` are ignored, matching `bureau.shutdown()`'s own idempotency contract).

**The manual-runtime rule (AB-338):** the sleep `shutdown({ timeoutMilliseconds })`'s bounded wait races against always runs on the bureau's own resolved `RuntimeServices.timers` (AB-260's deterministic contract); it never falls back to a real timer under a `ManualRuntimeServices`, and the abort signal clears it when the teardown wins. That means nothing advances that sleep's timer on its own: under a plain `bureau.shutdown({ timeoutMilliseconds })` call against a manually-driven bureau, the caller owns advancing the clock (`runtime.advance(timeoutMilliseconds)`) far enough for the wait to elapse, exactly as it already owns advancing the clock for any other timer-driven behavior. `harness.close(shutdownOptions)` is the one exception: when `shutdownOptions.timeoutMilliseconds` is set, the harness itself advances its own `ManualRuntimeServices` by that many milliseconds once `bureau.shutdown()` has armed the timer—so a test calling `harness.close({ policy: 'drain', timeoutMilliseconds })` against a hung owner never needs a real wall-clock wait or a manual `runtime.advance()` call of its own to observe a bounded drain resolve with the hung work reported under `incomplete`.

`BureauQuiescenceReport` extends `@lostgradient/operative`'s `QuiescenceReport` (`scope`, `quiescent`, `leaked`, `detached`) with nine Bureau-owned `readonly LeakedResource[]` rows: `activeRoots`/`activeDescendants` (from `harness.scope`/`harness.childRegistry`), `pendingWebhookDeliveries` (`webhookNotifier.listDeliveries()`, status `'pending'`), `durableAttempts` (`bureau.tasks.workflow` for every id registered via `harness.registerDurableRun`, when non-terminal and not detached). `parkedWaits` and `pendingHookEffects` stay empty on this baseline—no public per-signal-wait listing or hook-effect tracking surface exists yet (AB-35, Backlog).

**`abortingRuns` (AB-369):** a `readonly { runId: string; since: number }[]` row, sourced from `bureau.internals.abortingTasks()`—the public read over the same `abortingRunIds` bookkeeping a task's cancellation maintains internally to guard against re-aborting a run it already requested cancellation for. `since` is the `RuntimeServices.clock.now()` timestamp the cancellation recorded when cancellation was first requested. Unlike the nine rows above, a non-empty `abortingRuns` DOES fold into `quiescent` directly (`quiescent = leaked.length === 0 && abortingRuns.length === 0`) rather than through `leaked`: a run whose `ActiveRun.closed()` never settles after a task's cancellation was requested stays listed here for the life of the process, which is exactly the leak this row exists to surface. `BureauQuiescenceError`'s message names each entry under an `abortingRuns:` heading when the report is non-quiescent for this reason.

The other three—`activeEvaluations`, `pendingAuditWrites`, `openStorageResources`—read empty on the common path (nothing genuinely survives an unbounded `bureau.shutdown()`, which awaits each owner's real drain) but populate for real once AB-265's fault engine forces a genuine leftover past a bounded `shutdown({ timeoutMilliseconds })` (AB-322): `activeEvaluations` from `bureau.onlineEvalSampler.activeEvaluationSnapshots()`, `pendingAuditWrites` from `harness.runtime.outstandingDeferred()` filtered to the `'audit-write'` label, and `openStorageResources` from the memory storage fixture's own public call accounting (`BureauStorageFixture.openHandles()`—sqlite/lmdb fixtures never open their own handle, so theirs always reads `[]`). The first two are read AFTER `bureau.shutdown()` returns but are deliberately never folded into `leaked`: the owner each names (`online-evals`/`audit-trail`) is already reported under `incomplete` when a bounded `shutdown()` times out on it, and promoting the same fact into `leaked` too would double-report it. `openStorageResources` IS folded into `leaked`—nothing in `bureau.shutdown()`'s own owner accounting shadows a lingering low-level storage call, so this is the only place that leak is ever reported. `incomplete` carries any owner `bureau.shutdown({ timeoutMilliseconds })` itself classified `'unresolved'`—reported distinctly from `leaked`, never promoted into it.

```typescript
import type { BureauTestHarness } from '@lostgradient/bureau';

declare const harness: BureauTestHarness;
declare const summary: { id: string };

harness.registerDurableRun(summary.id, { detached: true });
const report = await harness.close();
report.detached; // [{ kind: 'durable-owner', id: summary.id }]—not a leak
```

A durable run registered with `detached: true` is recorded under `detached`, never under a leak row—a deliberate, recorded outcome (AB-34), not a way to hide a leak.

### `assembleReproductionArtifact(harness, recorder, options)` (AB-263)

Builds on a `harness` already constructed with `createBureauTestHarness` (see above):

```typescript
import { createEventRecorder } from '@lostgradient/operative';
import { assembleReproductionArtifact, type BureauTestHarness } from '@lostgradient/bureau';
import type { StandaloneAgent } from '@lostgradient/operative';

declare const harness: BureauTestHarness<{ worker: StandaloneAgent }>;

const recorder = createEventRecorder(harness.runtime);
const run = await harness.startTask({ agentName: 'worker', input: 'hello' });
recorder.attachIterable(run, { kind: 'run', id: 'worker-run' });

const terminalResult = await run.result();
const held = harness.bureau.internals.store.getRun(run.id);
if (held === undefined) throw new Error('the task is no longer held');
const cleanupReport = await held.activeRun.closed();
await harness.runtime.deferred.drain();

const artifact = await assembleReproductionArtifact(harness, recorder, {
  effectiveModel: { provider: 'anthropic', model: 'claude-sonnet-4.5' },
  terminalResult,
  cleanupReport,
});
```

`ReproductionArtifact` here is `@lostgradient/operative`'s canonical declaration (AB-334), instantiated with Bureau's own `cleanupReport` union—`CleanupAcknowledgement | DeferredDrainReport | BureauShutdownReport`—since `bureau` can import that shared shape from `operative` but never the reverse. Assembles the normalized `ReproductionArtifact` AB-92's decision record fixes (AC8) from one harness run: `sourceRevision` (`git rev-parse HEAD`, read once), `packageVersions` (every workspace package's `name`/`version`, read from its `package.json`), `effectiveModel` (named by the caller in `options`, because no Bureau-wide provider holds one: every run belongs to a catalog agent that owns its model), `clockOrigin`/`identifierSeed`/`randomSeed` (`harness.runtime`'s own recorded seeds—present even for an unpinned, default-constructed runtime), `scriptedOutcomes`/`firedFaults` (always empty until AB-95's fault engine exists), `causalTrace` (`recorder.normalize()` and nothing else), `terminalResult`, and `cleanupReport`. `terminalResult` is redacted through `summarizeToolInput` before embedding—a privileged key (`password`, `secret`, `token`, `apiKey`, `authorization`, `credential`, `privateKey`) never appears in the serialized artifact. The returned object's keys are always written in AB-92's fixed field order, so `JSON.stringify` is byte-identical across two runs of the same scripted case with the same seeds.

`assembleReproductionArtifact` takes an optional fourth `environment` argument (AB-264): `{ sourceRevision?, packageVersions? }`. Supplying a field there replaces this function's own discovery for that field—`git rev-parse HEAD` and the `packages/*` manifest glob both assume a real repository checkout rooted at a `turbo.json`, neither of which exists inside a packed-and-path-installed tarball consumer (`scripts/verify-bureau-tarball-boundary.ts`'s probe passes both explicitly, since it already knows them from its own pack step). Omitted fields still discover normally, so every existing caller inside this repository is unaffected.

```typescript
import {
  assembleReproductionArtifact,
  type AssembleReproductionArtifactOptions,
  type BureauTestHarness,
} from '@lostgradient/bureau';
import type { EventRecorder, StandaloneAgent } from '@lostgradient/operative';

declare const harness: BureauTestHarness<{ worker: StandaloneAgent }>;
declare const recorder: EventRecorder;
declare const terminalResult: AssembleReproductionArtifactOptions['terminalResult'];
declare const cleanupReport: AssembleReproductionArtifactOptions['cleanupReport'];
declare const effectiveModel: AssembleReproductionArtifactOptions['effectiveModel'];

const sourceRevision = '0123456789abcdef0123456789abcdef01234567';
const packageVersions = { '@lostgradient/bureau': '0.0.0' };

const artifact = await assembleReproductionArtifact(
  harness,
  recorder,
  { effectiveModel, terminalResult, cleanupReport },
  { sourceRevision, packageVersions },
);
```

### Bureau-scoped fault-plan vocabulary and selectors (AB-263)

```typescript
import {
  selectAuditWriteFaultTarget,
  selectWebhookDeliveryFaultTarget,
  type BureauFaultPlan,
} from '@lostgradient/bureau';
```

`BureauFaultOperation` widens `@lostgradient/operative`'s `FaultOperation` with two Bureau-owned boundaries operative cannot see: `'webhook-delivery'` and `'audit-write'`. `BureauFaultPlanEntry`/`BureauFaultPlan` mirror operative's `FaultPlanEntry`/`FaultPlan` with that widened operation; every other fault type (`FaultBoundary`, `FaultOccurrence`, `FiredFault`, ...) is re-exported from operative verbatim—there is exactly one `FaultBoundary` union in the repository. No engine executes a `BureauFaultPlan` yet (AB-95); what ships here is the type vocabulary plus selector functions that resolve a Bureau-scoped target to exactly one concrete resource, throwing `BureauFaultSelectorResolutionError` otherwise: `selectWebhookDeliveryFaultTarget(deliveries, deliveryId)` (by `WebhookDeliveryRecord.id`, from `WebhookNotifier.listDeliveries()`), and `selectAuditWriteFaultTarget(records, auditEntryKey)` (by the audit entry key `encodeAuditEntryKey`—also exported from this package's root—produces from a queried `AuditRecord`'s `timestampMs`/`sequence`/`runId`).

### Storage fixtures

```typescript
import {
  createLmdbStorageFixture,
  createMemoryStorageFixture,
  createSqliteStorageFixture,
} from '@lostgradient/bureau';
```

Each factory returns a `BureauStorageFixture`: `{ configuration, path?, owned, dispose(), openHandles() }`. `configuration` passes straight to `BureauOptions.storage`. `createSqliteStorageFixture` takes `{ runtime, path? }`; `createLmdbStorageFixture` also accepts `durability?: 'full' | 'relaxed'` and defaults to production-equivalent `full` durability. Omit `path` for a fresh, unique path inside a new `mkdtemp` directory under the operating system's temporary directory, named after `runtime.identifiers.next('storage-fixture')` (`owned: true`; the directory exists as soon as the fixture is created, so call `dispose()`, which removes it with everything in it), or supply your own `path` for a fixture that never allocates or deletes anything (`owned: false`). Their fixture itself never opens a live storage handle—the real backend connection is owned and closed by whatever composes `configuration` (typically `Bureau`)—so `dispose()` only ever governs the filesystem lifecycle of a path this fixture allocated, and `openHandles()` always returns `[]` (nothing of their own to account for).

`createMemoryStorageFixture(options?: { wrapStorage?: (storage: Storage) => Storage })` (AB-322) is the one exception: it constructs its own `MemoryStorage` instance directly—safe only for memory, since there is no real file handle or single-writer lock to race the way sqlite/lmdb would—and hands `Bureau` that INSTANCE as `configuration`, wrapped with public call accounting. `openHandles(): readonly string[]` names every call (`get`/`put`/`delete`/`scan`/`batch`/…) this fixture has seen START but not yet FINISH—empty on the happy path, and a real diagnostic once something (e.g. `createFaultEngine(...).wrapStorage`, passed through `options.wrapStorage` before this fixture's own accounting wraps the result) blocks a call deterministically. `dispose()` disposes that instance directly—`bureau.shutdown()` never closes a caller-supplied `Storage` instance, only one it resolved itself from a `StorageConfiguration`, so this fixture is the one thing that does.

## Development

Run the focused checks from this package directory:

```bash
bun run lint
bun run typecheck
bun run test
```

From the Corvidae root, run `bunx turbo run lint typecheck test --filter=@lostgradient/bureau` for this workspace or `bun run validate` for the complete workspace. Formatting is configured at the root. This library has no build or publishing command.
