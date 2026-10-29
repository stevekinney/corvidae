# Multi-agent lifecycle and communication

A parent agent that delegates work needs more than a promise for each child. It needs to name a child, watch it, send it a decision, stop it without stopping its siblings, bound how far it may delegate in turn, and find it again after a restart. This guide covers the contracts [Operative](../packages/operative/README.md) and [Bureau](../packages/bureau/README.md) ship for that, the one communication pattern they support, and the behavior they do not provide.

The decisions behind this guide are COR-807 (supervisor-mediated communication only), COR-336 (delegation grants and budgets), and COR-820 (collaboration admission). The implementation issues are COR-676 (child-run handle), COR-814 (typed parent-child signals), COR-816 (historical session forking), and COR-772 (durable parent-child topology in Bureau). COR-812, durable peer delivery, was canceled because COR-807 rejected direct peer messaging.

## Choose the layer

Operative's child primitives are in-process: they live and die with the parent's process. Bureau's `bureau.children` records every relationship in its key-value store and can recover it after a restart.

| You need to | Use | Survives a restart |
| --- | --- | --- |
| Let a model delegate a task through a tool call and get a capped summary back | `createSubagentTool` (Operative) | No |
| Hold a typed handle to a child in code: events, result, abort | `dispatchChildRun` (Operative) | No |
| List or abort the children a running parent dispatched from its tools | `createChildRunRegistry` with `AgentRun.children()` and `abortChild()` (Operative) | No |
| Exchange typed messages with a live child | `dispatchChildRun({ signals })` (Operative), or `BureauOptions.children.signals` with `bureau.children.signal` (Bureau) | Bureau reopens the channel; messages are not replayed |
| Address a child by a stable identifier, and inspect, wait on, signal, or cancel it later | `bureau.children` (Bureau) | Yes, for durable children |
| Bound how deep and how wide a child's subtree may grow (depth and descendant counts; capabilities and usage ceilings are recorded, not enforced) | `BureauOptions.children.delegation` (Bureau), built on Operative's delegation-grant helpers | Yes |
| Branch a conversation at an earlier completed run | `SessionHandle.fork({ throughRun })` (Operative) | The fork is a new persisted session |

