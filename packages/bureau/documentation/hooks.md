# Hooks

A hook runs an action when a published Bureau event happens (COR-1939, COR-1940): it sends a signed webhook, starts a workflow, or notifies its owner. It is owned by the principal that created it, matches the event kinds `bureau.events` serves (`PUBLISHED_BUREAU_EVENT_KINDS`, described by `bureau.events.catalog`, and the kinds running plugins declare; see "Plugin event kinds"), and keeps every delivery's work, response and attempts on a record that survives a restart. The operations are `bureau.hooks.create`, `update`, `secret.replace`, `delete`, `get`, `list`, `test`, `draft.test`, `deliveries` and `deliveries.retry`; in-process they are `bureau.hooks`.

Turn them on with `hooks` and a storage backend; add `answerEncryption` so signing secrets can be sealed. Delivery uses the HTTP client, retry schedule, clock and shutdown of `webhooks` (which may have no `targets`).

```ts
import { createBureau } from '@lostgradient/bureau';
import { generateEncryptionKey } from '@lostgradient/cryptography';
import { MemoryStorage } from '@lostgradient/storage';

const bureau = await createBureau({
  agents: {},
  storage: new MemoryStorage(),
  durable: true,
  answerEncryption: { current: await generateEncryptionKey() },
  hooks: {},
});

const hook = await bureau.hooks?.create({
  url: 'https://example.com/webhooks/corvidae',
  events: ['run.settled'],
  signingSecret: 'a-secret-only-the-receiver-and-bureau-know',
});
console.log(hook?.id);
```

## Actions

A hook has one `action`, tagged by `type`, fixed when the hook is created. `url` alone is the shorthand for a webhook; `update` changes the fields of the action but never its type.

| `type` | Fields | What a matching event does |
| --- | --- | --- |
| `webhook` | `url`; with a `signingSecret` on the hook | Sends the event, signed, to `url` (the rest of this page). |
| `start-workflow` | `workflowId`, `input?` | Starts the workflow as the hook's owner, with the event as its input. |
| `notify` | `title?` | Writes the owner a notification (kind `hook`), once per delivery. |
| `plugin` | `plugin`, `kind`, `configuration?` | Runs an action kind a plugin contributed (below), with the event. |

A record stored before actions existed has a top-level `url` and no `action`. It reads as a webhook with no migration, and is rewritten in the tagged shape the next time it is changed. Likewise a delivery with no `actionType` is a webhook delivery. A `start-workflow` or `notify` delivery has `work` (what it will do, mapped from the event when the delivery was created) in place of a `request`, and its `completed` attempt a `receipt` naming the run or the notification. Two attempt outcomes (`rejected`, `error`) and one delivery status (`failed`) are for these actions.

## Scope