The detailed API references are the Operative README's [child dispatch and discovery](../packages/operative/README.md#child-dispatch-and-discovery-ab-50), [delegation grants](../packages/operative/README.md#delegation-grants-cor-336), and [session forking](../packages/operative/README.md#forking-a-session-through-a-completed-run-cor-816) sections, and the Bureau README's [parent-child topology](../packages/bureau/README.md#parent-child-topology-cor-772) section.

## Communication goes through the parent

The supervising parent is the only party that can address a child. There is no peer-to-peer messaging, no sibling addressing, no global mailbox, no broadcast, and no shared blackboard. Every signal channel is bound to exactly one parent-child pair when it is created, and neither endpoint takes a run identifier, so a child cannot use it to reach a sibling or an unrelated run. A child that dispatches a child of its own becomes that child's parent on a new channel; its own parent's port is never passed down.

When information has to move between siblings, the parent moves it. It observes one child, decides what the other child should see, and sends that as a signal. The parent can drop, reshape, or refuse the message, which is the point: it owns routing and the decision about what crosses.

This example runs in [`packages/operative/test/multi-agent-lifecycle-guide.test.ts`](../packages/operative/test/multi-agent-lifecycle-guide.test.ts), which uses the same code with a different import path and asserts every commented result. A scout reports a finding, the parent relays it to a builder, and then the parent stops the scout while the builder finishes:

```typescript
import {
  createAgent,
  createMockGenerate,
  defineChildSignals,
  dispatchChildRun,
  readParentSignals,
} from '@lostgradient/operative';
import { createTool } from 'armorer';
import { z } from 'zod';

// One contract for both children. Only the parent holds an endpoint that
// can address either of them.
const teamSignals = defineChildSignals({
  signals: { hint: z.object({ text: z.string() }) },
  events: { finding: z.object({ text: z.string() }) },
});

// The scout reports one finding, then keeps scouting until it is stopped.
const scout = createAgent({
  name: 'scout',
  generate: createMockGenerate([{ content: '', toolCalls: [{ name: 'scout', arguments: {} }] }]),
  tools: {
    scout: createTool({
      name: 'scout',
      description: 'Reports what it finds, then keeps looking.',
      input: z.object({}),
      async execute(_input, context) {
        const parent = readParentSignals(context.executionContext, teamSignals);
        parent?.emit('finding', { text: 'the nest is in the oak' });
        await new Promise((resolve) => {
          context.signal?.addEventListener('abort', resolve, { once: true });
        });
        return 'stopped';
      },
    }),
  },
});

// The builder waits for a hint from its parent and reports what it used.
const builder = createAgent({
  name: 'builder',
  generate: async ({ step }) =>
    step === 0
      ? { content: '', toolCalls: [{ name: 'await-hint', arguments: {} }] }
      : { content: 'built from the hint', toolCalls: [] },
  tools: {
    'await-hint': createTool({
      name: 'await-hint',
      description: 'Waits for the parent to pass along a hint.',
      input: z.object({}),
      async execute(_input, context) {
        const parent = readParentSignals(context.executionContext, teamSignals);
        if (!parent) return 'no parent';
        return new Promise<string>((resolve) => {
          parent.onSignal('hint', ({ payload }) => resolve(payload.text));
        });
      },
    }),
  },
});

const parentRunId = crypto.randomUUID();
const scoutRun = dispatchChildRun(scout, 'Find the nest', {
  agentName: 'scout',
  parentRunId,
  signals: teamSignals,
});
const builderRun = dispatchChildRun(builder, 'Build near the nest', {
  agentName: 'builder',
  parentRunId,
  signals: teamSignals,
});

// The parent decides what crosses between siblings.
const relayed = new Promise((resolve) => {
  scoutRun.signals.on('finding', async ({ payload }) => {
    resolve(await builderRun.signals.send('hint', { text: payload.text }));
  });
});

const relayOutcome = await relayed;
// { status: 'acknowledged', name: 'hint', parentRunId, childRunId: builderRun.childRunId, ... }
scoutRun.abort('the builder has what it needs');

const [scoutResult, builderResult] = await Promise.all([scoutRun.result(), builderRun.result()]);
// scoutResult.finishReason === 'aborted'; builderResult.content === 'built from the hint'
```

The mock and scripted `generate` functions stand in for real providers; the lifecycle and signal calls are the real ones.

Bureau narrows this further. `bureau.children.signal` sends parent-to-child signals, but Bureau exposes no way to observe a child's `events`. A Bureau-dispatched child that calls `emit` is buffered until the channel's buffer fills and then refused with `buffer-full`. For a Bureau child, the parent's inputs are the child's record, its terminal `outcome`, and the audit trail.

COR-820's `CollaborationPlan`, `CollaborationMessage`, message intents, trust classes, and shared-artifact commit authority are a recorded decision, not shipped code. No package in this workspace exports those types or enforces those rules.

## Addressing

| Identifier | Operative (`dispatchChildRun`) | Bureau (`bureau.children`) |
| --- | --- | --- |
| `parentRunId` | Supplied by the caller and stamped on the handle, every lifecycle event, and every signal. `dispatchChildRun` does not look the parent up or check that it exists. | Must name a run Bureau already knows: see the next table. |
| `childRunId` | Generated per dispatch, or set with the `childRunId` option. | Generated as `child-run-…` when omitted. It is also the child's durable workflow identifier. |
| `agentName` | The child's name, supplied by the caller. | The name of an agent in `BureauOptions.agents`; anything else is rejected as `unknown-agent`. |
| `principal` | Not applicable. | Optional on every call. A child's record carries its parent's owner, which is `anonymous:local` for a parent started with no principal. `dispatch` compares the caller's principal with the parent's. `get`, `list`, `wait`, `signal`, and `cancel` compare it with the child record's. A comparison passes when the caller states no principal, so omitting it is a trusted internal call. |

Bureau accepts three kinds of parent:

| Parent | Where its identifier comes from |
| --- | --- |
| A task (`bureau.tasks.start`) | The returned handle's `id`, which `snapshot().id` always equals. The handle carries it from the moment `bureau.tasks.start` resolves, and the snapshot is durable at once when Bureau has a durable engine and the catalog agent supports definition resolution (as every `createAgent` or `createLazyAgent` result does). Dispatch children under it once `bureau.tasks.workflow(id)` returns the workflow, which can be a moment after the identifier appears. |
| Another Bureau child | Its `childRunId`. Without `children.delegation`, children nest without limit, and a dispatch's `authority` is ignored. With it, a child may dispatch only as many levels below itself as its grant's `depth` allows, and a child of a top-level parent gets `depth: 0` unless the dispatch passes `authority.depth`. See [Budgets and delegated authority](#budgets-and-delegated-authority). |

Do not take a parent's identifier from `bureau.tasks.workflows()`. It lists every durable run the engine holds, newest first, including other callers' runs and every durable child, so its first item is not necessarily the run you started. Dispatch's principal check does not catch that mistake: it compares the caller's principal with the parent's, not runs, so it accepts a dispatch under another run with the same principal or with none.

A task on a Bureau with no durable engine reports `durability: 'process-local'` and can own children that are process-local too: they die with the process and are not reattached after a restart. Every read and write names the owning parent. Naming an unrelated parent reads as `not-found`, and so does a principal that fails its comparison: on `dispatch`, one other than the parent's, and on every other call, one other than the child record's. A caller cannot tell a wrong identifier from one it is not allowed to see.

The parent's principal, when it has one, owns every child under it: only that principal, or a trusted call, can dispatch there, and every child records that principal. A parent without one, such as a task started without a `principal`, is owned by `anonymous:local`: its children inherit that owner, and only `anonymous:local`, or a trusted call that states no principal, can dispatch under it. Any other principal reads the parent, and every child under it, as `not-found`, and `list` shows it none of them.

A `childRunId` that already names a run or workflow Bureau knows is rejected as `child-run-id-conflict` before anything is reserved, recorded, or started. Dispatching the same `childRunId` under the same parent again, even concurrently, returns `duplicate` with the existing record and starts nothing. That holds whatever the record's status, including a `'failed'` record left by `start-failed`, so a retry after a failed start needs a new `childRunId`.

## Lifecycle states

An Operative child's status is `'running'`, then one of `'completed'`, `'failed'`, or `'aborted'`. `ChildRunHandle.result()` resolves to the child's `RunResult`. The handle has no cleanup acknowledgement of its own: `AgentRun.closed()` on a parent started with a `childRegistry` waits for every child registered in it to finish its own cleanup, as `registry.awaitChildrenClosed()` does. Two failures surface as exceptions after the child is recorded as `'failed'`: when `agent.run()` throws, `dispatchChildRun` rethrows synchronously and returns no handle, and when the child's own `result()` rejects, `ChildRunHandle.result()` rejects with that error.

A Bureau child's `BureauChildRecord.status` uses the same four values. Every status except `'running'` is terminal and absorbing. Bureau maps the child's `finishReason` onto it:

| Child `finishReason`                                     | Recorded `status` |
| -------------------------------------------------------- | ----------------- |
| `'stop-condition'`                                       | `'completed'`     |
| `'aborted'`                                              | `'aborted'`       |
| anything else, including `'maximum-steps'` and `'error'` | `'failed'`        |

`outcome.finishReason` keeps the original value, `outcome.content` keeps the child's final text, and `outcome.reason` explains an end without a clean result: an error message, a cancellation reason, or a recovery decision such as `'workflow missing on recovery'`.

Each record also carries `revision` (starting at `1`, advanced by exactly one on every accepted write), `createdAt`, `updatedAt`, `settledAt`, `reattachedAt`, and `recoveries`. Every write is a compare-and-swap against the stored record, so a stale writer changes nothing.

`record.workflow` says where the child runs. It is `{ kind: 'durable', workflowType: 'agentRun', workflowId }` when Bureau has a durable engine and the catalog agent supports definition resolution (every `createAgent` or `createLazyAgent` result does), and `{ kind: 'process-local' }` otherwise. Bureau has a durable engine when it has persistent `storage`, where durable execution is on by default, or any `storage` with `durable: true`. Only a durable child can be reattached after a restart, and only persistent storage keeps its workflow across one.

A signal channel closes once, with the first of `'completed'`, `'failed'`, `'aborted'`, or `'disposed'`. After that, every send resolves as `channel-closed`, and every emit and registration is inert.

## Observation

Lifecycle events on an emitter, registry descriptors, liveness snapshots, Bureau records, and audit entries are non-consuming: any number of observers read the same facts, and reading them changes nothing. Signal channels are the exception. They are point-to-point, each event name has at most one listener at a time, and a buffered event is delivered once.

- **Operative lifecycle events.** With an `emitter`, `dispatchChildRun` dispatches `multiagent.child-workflow.started`, and then exactly one of `.completed`, `.failed`, or `.aborted`, each carrying `parentRunId` and `childRunId`.
- **Operative discovery.** A `ChildRunRegistry` wired into both the tool and the run backs `AgentRun.children()`, `abortChild()`, `listChildRuns(registry, parentRunId)`, and `snapshot().worstChildAssessment`.
- **Operative child events.** A child's `emit` reaches the parent's `handle.signals.on(name, listener)`. An event emitted before the listener registers is buffered and delivered in order when it does.
- **Typed but never dispatched.** `ChildWorkflowReattachedEvent` and `ChildWorkflowProgressEvent` are exported types with no production emitter. Bureau records reattachment in its audit trail instead.
- **Bureau reads.** `children.list(parentRunId, { principal? })` returns every record for that parent that the principal may see, and returns `[]` for an unknown parent. `children.get(reference)` returns one record or `undefined`. `children.wait(reference, { signal? })` resolves `settled`, `not-found`, `wait-aborted` (the caller's signal fired), or `unobservable`. `unobservable` means the child is still running but nothing in this process is watching it, for example because another Bureau process started it.
- **Bureau audit trail.** When persistence is configured (`storage` or `persistence`), Bureau writes `child.started`, `child.completed`, `child.failed`, `child.aborted`, and `child.reattached` under the child's run identifier. On recovery it can also write `delegation.rejected` and `delegation.revoked`. A dispatch rejected before the child's record is registered writes nothing. `start-failed` is decided after registration, so it writes `child.started` and then `child.failed`. Without persistence there is no audit trail, and `bureau.auditTrail` is `undefined`.

Bureau children are not registered in the parent's `ChildRunRegistry`. The parent `AgentRun`'s `children()`, `worstChildAssessment`, and `closed()` do not see them. Use `bureau.children.list` and `wait`.

## Steering a child with signals

A signal contract names what the parent may send (`signals`) and what the child may emit (`events`), each with a Zod schema. `defineChildSignals` freezes it. Share that exact object between the dispatcher and the child's code, because `readParentSignals(source, contract)` returns a port only for the identical contract object and only for a port a channel created.

- `send(name, payload)` never rejects. It resolves `acknowledged` once the child's handler returns or resolves, or `rejected` with a `code`: `handler-failed`, `invalid-payload`, `unknown-name`, `buffer-full`, or `channel-closed`. A `channel-closed` rejection with `delivered: true` means the handler was already running when the channel closed, so the child may have acted on the signal.
- `emit(name, payload)` returns `emitted` synchronously, with `delivered: false` when it was buffered, or the same rejection shape.
- Every payload is parsed by its schema and then structurally cloned, so the recipient never shares a reference with the sender.
- Each direction buffers up to `DEFAULT_CHILD_SIGNAL_BUFFER_LIMIT` (64) messages while no consumer is registered. `signalBufferLimit` changes the bound, and `0` refuses instead of buffering. A limit that is not a non-negative integer makes `dispatchChildRun` throw `RangeError` before the child starts, and `createChildSignalChannel` throws the same for its `bufferLimit`.
- One handler per signal name and one listener per event name may be registered at a time. `handle.signals.on` and the port's `onSignal` throw `TypeError` for a name the contract does not declare, and `Error` when that name already has a consumer. After the channel closes, a registration for a declared name is inert instead.

In Bureau, register a contract per child agent in `BureauOptions.children.signals`. `children.signal({ parentRunId, childRunId, name, payload })` resolves one of:

| Outcome | Meaning |
| --- | --- |
| `acknowledged` | The child's handler settled. Carries `signalId` and `sequence`. |
| `rejected` | The channel refused it. Carries the channel's `code`, `reason`, and `delivered`. |
| `not-found` | No such child under that parent, or the caller's principal does not match the child record's. |
| `child-terminal` | The child already settled. Carries the record. |
| `unsupported` | `no-signal-contract` when the child's agent has no registered contract; `child-not-live` when it has one but this process holds no channel for the child. |

`children.signal` takes `name: string` and `payload: unknown`. Bureau checks them against the contract at runtime, not at compile time. A signal that is sent but unacknowledged when the process dies is lost. After a restart, Bureau opens a new channel for each recovered durable child before its workflow resumes, and the parent can signal it again.

Session-level steering commands (`bureau.contexts.steer`, for example a model or effort change) are a separate surface for a session's runs. See [Effective context and steering](./runtime-contracts.md#effective-context-and-steering).

## Budgets and delegated authority

Two separate mechanisms bound a child.

**Model-selection authority (Operative).** `DispatchChildRunOptions.delegatedAuthority` passes a `DelegatedAuthority` to the child as `AgentRunContext.delegatedAuthority`. That narrows the providers, models, and maximum effort the child's own selection may use. `attenuateDelegatedAuthority(parent, child)` intersects the provider and model lists and takes the lower effort, so it never widens. `createSubagentTool` applies this for you from the running parent's tool context.

**Delegation grants (Bureau).** Configure `BureauOptions.children.delegation` with an HMAC `secret`, and every `children.dispatch` issues a signed `DelegationGrant` for the child. `authority` on the dispatch supplies the child's `capabilities`, `budget`, `depth`, `delegatedAuthority`, `timeToLiveMilliseconds`, and `disclosurePolicy`. What it can ask for depends on whether the parent holds a grant.

Without `children.delegation`, `authority` is ignored, not rejected. It is not validated, no grant is issued, nothing is reserved against a budget, and the dispatch returns `started` with no `grant`. Depth, fan-out, and capabilities are then unbounded: a child dispatched with `authority: { depth: 0, budget: { concurrentChildren: 0 } }` can still dispatch as many children as it likes, as deep as it likes. The one check that remains is fail-closed: a parent that already holds a grant, left by a Bureau that had delegation configured, cannot dispatch at all (`delegation-invalid`).

A top-level parent, a task, holds no grant. Its dispatches are not checked against any grant and reserve no budget, so nothing bounds how many children it dispatches. Its `authority` sets the child's ceilings as given rather than narrowing anything: an omitted capability list or budget ceiling is unrestricted. `depth` is the exception, because it defaults to `0` under a top-level parent. A child dispatched without `authority.depth` therefore cannot dispatch a child of its own: every dispatch under it is rejected as `depth-exhausted`. Pass `depth: 1` to allow grandchildren, `depth: 2` for one more level, and so on.

A child dispatched while delegation is configured holds a grant, and the dispatches it makes can only narrow that grant. `depth` defaults to the parent's `depth - 1`, and each rule below applies:

- A dispatch under a parent that holds a grant is checked against that grant, and every ancestor's grant is re-verified: signature, revocation, and expiry. An ancestor's grant that is revoked or expired therefore denies every new dispatch in its subtree.
- A parent grant at `depth: 0` authorizes no further child: `depth-exhausted`. A request for more depth, a larger budget ceiling, or a capability outside the parent's allow-list is rejected as `authority-exceeded`, never clamped.
- `delegatedAuthority` is the exception: it is intersected with the parent's through `attenuateDelegatedAuthority`, so it narrows rather than being rejected.
- The child's grant takes the lower of each budget ceiling. Its `expiresAt` is the earlier of the parent's expiry and `now + timeToLiveMilliseconds`, which defaults to one hour. Its `policyVersion` defaults to `'bureau-delegation/1'`.
- `concurrentChildren` is reserved against the parent's grant, and `totalDescendants` against every ancestor's grant, at dispatch, in a durable reserve/release ledger. `concurrentChildren` is released when the child settles; `totalDescendants` never is. An exhausted ceiling is `budget-exhausted`. A ceiling in a child's grant bounds only the dispatches below that child, never its parent's.

Bureau enforces the grant's signature, revocation, expiry, `depth`, `concurrentChildren`, and `totalDescendants`. It records the other fields but does not enforce them on the running child:

- `effectiveCapabilities` (tools, path patterns, network, secrets, admin) is signed and attenuated, but it is not applied to the child's tool calls.
- The grant's `delegatedAuthority` is not passed to the child's model selection.
- The `steps`, `tokens`, `cost`, `toolCalls`, and `duration` ceilings are carried and attenuated, but nothing counts against them.
- Expiry and revocation are checked when a descendant is dispatched and during recovery. Neither stops a child that is already running.

Bureau has no public operation to revoke a grant. The only revocation is recovery fencing a child whose parent cannot be recovered. A grant or budget rejection happens before the child's record exists, so it is returned to the caller and is not written to the audit trail.

Operative's `dispatchChildRun` and `createSubagentTool` issue no grants. The grant helpers (`signDelegationGrant`, `verifyDelegationGrant`, `revokeDelegationGrant`, `attenuateDelegationCapabilities`, `attenuateDelegationBudget`) are building blocks for a dispatcher that owns a durable topology, as Bureau does.

## Cancellation

A child is stopped by a request to that child, never by an accident of shared state.

- **Operative.** `ChildRunHandle.abort()`, `ChildRunRegistry.abortChild(id)`, and the parent's `signal` passed to `dispatchChildRun` each stop only that child. A sibling is never affected. `createSubagentTool` threads the parent tool call's signal through, so aborting the parent run stops its in-flight subagents. `abort()` is a request. Await the handle's `result()` for the outcome. `ChildRunHandle` has no `closed()`, and `result()` can settle before the child's cleanup does, for example while a tool callback that ignores its abort signal is still running. For a cleanup acknowledgement, pass a `ChildRunRegistry` as `dispatchChildRun`'s `registry` and await `registry.awaitChildrenClosed()`, or start the parent with the same registry as its `childRegistry` and await the parent `AgentRun.closed()`. Either waits for every registered child's own cleanup. A dispatch without a registry, like the relay example above, has no cleanup acknowledgement.
- **Bureau.** A Bureau child never receives its parent's abort signal. When a parent is cancelled, Bureau applies each running child's recorded `parentCancellation`: `'cascade'` (the default) cancels the child and applies the child's own policy to its children, and `'detach'` leaves it running and still addressable through the parent's identifier. Recovery has one exception: a child that holds a grant is cancelled when its parent cannot be recovered, even under `'detach'`. See [Recovery](#recovery).

Bureau applies the policy when:

- `bureau.tasks.cancel` aborts a parent this process holds, or commits a cancellation of one only the durable store holds.
- A parent settles as aborted through its own handle (`abort(reason)`).
- `children.cancel` cancels a child that has children of its own.
- A child settles as `'aborted'` for any reason.
- Recovery finds a parent cancelled or unrecoverable.

From the moment its cancellation is requested, a parent admits no new child (`parent-terminal`), even while its own run still reads as running.

`children.cancel` resolves `requested`, `already-terminal`, `not-found`, or `failed`. Only `requested` applies the policy below that child. A cascade that the engine cannot perform is reported through `onDiagnostic`, leaves that subtree running, and is retried when the parent settles.

A parent that finishes normally does not stop its children. They keep running and stay addressable through the parent's identifier, but the finished parent admits no new child. During `dispose()` or `shutdown()`, shutdown ends every live run itself, and the next boot's recovery applies the policy to whatever it left running from the cancelled parent's durable state.

## Recovery

Operative's child primitives do not recover. A process exit ends every in-memory child, its handle, its registry entry, and its signal channel. `DispatchChildRunOptions.durable` is descriptive metadata for events and descriptors; it does not make a child durable.

Bureau recovery never starts a child workflow. At boot it loads every running child record before Weft resumes workflows, then reconciles each one, parents before their children:

- A process-local child, or a durable child whose workflow is missing, is recorded as `'failed'`.
- A durable child whose workflow finished while nothing was watching is recorded with its real outcome. This covers a child that completed while its parent was unavailable.
- A still-running durable child has its grant re-verified and its budget counters reconciled from the ledger. Its signal channel is reopened, and it is reattached, which increments `recoveries` and writes `child.reattached`.
- When the parent cannot be recovered, a child that holds a grant is cancelled, even under `'detach'`. Bureau revokes the grant and writes `delegation.revoked`, or writes `delegation.rejected` when it has no delegation secret or cannot load the grant. This check runs before the cancellation policy.
- Otherwise, when the parent was cancelled or cannot be recovered, the child's `parentCancellation` applies: a `'cascade'` child is cancelled and a `'detach'` child is reattached. Under an unrecoverable parent, only a `'detach'` child without a grant is left running.
- A recovered child whose grant is missing, unreadable, tampered with, revoked, or expired is denied. Bureau writes `delegation.rejected` and cancels the child. A child that has a grant is also denied when the restarted Bureau has no `children.delegation` configured.

Recovery needs the same persistent `storage` (for example SQLite or LMDB) with durable execution enabled, the same agent names, the same signal contracts, and the same delegation secret. A Bureau without storage keeps its topology in memory, so there is nothing to recover. Call `await bureau.recovery()` before presenting recovered state.

## Forking a session at a completed run

`SessionHandle.fork({ throughRun })` creates a new session, with a new identifier and an empty run list, whose conversation holds exactly the history through the completed run at that 0-based sequence. Nothing from a later run is copied, and nothing is shared between the branches afterwards. Without `throughRun`, the fork copies the latest stored history.

An unusable fork point rejects with `ForkThroughRunError` before anything is persisted. Its `reason` is `'invalid'`, `'negative'`, `'out-of-range'`, `'non-terminal'`, or `'unavailable'`. `'unavailable'` means a terminal run has no recorded boundary, as with a legacy run record or a terminal commit with no transcript. A fork is not a child: it has no parent relationship, no signal channel, and no cancellation link. Forking does not replay tool calls or other side effects, and it does not clone an in-flight provider request. It is also distinct from a fresh attempt, context compaction, a subagent summary, and a same-session handoff. See the [Operative README](../packages/operative/README.md#forking-a-session-through-a-completed-run-cor-816) for an example.

## Security and authority boundaries

- **A child gets only what the parent hands it.** A child starts from the input the dispatcher passes, or from `toAgentInput` in `createSubagentTool`. The parent's conversation, instructions, and hooks are not copied into it automatically, and no parent hook reaches a child. `childCorrelation` is correlation data only.
- **A message is data, not authority.** Schemas validate a payload's shape. They do not make its content trustworthy. An acknowledgement means only that the child's handler returned. The recipient decides whether to act, and refuses by throwing. Signals carry no trust classification or provenance beyond the parent-child correlation, so treat a child's event content as an untrusted claim.
- **Sender identity is not authorization.** Bureau checks the principal on every read and write. Operative channels cannot be reached from outside the pair they were built for.
- **The grant is the authority record.** A grant's natural-language `objective` is metadata. When the input is a conversation, the grant carries a SHA-256 `artifactDigest` of it instead. Authority comes from the signed fields, and a record that fails the structural guard or the signature check is treated as no authority: a hard deny with no fallback.
- **Keep the secret stable and private.** Anyone with the delegation secret can mint grants. Rotating it invalidates every existing grant, so dispatches under granted parents fail with `delegation-invalid`, and recovered children with grants are denied and cancelled.
- **Disclosure.** `disclosurePolicy` controls only the grant summary `dispatch` returns. The default `'redacted'` and `'digest-only'` omit the budget, and `'full'` includes it. The stored grant is always complete.

## Configuration

| Setting | Required for | Notes |
| --- | --- | --- |
| `BureauOptions.agents` | Every child | The child's `agentName` must be a key. |
| Persistent `storage` (for example `new BunSQLiteStorage(path)`) with durable execution, the default for persistent storage | Durable children, recovery, and the audit trail | Without a durable engine, children are process-local. `durable: true` over `memory` storage runs children durably, but nothing survives a restart. Without any storage, the topology lives in memory and there is no audit trail. |
| `BureauOptions.children.signals` | `children.signal` | A contract keyed by child agent name. Contracts are code, so they are configured, not persisted. |
| `BureauOptions.children.delegation.secret` | Delegation grants, and any effect of `authority` | A non-empty string; an empty one is a `BAD_REQUEST` at construction. Without `delegation`, `authority` is ignored. |
| `BureauOptions.children.delegation.policyVersion` | Optional | Stamped on every grant. Defaults to `'bureau-delegation/1'`. |
| `BureauOptions.children.delegation.defaultTimeToLiveMilliseconds` | Optional | A positive, finite number. Defaults to one hour. |
| `children.dispatch({ parentCancellation })` | Optional | `'cascade'` (default) or `'detach'`. |

`children.dispatch` throws `BureauError` with `BAD_REQUEST` for an empty `parentRunId`, `agentName`, `childRunId`, or `principal`, an unknown `parentCancellation`, invalid agent input, or, with delegation configured, an `authority` that is not a valid delegation request. The other operations validate their identifiers the same way. Every other expected result is a value, not an exception; a failure of the underlying key-value store rejects the returned promise.

## Failure modes

| Where | Outcome | Cause |
| --- | --- | --- |
| `children.dispatch` | `not-found` | The parent is not a run Bureau knows, or the caller's principal does not match the parent's. |
| `children.dispatch` | `rejected` / `unknown-agent` | No catalog agent has that name. |
| `children.dispatch` | `rejected` / `parent-terminal` | The parent is no longer running, or its cancellation has been requested. |
| `children.dispatch` | `rejected` / `child-run-id-conflict` | The identifier names another run or workflow, or a child of a different parent. |
| `children.dispatch` | `duplicate` | The same child was already dispatched under this parent. Nothing new starts. |
| `children.dispatch` | `rejected` / `delegation-invalid` | An ancestor grant is missing, unreadable, tampered with, revoked, or expired, or the parent holds a grant and no delegation secret is configured. |
| `children.dispatch` | `rejected` / `depth-exhausted`, `authority-exceeded`, `budget-exhausted` | See [Budgets and delegated authority](#budgets-and-delegated-authority). |
| `children.dispatch` | `started` with no `grant`, and the requested `authority` unenforced | `authority` was passed but `children.delegation` is not configured. The request is ignored, not validated or rejected, so nothing bounds the child's subtree. |
| `children.dispatch` | `rejected` / `start-failed` | Starting the child's run threw, for example because Bureau is being disposed. The child was already registered, so the audit trail has `child.started` and `child.failed`, the record stays `'failed'`, and a retry with the same `childRunId` returns `duplicate`. |
| `children.signal`, `send` | `rejected` with a channel `code` | See [Steering a child with signals](#steering-a-child-with-signals). |
| `children.wait` | `unobservable` | The child is running, but not in this process. |
| `children.cancel` | `failed` | The engine could not cancel the child, or no durable engine is available. |
| Recovery | `delegation.rejected` in the audit trail, and the child cancelled | The recovered child's grant no longer verifies. |
| Recovery | `delegation.revoked` in the audit trail, and the child cancelled | The child holds a grant and its parent cannot be recovered, whatever its `parentCancellation`. |
| Recovery | `'failed'` record | The child was process-local, or its workflow is gone. |
| Operative `dispatchChildRun` | Throws `RangeError` | `signals` was supplied with a `signalBufferLimit` that is not a non-negative integer. Nothing is registered, emitted, or started. |
| Operative `createChildSignalChannel` | Throws `RangeError` | `bufferLimit` is not a non-negative integer. |
| Operative `dispatchChildRun` | Rethrows synchronously | `agent.run()` threw. The signal channel is closed as `failed`, the registry entry is settled as `'failed'`, and `multiagent.child-workflow.failed` is emitted first. No handle is returned. |
| Operative `handle.result()` | Rejects | The child's `result()` rejected or threw. The same failure settlement runs first. |
| Operative `handle.signals.on`, the port's `onSignal` | Throws `TypeError` | The contract declares no signal or event with that name. |
| Operative `handle.signals.on`, the port's `onSignal` | Throws `Error` | That name already has a listener or handler. |
| Operative `fork` | `ForkThroughRunError` | See [Forking a session at a completed run](#forking-a-session-at-a-completed-run). |

Bureau reports storage, audit, and cascade failures in the topology through `onDiagnostic` with `scope: 'child-topology'`, or `scope: 'recovery'` during boot. A record, grant, or ledger entry that does not decode is ignored and diagnosed, never trusted.

## Unsupported behavior and compatibility constraints

- **Peer messaging.** Direct peer-to-peer, sibling, broadcast, group, and global-mailbox messaging are not supported (COR-807). Durable peer delivery (COR-812) was canceled. Revisiting this needs a superseding decision with a named scenario the supervisor cannot handle.
- **Collaboration plans.** COR-820's `CollaborationPlan` and `CollaborationMessage` are not implemented.
- **Child events in Bureau.** Bureau has no API to observe a child's `events`.
- **Signal persistence.** Signals are in-memory in both packages. They are not persisted, replayed, or delivered across processes, and signals unacknowledged at a crash are lost.
- **Operative recovery.** Operative's children are not recoverable, and `ChildWorkflowReattachedEvent` and `ChildWorkflowProgressEvent` are never dispatched.
- **Parents Bureau cannot see.** A run that is not a task (a hand-written agent's own run) cannot own Bureau children.
- **Authority without delegation.** Without `children.delegation`, a dispatch's `authority` is silently ignored: no grant, no validation, and no bound on depth, fan-out, or capabilities.
- **Grant enforcement.** Grant capabilities, grant model authority, and the `steps`, `tokens`, `cost`, `toolCalls`, and `duration` ceilings are recorded but not enforced. There is no public grant revocation, no policy-change transition, and no audit record of a dispatch rejected by a grant or budget.
- **Subagents and grants.** `createSubagentTool` has no `signals` option and issues no grants.
- **Session identity.** `SessionHandle` has no `agent.session()` or `bureau.session()` accessor. Construct one with `createSessionHandle`.
- **Compatibility.** The packages are pre-release, private workspace sources. `BureauChildRecord.schemaVersion` is `1` and `DELEGATION_GRANT_VERSION` is `1`. A stored record or grant in any other shape is ignored and diagnosed rather than migrated, and there are no compatibility shims.

## Durable example

This example runs in [`packages/bureau/src/bureau-children-guide.test.ts`](../packages/bureau/src/bureau-children-guide.test.ts), which uses the same code with a different import path and a temporary SQLite file and asserts every commented result. A planner is the durable parent. It dispatches two researchers, inspects them, sends one a typed signal, cancels the other, and waits for the survivor:

```typescript
import { createBureau, type Bureau, type TaskHandle } from '@lostgradient/bureau';
import {
  createAgent,
  defineChildSignals,
  type GenerateFunction,
  readParentSignals,
  stopWhen,
} from '@lostgradient/operative';
import { createTool } from 'armorer';
import { z } from 'zod';
import { BunSQLiteStorage } from '@lostgradient/weft';

/** Never answers, and stops when its run is aborted, as a real provider call does. */
const untilAborted: GenerateFunction = ({ signal }) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
  });

// A task's id is the id of its durable workflow, so the handle names the parent as soon as
// `bureau.tasks.start` resolves. Children can be dispatched under it once the engine has the workflow.
async function durableRunId(
  bureau: Pick<Bureau, 'tasks'>,
  task: Pick<TaskHandle, 'id'>,
): Promise<string> {
  while (!(await bureau.tasks.workflow(task.id))) await Bun.sleep(5);
  return task.id;
}

// Parent → child messages, shared by the dispatching host and the child's tools.
const researchSignals = defineChildSignals({
  signals: { focus: z.object({ topic: z.string() }) },
  events: {},
});

// The researcher waits in a tool until its parent names a topic.
const researcher = createAgent({
  name: 'researcher',
  generate: async ({ step }) =>
    step === 0
      ? { content: '', toolCalls: [{ name: 'await-focus', arguments: {} }] }
      : { content: 'findings are ready', toolCalls: [] },
  tools: {
    'await-focus': createTool({
      name: 'await-focus',
      description: 'Waits for the supervising run to choose a topic.',
      input: z.object({}),
      async execute(_input, context) {
        const parent = readParentSignals(context.executionContext, researchSignals);
        if (!parent) return 'no supervising run';
        return new Promise<string>((resolve) => {
          parent.onSignal('focus', ({ payload }) => resolve(payload.topic));
        });
      },
    }),
  },
  stopWhen: stopWhen.noToolCalls(),
});

// The planner stands in for a long-running supervising agent.
const planner = createAgent({ name: 'planner', generate: untilAborted });

const bureau = await createBureau({
  agents: { planner, researcher },
  storage: new BunSQLiteStorage('bureau.sqlite'),
  children: { signals: { researcher: researchSignals } },
});

const plannerRun = await bureau.tasks.start('planner', 'Plan the corvid report');
const parentRunId = await durableRunId(bureau, plannerRun);

await bureau.children.dispatch({
  parentRunId,
  agentName: 'researcher',
  input: 'Research crows',
  childRunId: 'research-crows',
});
await bureau.children.dispatch({
  parentRunId,
  agentName: 'researcher',
  input: 'Research ravens',
  childRunId: 'research-ravens',
  parentCancellation: 'detach',
});

const children = await bureau.children.list(parentRunId);
// Two records, both `status: 'running'`, each with a durable workflow identity.
const crows = await bureau.children.get({ parentRunId, childRunId: 'research-crows' });
// crows?.parentCancellation === 'cascade', the default

const reply = await bureau.children.signal({
  parentRunId,
  childRunId: 'research-ravens',
  name: 'focus',
  payload: { topic: 'ravens' },
});
// { outcome: 'acknowledged', signalId: 'research-ravens:signal:1', sequence: 1 }

const cancelled = await bureau.children.cancel({
  parentRunId,
  childRunId: 'research-crows',
  reason: 'duplicate work',
});
// { outcome: 'requested', child } — research-ravens is untouched

const ravens = await bureau.children.wait({ parentRunId, childRunId: 'research-ravens' });
// { outcome: 'settled', child: { status: 'completed', outcome: { content: 'findings are ready', ... } } }
const stopped = await bureau.children.wait({ parentRunId, childRunId: 'research-crows' });
// { outcome: 'settled', child: { status: 'aborted', outcome: { reason: 'duplicate work' } } }

const history = await bureau.internals.auditTrail?.query({ runId: 'research-crows' });
// history?.map((record) => record.type) → ['child.started', 'child.aborted']

plannerRun.abort('report planned');
await bureau.dispose();
```

The planner's `generate` and the researcher's scripted `generate` stand in for real providers. `durableRunId` polls because the handle offers no promise that settles when its workflow exists; `Bun.sleep` keeps each wait short, and any short delay works. It reads only the planner's own handle, so other runs and children in the same Bureau cannot change its answer. If the process crashed after the dispatches, a new Bureau opened over the same `bureau.sqlite` file would reattach `research-ravens` without starting a second workflow, and the planner could signal and wait on it again by the same identifiers.