A hook fires for its event kinds across the whole Bureau unless it names one subject as `scope`: `{ kind: 'agent' | 'workflow' | 'schedule', id }` (the agent's name, the workflow file's identifier, or the schedule's id). A scoped hook fires only for events about that subject (COR-1978), and an event outside the scope makes no delivery.

```ts
import { createBureau } from '@lostgradient/bureau';
import { MemoryStorage } from '@lostgradient/storage';

const bureau = await createBureau({
  agents: {},
  storage: new MemoryStorage(),
  durable: true,
  hooks: {},
});

const hook = await bureau.hooks?.create({
  action: { type: 'notify' },
  events: ['run.settled', 'review.requested'],
  scope: { kind: 'agent', id: 'researcher' },
});
console.log(hook?.scope);
```

What an event is about comes from the event and the Bureau's own records as it is dispatched, never from a client. An agent is the payload's `agentName`, else the agent of the run, schedule or goal the event names. A run's agent is its own: a child run of another agent is that agent's, not its parent's. A workflow is the file of the instance the event's run belongs to, through every run above it, so a review inside a step is that workflow's, or the file whose schedule the event names. A schedule is the one the event names, or the one that fired its run, through every run above it. The event kinds that can be told by each subject are `scopes` in `bureau.events.catalog`. Every kind a scoped hook lists must allow its scope's `kind`, or `create` and `update` refuse with `InvalidParams` on `scope`, so a scope never silently misses a kind the hook asked for. Kinds that are about no one subject (`diagnostic`, `notification.created`, `definitions.changed`, the `asset.*` kinds and so on) allow none, and neither do `session.deleted` and the `steering.*` kinds, which name a chat and no agent, or `run.removed`, because deleting a run deletes the task record a scope would read.

An event the Bureau cannot place is out of scope. A lookup that fails is reported as a `hooks` diagnostic and no scoped hook fires for that event; a hook with no scope is not affected. A subject need not exist when the hook is written, and a scope on an agent, workflow or schedule that is later deleted simply stops matching.

The lookups run once per event and only when a scoped hook lists its kind, so a Bureau with no scoped hooks does not pay for them. `update` takes `scope` (`null` removes it), and on the wire any `scope` in an update needs `bureau.events:observe-all`, because moving or clearing one decides whose events the hook sees.

`scope` is an optional field on the stored record, so a record written before it existed (`version: 1`) reads as a hook with no scope, with no migration. A record with a scope is written as `version: 2`, and one without (a scope cleared with `null` included) as `version: 1`; this release reads both. A record whose scope this release cannot read (a kind it does not know, or a malformed value) stays readable, its pending deliveries are kept, and it never fires. A kind it does not know is kept as stored through a rename or a disable; a malformed value is shown, and rewritten by the next change, as `{ kind: '', id: '' }`, which matches nothing. Such a hook cannot take new `events`, since no event allows its scope, until the `update` also gives it a `scope` or removes it with `null`. A release that predates scopes reads only `version: 1`, so it refuses a scoped record as unreadable rather than firing it for its whole event kinds. That is the same as for any unreadable hook, and it deletes the hook's pending deliveries when it resumes; delete scoped hooks, or clear their scopes, before a rollback.

`bureau.hooks.list` takes the same `{ kind, id }` as `scope` to list the hooks scoped to exactly that subject, and each hook it answers carries `lastDelivery`: its newest delivery, a test included, with its status and last attempt and without its request, work or response body, or `null`. The list reads the delivery records once, one `kv.get` per retained delivery, whatever the number of hooks, so a failing-first view does not need one `bureau.hooks.deliveries` call per hook.

Weft's own events stay out of it. The Bureau's feed publishes Weft's `ScheduleMissedFire` as `schedule.missed` and nothing else of Weft's, and matching the rest needs a subscription to the engine's feed that the Bureau does not make. A hook scoped to a workflow therefore fires for what the Bureau publishes about that workflow's runs and schedule (its agent steps, their reviews, its schedule's fires), and has no event for an instance that starts or finishes by itself.

### Plugin actions

`{ type: 'plugin', plugin, kind, configuration? }` runs an action kind that a plugin contributes (`reactions` in the plugin's contributions; a Bureau takes them as `hooks.actionKinds`). `create` and `update` refuse a kind no plugin contributes, and a `configuration` the kind's schema refuses, with `InvalidParams` on `action.kind` or `action.configuration`; an `update` cannot change the plugin or the kind. Each delivery resolves the kind and parses the configuration again, and calls the kind's `run` with the event, an abort signal, the `deliveryId`, and the `idempotencyKey` `hook:<hookId>:<deliveryId>` (the same key the built-in actions use). A rejection is a failed attempt, retried like any other. A kind that is no longer contributed, or a configuration its schema now refuses, ends the delivery `failed` without a retry. A delivery keeps the whole event for the action (`work.input` on the wire), so deleting a chat deletes it with the others that name the chat's runs. An action runs at least once per delivery: an attempt that succeeded and was interrupted before the delivery was marked delivered (a restart) is attempted again with the same `idempotencyKey`, and two deliveries never share one. An action with an external effect must use the key to make the repeat a no-op, by passing it as the idempotency key of the call it makes or by recording it with the effect and checking first. `hooks.test` tests a plugin hook by calling the reaction's `dryRun`, and a reaction without one cannot be tested (see below).

The context `run` and `dryRun` receive carries `hookId`, `owner` and `attempt` (1-based) beside the event, the configuration, the signal, the `deliveryId` and the `idempotencyKey`. A reaction's `maxAttempts` (an integer from 1 to 20; a plugin that sets another value is skipped with a `setup-failed` problem) is the `maxAttempts` of its new deliveries, which keep it; a test delivery makes one attempt. A delivery's lease covers the longest backoff the engine schedules, and a wait past that (an attempt beyond the engine's own limit) extends the lease of the write that schedules it, so no other process takes the delivery while it waits, and a crashed one is never held for the sum of its attempts.

A reaction's `run` (or `dryRun`) can resolve `{ receipt: { id?, url?, summary? } }` to say what it made (COR-2182). The attempt stores it, `bureau.hooks.deliveries` shows it beside the run or notification identifiers of the other actions' receipts, and the delivery stays `completed` whatever it holds. A field the host does not allow is dropped: an `id` over 200 characters, a `url` that is not an `https:` address or is over 2048 characters, a `summary` over 200 characters, anything that is not text, and a `url` that holds a secret value the attempt resolved (`id` and `summary` have such a value replaced by `[redacted]`). A receipt that dropped a field records one `warn` diagnostic with scope `hooks`, naming the fields and never the values. A member the receipt does not name is not stored.

A hook whose plugin reaction is not registered (its plugin is disabled, was removed, failed to set up or dropped the kind) writes no delivery when its event happens, and `bureau.hooks.list` shows it with a `reaction-unavailable` problem; a default hook its plugin withdrew shows it too. `hooks.list` also shows `configuration-invalid` for a hook whose stored configuration its reaction's schema now refuses (a plugin upgrade changed it), with the `path` and Zod's `code` of each refused field and no message, which can quote a value; a secret field that holds a reference is checked as `create` checks it. A delivery written before the reaction went is still resumed and ends `failed`. A reaction that needs setup is a different case: its deliveries are written and wait.

### Default hooks

A plugin can declare hooks for its owner (COR-2179). `hooks.reconcileDeclared(plugin, declarations)` makes the plugin's hooks what `declarations` say, where a declaration is `{ name, events, reaction, configuration?, scope? }` and `reaction` names one of the plugin's reaction kinds. The `name` is the key: a missing hook is created as `create` would, owned by the deployment's owner of record (`anonymous:local`); a changed declaration replaces the hook in place, with its `id`, `createdAt` and deliveries kept; an unchanged one writes nothing; and a hook the plugin no longer declares is _withdrawn_, which disables it and keeps it, never deletes it. An empty list withdraws all of them. Every declaration is checked as `create` checks it before anything is written, and a refusal is a `HookError` with code `invalid` at `[index, field]`. The Bureau calls it while it starts (COR-2180), for each running plugin, with the `hooks` its descriptor declares that composition accepted: a hook that names a reaction the plugin does not contribute, lists an event kind that is not published, or repeats a name is skipped alone, and a declaration `reconcileDeclared` refuses (a configuration its reaction's schema refuses, a scope) is left out and the rest are reconciled again. Both are the plugin's `hook-invalid` problem, which names the hook and the field and never the reason in words; the plugin and its other contributions load. A plugin that is disabled, or whose setup failed, is not reconciled, because an empty list would withdraw its hooks; a plugin the host no longer gives to the Bureau at all is reconciled with an empty list, so its default hooks are withdrawn. A refusal never fails the Bureau.

A default hook's `id` is `default-` and the first 32 hexadecimal digits of SHA-256 over the plugin, a NUL byte and the name, so two processes that reconcile one plugin write one hook (the create is conditional on the id being free), and a loser of a race reads the hook again and decides again. A write that loses its compare-and-swap does the same, so an owner's disable that won the race survives. Within one call the order is creates and replaces in declaration order, then withdrawals oldest first: an interruption leaves a hook too many firing, never one too few, and the next call finishes.

A hook carries `declaredBy: { plugin, ownerDisabled?, withdrawn? }` and is stored as version 3, which a release that predates default hooks refuses (it cannot read it, so it deletes the hook's pending deliveries as it does for any record it cannot read). A version 1 or 2 record that carries `declaredBy`, and a version 3 record without a valid one, are refused. The owner may only turn a default hook on or off: `update` refuses every field but `enabled` (and `expectedRevision` and `principal`) with a `HookError` of code `invalid` at that field, `enabled: false` sets `ownerDisabled`, which a replace keeps, `enabled: true` clears it, and a withdrawn hook cannot be enabled. `delete` is refused with `invalid` at `declaredBy`. `bureau.hooks.get` and `bureau.hooks.list` show `declaredBy` as `{ plugin, ownerDisabled, withdrawn }` (`null` for an owner's hook). `hooks.duplicate(hookId, { name? })` (the wire's `bureau.hooks.duplicate`, COR-2181) makes an owner's hook from one, with the same action, events and scope, named `name` else as the hook is, disabled, and no `declaredBy`; it is checked as `create` is, so the copy of a hook whose plugin no longer offers its action is refused. `duplicate` takes `expectedRevision` as `update` does, and the wire operation passes the revision it authorized the copy on, so a hook that changed between that read and the copy is refused with `stale-revision` (`StaleRevision` on the wire) and nothing is made. A default hook whose plugin contributes none of its reactions (the plugin is disabled, or its setup failed) matches no event and writes no delivery, and the loop guard applies to it as to any plugin hook.

### The event's `source`

An event a plugin caused carries `source: '<plugin>'` beside `kind` and `payload`; an event from Bureau core carries no `source` at all. Each plugin gets its own host API, the `host` of its setup context and the API its `start` receives, so a contributed tool can call it too, and what that API causes is the plugin's: the `schedule.created` of a schedule it creates, and every `goal.*` event of a goal it creates. A goal's record stores the plugin, so the events of its later transitions, after a restart as well, keep the `source`. The runs a plugin-created schedule fires are not marked, and neither is what a contributed tool, activity or hook action does without the host API. The field is the envelope's. It is not a payload field and a hook cannot filter on it: hooks match on `kind` only. A webhook body gains `source` only when the event has one, and so does the `{ kind, bureauId, emittedAtMs, payload }` input of a `start-workflow` hook with `input: 'event'`. (`definitions.changed` names which file catalog changed in its payload's `catalog` field, so that its payload does not use the name.)

### Start a workflow

```ts
import { createBureau } from '@lostgradient/bureau';
import { generateEncryptionKey } from '@lostgradient/cryptography';
import { MemoryStorage } from '@lostgradient/storage';

const bureau = await createBureau({
  agents: {},
  storage: new MemoryStorage(),
  durable: true,
  answerEncryption: { current: await generateEncryptionKey() },
  hooks: {},
});

// A Bureau with a workflow directory; `lookup` is a ready workflow in it.
const hook = await bureau.hooks?.create({
  events: ['definitions.changed'],
  action: { type: 'start-workflow', workflowId: 'lookup', input: 'payload' },
});
console.log(hook?.action);
```

- **Input.** `input: 'payload'` (the default) starts the workflow with the event's `payload`, the object `bureau.events.catalog` gives for its kind. `input: 'event'` starts it with `{ kind, bureauId, emittedAtMs, payload }`. There is no further projection: the workflow's `inputSchema` (COR-1812) is the contract, and a workflow that wants less declares less.
- **Invalid input.** Input the workflow's `inputSchema` refuses is a permanent failure, since the same event gives the same input: the attempt is recorded `rejected` with the issues in `error`, the delivery ends `failed`, nothing is started, and nothing is retried. The loop goes on to the next event. A workflow that is missing or paused when the event fires fails the same way. An engine error is retried with the usual backoff and ends `exhausted`.
- **At most one run per delivery.** A start carries Weft's `idempotencyKey` `hook:<hookId>:<deliveryId>`. A retry, or the attempt that follows an interrupted one after a restart, is answered with the run the first start made and starts no second. The delivery looks the key up (`bureau.workflows.findStart`) before it validates anything, so a start that committed before the delivery's receipt was written is delivered with its run even if the workflow file has since been edited, paused, or deleted; a lookup that fails is retried, never recorded as a failure. A delivery is made once per hook for each time the Bureau publishes the event, so a kind that is published more than once for one occurrence is delivered more than once: the `goal.*` events are at-least-once (a duplicate delivery of a transition the store already holds is dispatched again), and a hook on one starts a run for each. The idempotency key does not join two deliveries. A restart resumes its deliveries after the workflow files are loaded, and holds the events published while they load (the session outbox is replayed at boot, for one) until they are, so a start is never refused as a workflow that does not exist yet.
- **Authority.** The run is started as the hook's owner (`origin: { kind: 'person', principal: <owner>, surface: 'api' }`), never as whatever the event concerns. It is checked twice: when the hook is written (the owner may start workflows, and the workflow is ready and unpaused) and again for every delivery. In v1 the Bureau knows an owner but not the scopes its credential held, so it cannot re-check a scope when an event fires: the only owner that may have a `start-workflow` hook is the deployment's owner of record, `anonymous:local`, who owns the deployment's workflows. Another owner's `create` is `Forbidden` (`data.reason: "workflow authority"`), even from a key holding `bureau.workflows:write`. On the wire the caller must also be allowed to start workflows (it owns the deployment's, or holds `bureau.workflows:write`), so a key with only `bureau.hooks:write` cannot point another owner's hook at a workflow. The caller's authority is asked when the action is set (`create`, or an `update` that sends `action`); re-enabling or re-scoping a hook that already has one needs only `bureau.events:observe-all`, as for any hook, because the run is the owner's and the owner's authority is checked for every delivery.
- **No test delivery.** `hooks.test` is for webhooks, and for plugin hooks whose reaction has a `dryRun`: for a `start-workflow` or `notify` hook it would start a real run or write a real notification, so it is refused.
- **No chains.** A `start-workflow` hook acts only on an event the Bureau can place, so a workflow it starts can never start itself again, however the events loop. Every published kind has an `origin` in `bureau.events.catalog`:
  - `run`: the payload names a run (`runId`, `goalRunId` or `taskId`, present on every event of the kind). The hook follows it up through the runs it belongs to (an `agent` step of a workflow, a child run, a goal attempt) to the workflow instance. A hook starts that instance tagged `hook-origin:<hookId>`, so if the trail reaches a tag the hook starts nothing. The trail also crosses a schedule (COR-1952): a schedule that a hook-started run creates, with `bureau:workflows-create` or `bureau:workflows-update` for a `schedule` trigger or with `schedules.create` given `createdByRun`, records the hook that started that run (the Bureau key `bureau-hook-schedule-origin:v1:…`, `{ "version": 1, "hookId": … }`), and a run the schedule fires, with everything beneath it, reads as that hook's. Its fires therefore start no `start-workflow` hook, at any interval. A schedule with no record (one an owner made) is not a hook's, and its fires start hooks as before. A workflow `create` without an origin clears any record left under its identifier; an `update` without one keeps it, so a file a hook-started run wrote stays a hook's until it is created again. If the Bureau cannot tell whether the calling run was started by a hook, the record names the hook `unknown`. A `run` event that names no run is skipped the same way, with the reason `names no run`.
  - `run`, continued (COR-2096): `run.tripwire`, `run.guardrail`, `budget.threshold`, `tool.policy-denied` and `tool.error` are `run` kinds, scoped to an agent, a workflow or a schedule. Each names its `runId` and a `step`, and none carries free text: a guardrail's flagged text, a policy's reason, a tool call's arguments and an error's message never cross.
  - `run`, continued (COR-2097): `multiagent.child-workflow.started`, `.completed`, `.failed` and `.aborted`, `multiagent.handoff.occurred`, `hook-plan.failed`, `goal.feedback.recorded` and `goal.retrying` are `run` kinds. A child run's events name no `runId`: they name the run that dispatched it, as `parentRunId`, which the hook follows up the way it follows a `runId`, and which a scope and a workspace read as the run they are about. None carries free text: a child's prompt, a rejection's message, an abort reason, a hook's error and a validator's feedback never cross (`finishReason`, `errorCode` and the goal digest are what they publish).
  - `run`, continued (COR-2251): `scorer.threshold-breached` is a `run` kind, scoped to an agent, a workflow or a schedule, published once for each scorer whose score of a completed run is a `fail` or falls below the scorer's alert threshold, after the score's `scorer.recorded` audit record has been written. It carries `runId`, `scorerName`, `scorerVersion`, `outcome` (a validator outcome kind) and `score` when the scorer gave one, and never the scorer's message, its threshold, its digest or anything of the run's content. A run that settles `failed` or `canceled` is not scored, so it publishes none.
  - `run`, continued: `run.completed`, `run.error` and `run.aborted` (COR-2095) are `run` kinds, scoped to an agent, a workflow or a schedule, published once for a settled run just before `run.settled`. `run.error` carries `runId`, `finishReason`, and `step`, `errorKind` (an error kind from a fixed list) and `errorCode` (an identifier) when the run's own failure named them, and no error text, because a delivery is kept and sent where a leak cannot be recalled: a hook that needs the failure's message reads it from the task, by `runId` (`bureau.tasks.get`, its `statusMessage`). A hook that lists `run.error` and `run.settled` gets two deliveries for one failed run, in no fixed order. A run is announced once for each settlement that stands, so a run whose owner was lost and then settled for real by its stalled owner is announced on two Bureaus' feeds.
  - `external`: a short allowlist of kinds that no run, tool or action of a run can cause: `schedule.missed` (downtime or a daylight-saving gap swallowed the occurrences) and `bureau.disposed` (only the host disposes a Bureau). There is nothing to follow, and the hook acts on them.
  - `unattributed`: every other kind, and the default for a new one (fail closed). A run could cause it and nothing on it leads back to the run: `notification.created`, `diagnostic`, `memory.governance`, `decision.made` (a decision names a task only when it was asked for one), `definitions.changed` (a run's `bureau:workflows-create` tool writes the files it reports), `schedule.attempted` and `schedule.skipped` (a run can create a schedule), `schedule.created`, `schedule.paused`, `schedule.resumed`, `schedule.cancelled`, `session.created`, `session.saved`, `session.deleted`, `steering.accepted`, `steering.applied`, `steering.rejected`, `steering.superseded`, `steering.failed` (each names a session, never a run), `workflow.version-mismatch` (it names a workflow and no run), `secret.set`, `secret.removed`, `plugin.settings-changed` and `plugin.status-changed` (a host reports them for its plugins, and they name a plugin, never a run), the `skill.*` kinds, the `asset.*` kinds and the `trigger.*` kinds (a run can write the file whose listener starts or stops, or cause the delivery that fires it, and only some carry a `runId`). A `start-workflow` hook cannot list one: `create` and `update` refuse it with `InvalidParams` on `events`, and a stored record that lists one anyway is skipped when the event fires. (A `notify` hook on `run.settled` and a `start-workflow` hook on `notification.created` would otherwise start a run for every run the first one's workflows made.)

  A skip is on the record, not silent: the delivery is still written and ends `failed` with one `rejected` attempt whose `error` begins `Skipped:`, `work.skip` holds the same text (on the wire, `work.skip` is a string for a skipped `start-workflow` delivery and `null` otherwise), no run is started, and the Bureau reports a `warn` diagnostic with scope `hooks`. A run whose origin cannot be read is skipped the same way, with the reason `could not tell`. So a hook on `run.settled` that starts a workflow with an `agent` step starts exactly one run for each run a person or an owner's schedule starts, and the runs it starts raise events that start nothing. The guard is the Bureau's, not the owner's: it applies to every `start-workflow` hook and only to that action. `webhook` and `notify` hooks still fire for the events of a hook-started run, and may list any kind (a `notify` hook but for `notification.created`). What the guard cannot see is a start that carries no tag: a workflow that starts another workflow some other way, and `schedule.missed`, an `external` kind with no run to follow, so a hook listing it still acts on a missed occurrence of a schedule a hook-started run created.

### Notify me

`{ type: 'notify', title? }` writes a notification to the hook's owner through `bureau.notifications` (COR-1941): `kind: 'hook'`, the title (the action's; else the title of the plugin formatter that claims the event's kind (COR-2178); else `Event <kind>`), and a body that is that formatter's `body` when it gives one, and otherwise names the hook, the kind and the Bureau. The formatter runs on the event as the hook's owner sees it (`eventForHookOwner`), when the delivery is made, and its words are stored on the delivery, so a retry stores what the first attempt did; a formatter that throws is reported to `diagnose` and the notification keeps its own words. Both are cut to what a notification holds. The `notify` words carry nothing of the payload beyond what a formatter chose to say. The owner is the hook's and nothing in an event can name another. The write is keyed `hook:<hookId>:<deliveryId>`, so a replayed delivery writes one notification.

A notify hook cannot list `notification.created`: the notification it writes is announced by that event, so the hook would write one for each. `create` and `update` refuse it with `InvalidParams` on `events`, and dispatch skips a notify hook whose record lists it anyway. It cannot list `hook.delivery.failed` or `hook.delivery.gave-up` either, for the reason under "Failures are events".

### The event catalog

`bureau.events.catalog` (in-process, `bureauEventCatalog()`) lists exactly `PUBLISHED_BUREAU_EVENT_KINDS`, in the same order, each with a description, its `origin` (`run`, `external` or `unattributed`; see "No chains") and the fields of its `payload` (name, JSON type, and whether it is optional). The operation then lists the kinds the running plugins declare through their `events` contribution (COR-2223), each `plugin:name` with a `source` naming the plugin, the same payload fields, `origin: "unattributed"` and no scopes; `bureauEventCatalog()` itself stays the core kinds. Each also carries the `version` a hook that lists it pins. A plugin publishes a declared kind through `host.publish` (COR-2224), `bureau.events` serves it, and a hook may list it (COR-2226; see "Plugin event kinds"). It is read-only, and any authenticated caller may read it. The record that holds it is typed over the published kinds and a test compares it with the constant, so a new published kind has no way to ship undescribed.

Weft's own event kinds (run, workflow and schedule events) are out of scope for hooks. The Bureau's feed carries one of Weft's, `ScheduleMissedFire`, as `schedule.missed`; matching the rest needs a subscription to the engine's own feed, which the Bureau does not make today.

### Plugin event kinds

A hook may list a kind a running plugin declares (COR-2226), `<plugin>:<name>`. The hook stores it pinned to the declaration's version, `<plugin>:<name>@<version>` (`reports:digest-ready@1.0.0`), where the version is the declaration's own `version`, else its plugin's, the rule COR-1879 set for every contribution; `bureau.events.catalog` gives it as `version`. `create` and `update` accept the kind bare and pin it, or pinned at the version loaded now; a kind no running plugin declares is `InvalidParams` on `events`. Each kind is listed once.

A pinned kind fires for an event of its kind only while its plugin is loaded at the pinned version, and never for another plugin's kind: a kind is namespaced by its plugin, so `reports:digest-ready` and `other:digest-ready` are two kinds. A pinned kind whose plugin is not loaded, or is loaded at another version, is _missing_: it fires nothing, the hook's other kinds still fire, and `hooks.list` shows an `event-missing` problem naming the entry and the version loaded now (`loadedVersion`, absent, `null` on the wire, when no running plugin declares the kind). The hook stays on. An `update` that lists the missing entry again keeps it, so the hook still saves; one that names the kind bare pins it to the version loaded now, which repairs it. A missing pin is refused anywhere else: on `create`, on a new entry of an `update`, and so on `duplicate`, which is checked as `create` is.

A plugin's default hook may list a declared kind too, its own plugin's or another running plugin's. Composition refuses a kind no running plugin declares (`hook-invalid` at `events`), and `reconcileDeclared` pins each declared kind to the version loaded as it reconciles, so a plugin upgrade re-pins the hook in place and an unchanged one writes nothing. A plugin kind has origin `unattributed` and no scopes, so a `start-workflow` hook and a scoped hook cannot list one.

## The signing secret

Only a `webhook` hook has one; it is refused for any other action. A webhook created without one gets a secret the Bureau generates (`generateHookSigningSecret`: `whsec_` and 24 hexadecimal digits from the operating system's random source), returned once as `signingSecret` on the `create` answer (`null` there otherwise) and never again, so a person copies it then. `bureau.hooks.secret.replace` (`hooks.replaceSigningSecret` in-process) makes a new one the same way, answers the hook with it once, and the old one stops signing at once; it takes `expectedRevision` as `update` does (COR-2009). A caller may still choose the secret (16 to 256 characters) and send it with `create` or `update`, and that one is never returned. Every secret is write-only: Bureau seals it with the scheme secret answers use (AES-GCM under `answerEncryption.current`, bound to the hook so a ciphertext copied to another hook does not open), keeps only the ciphertext, and returns it from nothing: not an operation, a record, a log line, a diagnostic, or an audit entry. A response body or an error message that repeats the secret has it removed (`[redacted]`) before it is kept.

Where the ciphertext lives is the host's choice: `hooks.secrets` is a `HookSecretStore` port, and without one Bureau keeps it in its own key-value store. A host whose secrets live outside Bureau, as a remote Interborough home's do, makes the port's `writeLock()` answer `deployment`; a `create` or `update` that writes a secret is then refused (`HookError` code `locked` in-process, `Forbidden` with `data.reason: "deployment"` on the wire) and nothing is written. A change that writes no secret still works.

## The request

Each delivery is `POST <url>` with `Content-Type: application/json` and this body, which is the same text on every attempt:

```json
{
  "id": "<delivery id>",
  "hookId": "<hook id>",
  "kind": "run.settled",
  "bureauId": "<bureau id>",
  "emittedAtMs": 1800000000000,
  "test": false,
  "payload": {}
}
```

`payload` is the event as `bureau.events` serves it. Headers:

| Header                      | Meaning                                                           |
| --------------------------- | ----------------------------------------------------------------- |
| `X-Signature`               | `t=<unix seconds>,v1=<hex>`; see below                            |
| `X-Hook-Id`, `X-Event-Kind` | The hook and the event kind                                       |
| `X-Delivery-Id`             | The delivery's id, the same on every attempt                      |
| `Idempotency-Key`           | The delivery's id again, for receivers that dedupe by that header |
| `X-Delivery-Attempt`        | 1 for the first attempt, 2 for the next                           |
| `User-Agent`                | `corvidae-hooks/1`                                                |

## `X-Signature`

```
X-Signature: t=<unix seconds>,v1=<lowercase hex>
v1 = HMAC-SHA256(key = the signing secret as UTF-8, message = "<t>.<raw request body>")
```

- `t` is the whole Unix seconds at which this attempt was signed. A retry is signed again, so a receiver's replay window never rejects it for being old.
- Reject a request when `|now - t|` is more than **300 seconds** (replay protection), and compare the digest in constant time.
- A header may carry several `v1=` parts, and parts the receiver does not know are ignored; accept the request when any `v1` matches.
- Verify the raw body exactly as received, before parsing it. Changing one byte of the body or the timestamp changes the digest.

A receiver that uses Bureau's package verifies like this:

```ts
import { verifyHookSignature } from '@lostgradient/bureau';

export async function receive(request: Request, secret: string): Promise<Response> {
  const body = await request.text();
  const header = request.headers.get('X-Signature') ?? '';
  const verified = verifyHookSignature({ secret, header, body });
  if (!verified.ok) return new Response(verified.reason, { status: 401 });
  const event: unknown = JSON.parse(body);
  console.log(event);
  return new Response('ok');
}
```

and one that does not verifies with the platform. `crypto.subtle.verify` compares the digest in constant time, and the timestamp is checked against the replay window first:

```ts
const TOLERANCE_SECONDS = 300;

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

export async function verify(secret: string, header: string, body: string): Promise<boolean> {
  const parts = header.split(',').map((part) => part.trim().split('='));
  const timestamp = Number(parts.find(([name]) => name === 't')?.[1]);
  // Written so a missing or non-numeric `t` fails the comparison instead of passing it.
  if (!(Math.abs(Date.now() / 1000 - timestamp) <= TOLERANCE_SECONDS)) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const message = new TextEncoder().encode(`${timestamp}.${body}`);
  for (const [name, value] of parts) {
    if (name !== 'v1' || value === undefined || !/^[0-9a-f]{64}$/.test(value)) continue;
    if (await crypto.subtle.verify('HMAC', key, hexBytes(value), message)) return true;
  }
  return false;
}
```

## Delivery, retries and restarts

A 2xx answer is delivered. Any other status, a network error, or a timeout (10 seconds by default, `hooks.requestTimeoutMilliseconds`) is a failed attempt, retried with the notifier's backoff up to its `maxAttempts` (8 by default, `DEFAULT_WEBHOOK_MAX_ATTEMPTS`: one rule for every delivery, up to 8 tries with backoff), then `exhausted` (also audited as `hook.delivery.exhausted`, filed under `hook:<id>`, without the URL). A redirect is a failed attempt and is never followed. `bureau.hooks.test` sends one `hook.test` delivery with one attempt and no retry, even to a disabled hook.

`bureau.hooks.draft.test` (`hooks.testDraft` in-process; COR-2022) sends the same `hook.test` message to a webhook URL before its hook is saved, so a person can check the receiver while writing the hook. It makes one attempt and writes nothing: no hook, no delivery record, no secret, no audit entry. Its answer is the delivery as it would have been recorded, with `hookId` `draft` (`HOOK_DRAFT_ID`), which is also the body's `hookId` and the `X-Hook-Id` header. It is signed with the `signingSecret` the caller gives, or with one generated for that test alone and then forgotten, because a hook's own secret is made when it is first saved. The URL and the secret are refused as `create` refuses them, and it needs `bureau.events:observe-all`, as `create` does.

While a `pending` delivery waits out its backoff after a failed attempt, its record carries `nextAttemptAt`, the epoch milliseconds the next attempt is due (`null` on the wire otherwise); the next write drops it. A record written before it existed has none.

### Failures are events

A failed delivery is published on `bureau.events` as two kinds (COR-2099), both `unattributed` and with no scope, so a hook can list them and the feed carries them.

- `hook.delivery.failed` goes out for each attempt that did not deliver, after the write that records it: `{ hookId, deliveryId, attempt, outcome, status? }`. `outcome` is `response` (a non-2xx answer, a redirect included, with its HTTP `status`), `network-error`, `refused` (the URL policy refused it at send time), `error` (a reaction threw or timed out, or a start or notify failed in a way a retry may change) or `rejected` (a permanent refusal, a missing plugin action kind, an unavailable workspace authority). It never carries the attempt's error text, a response excerpt or the URL: those can hold a token, and an event is pushed to hooks and webhooks where a leak cannot be recalled. The attempt keeps them on the delivery record.
- `hook.delivery.gave-up` goes out when a delivery ends `exhausted`, after the `hook.delivery.failed` of its last attempt and beside its `hook.delivery.exhausted` audit entry: `{ hookId, deliveryId, attempts }`. `attempts` counts the attempts the record holds, an interrupted one included, so it can exceed the number of `hook.delivery.failed` events. A manual retry of an exhausted delivery that fails again publishes both again, with the new count.

Nothing is published for an attempt that was interrupted by a shutdown, aborted because its hook was disabled or deleted, or released while a plugin needs setup; for a delivery whose write lost its fence to another process (the process that committed the write publishes); for a `hooks.test` or `hooks.draft.test` delivery; for a `start-workflow` delivery written with a skip (a decision already reported as a notice); or for a `failed-secret` delivery. A publication is at most once: a crash between the write and the publish loses the event, and a restart does not repeat it. A publish that throws goes to `diagnose` and changes nothing else.

The loop guard: a delivery of a `hook.delivery.*` event never publishes either kind. A hook that lists its own failures, or two hooks that list each other's, deliver once for each failure of the original delivery, settle, and publish nothing more. The guard reads the stored delivery's `kind`, so it holds for a delivery that is resumed or taken over by another process. A `notify` hook cannot list a `hook.delivery.*` kind (`create` and `update` refuse it with `InvalidParams` on `events`, and dispatch skips a stored one), because a failing webhook on `notification.created` would otherwise fail once for each notification the notify hook wrote, `maxAttempts` times over, without end. A `start-workflow` hook cannot list them either, since both are `unattributed`, and a scoped hook cannot, since they name no agent, workflow or schedule.

Any owner's hook that lists a kind receives the identifiers of other owners' hooks and deliveries, and creating one needs `bureau.events:observe-all`. Under a workspace authority the projection drops both kinds for every hook, the failing hook's owner included, because no field of either names an owner (as for `notification.created`).

`bureau.hooks.deliveries.retry` (`hooks.retryDelivery` in-process; COR-2022) sends one of a hook's deliveries again **from its record**: the request (or, for the other actions, the work) recorded when the delivery was made, with the same body, `X-Delivery-Id` and `Idempotency-Key`, never one rebuilt from the hook as it is now, so a hook whose URL changed since is retried to the URL the delivery recorded. A webhook's retry is signed with the hook's current secret. A delivery that was not delivered (`exhausted`, `failed`, `aborted` or `failed-secret`) is opened again with `maxAttempts` raised by one, under the same compare-and-swap fence as any write, and that one attempt is made at once; the answer is its record once the attempt has ended. A `pending` delivery that this process is waiting to retry has its backoff cut short and is answered at once; one whose lease has run out is taken and driven, as a restart would; one whose attempt is in flight is left to it. A `delivered` delivery is `InvalidParams` on `deliveryId`, and a delivery that is not the named hook's is `NotFound`. Each retry is audited as `hook.delivery.retried`. A delivery is never copied: its record is the one the receiver may have seen, under the key it can drop a repeat by.

A delivery record keeps the request without its signature, each attempt's outcome, status, and the first 1024 bytes of the response, and the owner. Records survive a restart. A restart resumes every `pending` delivery whose lease has run out, under one rule: **one attempt record produces at most one HTTP request.** An attempt is written as `sending` before the request is made; a restart that finds one still `sending` does not know its outcome, closes it as `interrupted` (it counts toward `maxAttempts`), and sends the next attempt under a new number, a new timestamp and the same `Idempotency-Key`. A receiver that saw the interrupted request can drop the repeat by that key. A process that stops cleanly releases its leases; one that crashes leaves them to expire. A restart inside that window leaves such a delivery alone at first and scans again when the earliest lease runs out (and again for any that remain), so a quick restart does not leave it pending until the next one; a shutdown cancels the wait. The restart finds its pending deliveries through an index key (`bureau-hook-delivery-pending:v1:<deliveryId>`) that is written in the same batch as the record, so it reads no settled record; records written before the index existed are indexed once, on the first restart. `retention.hookDeliveries` (`{ olderThan }` in milliseconds, a live setting, unset by default) removes settled deliveries last written longer ago than the window at each maintenance pass; a `pending` delivery is never removed, whatever its age.

Events that happen while the Bureau is down are not replayed.

Deleting a chat (`bureau.contexts.delete`) deletes the deliveries of events about its runs (COR-1953), a `pending` one included, so its retry sends nothing; a request already in flight cannot be recalled. The record holds only identifiers, but it names the chat's runs. A delivery of the hook's other events, a `notify` delivery (it names no run), the hook and its secret stay. See `external-control-plane.md`.

Rolling back to a release that predates actions is safe only for webhook hooks. A webhook hook's record also keeps its `url` at the top level, which that release reads, and a change it makes to the `url` is read back by this one. A `start-workflow` or `notify` hook has no `url`, so the older release cannot read it, treats it as unreadable, and deletes its pending deliveries when it resumes; delete those hooks, or disable them and let their deliveries finish, before a rollback. A hook with a `scope` is stored as `version: 2` (a hook without one as `version: 1`), which a release that predates scopes does not read, webhook hooks included; clear its scope or delete it before a rollback.

## Which URLs

`http` or `https`, with a host, no user name or password, no fragment, and at most 2048 characters. Link-local addresses (`169.254.0.0/16`, which holds the cloud metadata endpoint `169.254.169.254`, and `fe80::/10`), the IPv6 metadata endpoint `fd00:ec2::254`, the unspecified addresses and multicast are always refused, even when private networks are allowed: a metadata endpoint is never a legitimate local receiver. Loopback and private-network addresses are **allowed by default**, because a local receiver is the main use of a local-first Interborough; a hosted deployment, a remote Interborough home included, **must** pass `hooks: { urlPolicy: { allowPrivateNetworks: false } }` when it enables hooks, because the default exists for the person's own machine and would otherwise let a hook reach the deployment's internal network. The check reads the URL, not the network: a hostname that resolves to a refused address is not caught, and redirects are never followed. The policy is applied when a hook is created or changed and again when a delivery is sent.

## Who sees what

A hook, and its deliveries, belong to the principal that created them and are visible to nobody else without `bureau.hooks:read` (`get`, `list`, `deliveries`) or `bureau.hooks:write` (`update`, `delete`, `test`, `deliveries.retry`); see the predicate table in `external-control-plane.md`. A hook observes the whole Bureau's events, so anything that decides where they go also needs `bureau.events:observe-all` of the **caller**, whoever created the hook: `create`, and an `update` that sets `url`, sets `action`, sets `events`, sets `scope`, or sets `enabled: true`. Renaming, replacing the secret (with `update` or `secret.replace`) and disabling need no such scope, and neither does `test`, which sends a fixed message and never an event, nor `deliveries.retry`, which re-sends what a delivery already recorded. `draft.test` names no hook, so it needs the scope as `create` does. Without this a key holding only `bureau.hooks:write` could re-point another owner's fleet-wide hook at its own URL. The audit entries (`hook.created`, `hook.updated`, `hook.deleted`, `hook.tested`, `hook.delivery.retried`) name the caller as the actor and the hook's owner in their detail; the actor is left out when the credential names none.
