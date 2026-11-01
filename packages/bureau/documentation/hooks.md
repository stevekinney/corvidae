# Hooks

A hook runs an action when a published Bureau event happens (COR-1939, COR-1940): it sends a signed webhook, starts a workflow, or notifies its owner. It is owned by the principal that created it, matches the event kinds `bureau.events` serves (`PUBLISHED_BUREAU_EVENT_KINDS`, described by `bureau.events.catalog`), and keeps every delivery's work, response and attempts on a record that survives a restart. The operations are `bureau.hooks.create`, `update`, `delete`, `get`, `list`, `test` and `deliveries`; in-process they are `bureau.hooks`.

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

What an event is about comes from the event and the Bureau's own records as it is dispatched, never from a client. An agent is the payload's `agentName`, else the agent of the run, schedule or goal the event names. A run's agent is its own: a child run of another agent is that agent's, not its parent's. A workflow is the file of the instance the event's run belongs to, through every run above it, so a review inside a step is that workflow's, or the file whose schedule the event names. A schedule is the one the event names, or the one that fired its run, through every run above it. The event kinds that can be told by each subject are `scopes` in `bureau.events.catalog`. Every kind a scoped hook lists must allow its scope's `kind`, or `create` and `update` refuse with `InvalidParams` on `scope`, so a scope never silently misses a kind the hook asked for. Kinds that are about no one subject (`diagnostic`, `notification.created`, `definitions.changed`, the `asset.*` kinds and so on) allow none, and neither do `session.deleted` and `steering.accepted`, which name a chat and no agent, or `run.removed`, because deleting a run deletes the task record a scope would read.

An event the Bureau cannot place is out of scope. A lookup that fails is reported as a `hooks` diagnostic and no scoped hook fires for that event; a hook with no scope is not affected. A subject need not exist when the hook is written, and a scope on an agent, workflow or schedule that is later deleted simply stops matching.

The lookups run once per event and only when a scoped hook lists its kind, so a Bureau with no scoped hooks does not pay for them. `update` takes `scope` (`null` removes it), and on the wire any `scope` in an update needs `bureau.events:observe-all`, because moving or clearing one decides whose events the hook sees.

`scope` is an optional field on the stored record, so a record written before it existed (`version: 1`) reads as a hook with no scope, with no migration. A record with a scope is written as `version: 2`, and one without (a scope cleared with `null` included) as `version: 1`; this release reads both. A record whose scope this release cannot read (a kind it does not know, or a malformed value) stays readable, its pending deliveries are kept, and it never fires. A kind it does not know is kept as stored through a rename or a disable; a malformed value is shown, and rewritten by the next change, as `{ kind: '', id: '' }`, which matches nothing. Such a hook cannot take new `events`, since no event allows its scope, until the `update` also gives it a `scope` or removes it with `null`. A release that predates scopes reads only `version: 1`, so it refuses a scoped record as unreadable rather than firing it for its whole event kinds. That is the same as for any unreadable hook, and it deletes the hook's pending deliveries when it resumes; delete scoped hooks, or clear their scopes, before a rollback.

`bureau.hooks.list` takes the same `{ kind, id }` as `scope` to list the hooks scoped to exactly that subject, and each hook it answers carries `lastDelivery`: its newest delivery, a test included, with its status and last attempt and without its request, work or response body, or `null`. The list reads the delivery records once, one `kv.get` per retained delivery, whatever the number of hooks, so a failing-first view does not need one `bureau.hooks.deliveries` call per hook.

Weft's own events stay out of it. The Bureau's feed publishes Weft's `ScheduleMissedFire` as `schedule.missed` and nothing else of Weft's, and matching the rest needs a subscription to the engine's feed that the Bureau does not make. A hook scoped to a workflow therefore fires for what the Bureau publishes about that workflow's runs and schedule (its agent steps, their reviews, its schedule's fires), and has no event for an instance that starts or finishes by itself.

### Plugin actions

`{ type: 'plugin', plugin, kind, configuration? }` runs an action kind that a plugin contributes (`hookActionKinds` in the plugin's contributions; a Bureau takes them as `hooks.actionKinds`). `create` and `update` refuse a kind no plugin contributes, and a `configuration` the kind's schema refuses, with `InvalidParams` on `action.kind` or `action.configuration`; an `update` cannot change the plugin or the kind. Each delivery resolves the kind and parses the configuration again, and calls the kind's `run` with the event, an abort signal, the `deliveryId`, and the `idempotencyKey` `hook:<hookId>:<deliveryId>` (the same key the built-in actions use). A rejection is a failed attempt, retried like any other. A kind that is no longer contributed, or a configuration its schema now refuses, ends the delivery `failed` without a retry. A delivery keeps the whole event for the action (`work.input` on the wire), so deleting a chat deletes it with the others that name the chat's runs. An action runs at least once per delivery: an attempt that succeeded and was interrupted before the delivery was marked delivered (a restart) is attempted again with the same `idempotencyKey`, and two deliveries never share one. An action with an external effect must use the key to make the repeat a no-op, by passing it as the idempotency key of the call it makes or by recording it with the effect and checking first. A plugin hook cannot be tested with `hooks.test`.

### The event's `source`

An event a plugin caused carries `source: '<plugin>'` beside `kind` and `payload`; an event from Bureau core carries no `source` at all. Each plugin gets its own host API, the `host` of its setup context and the API its `afterStart` receives, so a contributed tool can call it too, and what that API causes is the plugin's: the `schedule.created` of a schedule it creates, and every `goal.*` event of a goal it creates. A goal's record stores the plugin, so the events of its later transitions, after a restart as well, keep the `source`. The runs a plugin-created schedule fires are not marked, and neither is what a contributed tool, activity or hook action does without the host API. The field is the envelope's. It is not a payload field and a hook cannot filter on it: hooks match on `kind` only. A webhook body gains `source` only when the event has one, and so does the `{ kind, bureauId, emittedAtMs, payload }` input of a `start-workflow` hook with `input: 'event'`. (`definitions.changed` names which file catalog changed in its payload's `catalog` field, so that its payload does not use the name.)

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
- **No test delivery.** `hooks.test` is for webhooks: for the other actions it would start a real run or write a real notification, so it is refused.
- **No chains.** A `start-workflow` hook acts only on an event the Bureau can place, so a workflow it starts can never start itself again, however the events loop. Every published kind has an `origin` in `bureau.events.catalog`:
  - `run`: the payload names a run (`runId`, `goalRunId` or `taskId`, present on every event of the kind). The hook follows it up through the runs it belongs to (an `agent` step of a workflow, a child run, a goal attempt) to the workflow instance. A hook starts that instance tagged `hook-origin:<hookId>`, so if the trail reaches a tag the hook starts nothing. The trail also crosses a schedule (COR-1952): a schedule that a hook-started run creates, with `bureau:workflows-create` or `bureau:workflows-update` for a `schedule` trigger or with `schedules.create` given `createdByRun`, records the hook that started that run (the Bureau key `bureau-hook-schedule-origin:v1:…`, `{ "version": 1, "hookId": … }`), and a run the schedule fires, with everything beneath it, reads as that hook's. Its fires therefore start no `start-workflow` hook, at any interval. A schedule with no record (one an owner made) is not a hook's, and its fires start hooks as before. A workflow `create` without an origin clears any record left under its identifier; an `update` without one keeps it, so a file a hook-started run wrote stays a hook's until it is created again. If the Bureau cannot tell whether the calling run was started by a hook, the record names the hook `unknown`. A `run` event that names no run is skipped the same way, with the reason `names no run`.
  - `external`: a short allowlist of kinds that no run, tool or action of a run can cause: `schedule.missed` (downtime or a daylight-saving gap swallowed the occurrences) and `bureau.disposed` (only the host disposes a Bureau). There is nothing to follow, and the hook acts on them.
  - `unattributed`: every other kind, and the default for a new one (fail closed). A run could cause it and nothing on it leads back to the run: `notification.created`, `diagnostic`, `memory.governance`, `definitions.changed` (a run's `bureau:workflows-create` tool writes the files it reports), `schedule.attempted` and `schedule.skipped` (a run can create a schedule), `schedule.created`, `schedule.paused`, `schedule.resumed`, `schedule.cancelled`, `session.created`, `session.saved`, `session.deleted`, `steering.accepted`, the `skill.*` kinds and the `asset.*` kinds. A `start-workflow` hook cannot list one: `create` and `update` refuse it with `InvalidParams` on `events`, and a stored record that lists one anyway is skipped when the event fires. (A `notify` hook on `run.settled` and a `start-workflow` hook on `notification.created` would otherwise start a run for every run the first one's workflows made.)

  A skip is on the record, not silent: the delivery is still written and ends `failed` with one `rejected` attempt whose `error` begins `Skipped:`, `work.skip` holds the same text (on the wire, `work.skip` is a string for a skipped `start-workflow` delivery and `null` otherwise), no run is started, and the Bureau reports a `warn` diagnostic with scope `hooks`. A run whose origin cannot be read is skipped the same way, with the reason `could not tell`. So a hook on `run.settled` that starts a workflow with an `agent` step starts exactly one run for each run a person or an owner's schedule starts, and the runs it starts raise events that start nothing. The guard is the Bureau's, not the owner's: it applies to every `start-workflow` hook and only to that action. `webhook` and `notify` hooks still fire for the events of a hook-started run, and may list any kind (a `notify` hook but for `notification.created`). What the guard cannot see is a start that carries no tag: a workflow that starts another workflow some other way, and `schedule.missed`, an `external` kind with no run to follow, so a hook listing it still acts on a missed occurrence of a schedule a hook-started run created.

### Notify me

`{ type: 'notify', title? }` writes a notification to the hook's owner through `bureau.notifications` (COR-1941): `kind: 'hook'`, the title (the action's, or `Event <kind>`), and a body naming the hook, the kind and the Bureau. It carries nothing of the payload. The owner is the hook's and nothing in an event can name another. The write is keyed `hook:<hookId>:<deliveryId>`, so a replayed delivery writes one notification.

A notify hook cannot list `notification.created`: the notification it writes is announced by that event, so the hook would write one for each. `create` and `update` refuse it with `InvalidParams` on `events`, and dispatch skips a notify hook whose record lists it anyway.

### The event catalog

`bureau.events.catalog` (in-process, `bureauEventCatalog()`) lists exactly `PUBLISHED_BUREAU_EVENT_KINDS`, in the same order, each with a description, its `origin` (`run`, `external` or `unattributed`; see "No chains") and the fields of its `payload` (name, JSON type, and whether it is optional). It is read-only and static, and any authenticated caller may read it. The record that holds it is typed over the published kinds and a test compares it with the constant, so a new published kind has no way to ship undescribed.

Weft's own event kinds (run, workflow and schedule events) are out of scope for hooks. The Bureau's feed carries one of Weft's, `ScheduleMissedFire`, as `schedule.missed`; matching the rest needs a subscription to the engine's own feed, which the Bureau does not make today.

## The signing secret

Only a `webhook` hook has one. The caller chooses it (16 to 256 characters) and sends it with `create` or `update`; it is required for a webhook and refused for any other action. It is write-only: Bureau seals it with the scheme secret answers use (AES-GCM under `answerEncryption.current`, bound to the hook so a ciphertext copied to another hook does not open), keeps only the ciphertext, and returns it from nothing: not an operation, a record, a log line, a diagnostic, or an audit entry. A response body or an error message that repeats the secret has it removed (`[redacted]`) before it is kept.

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

A 2xx answer is delivered. Any other status, a network error, or a timeout (10 seconds by default, `hooks.requestTimeoutMilliseconds`) is a failed attempt, retried with the notifier's backoff up to its `maxAttempts`, then `exhausted` (also audited as `hook.delivery.exhausted`, filed under `hook:<id>`, without the URL). A redirect is a failed attempt and is never followed. `bureau.hooks.test` sends one `hook.test` delivery with one attempt and no retry, even to a disabled hook.

A delivery record keeps the request without its signature, each attempt's outcome, status, and the first 1024 bytes of the response, and the owner. Records survive a restart. A restart resumes every `pending` delivery whose lease has run out, under one rule: **one attempt record produces at most one HTTP request.** An attempt is written as `sending` before the request is made; a restart that finds one still `sending` does not know its outcome, closes it as `interrupted` (it counts toward `maxAttempts`), and sends the next attempt under a new number, a new timestamp and the same `Idempotency-Key`. A receiver that saw the interrupted request can drop the repeat by that key. A process that stops cleanly releases its leases; one that crashes leaves them to expire. A restart inside that window leaves such a delivery alone at first and scans again when the earliest lease runs out (and again for any that remain), so a quick restart does not leave it pending until the next one; a shutdown cancels the wait. The restart finds its pending deliveries through an index key (`bureau-hook-delivery-pending:v1:<deliveryId>`) that is written in the same batch as the record, so it reads no settled record; records written before the index existed are indexed once, on the first restart. `retention.hookDeliveries` (`{ olderThan }` in milliseconds, a live setting, unset by default) removes settled deliveries last written longer ago than the window at each maintenance pass; a `pending` delivery is never removed, whatever its age.

Events that happen while the Bureau is down are not replayed.

Deleting a chat (`bureau.contexts.delete`) deletes the deliveries of events about its runs (COR-1953), a `pending` one included, so its retry sends nothing; a request already in flight cannot be recalled. The record holds only identifiers, but it names the chat's runs. A delivery of the hook's other events, a `notify` delivery (it names no run), the hook and its secret stay. See `external-control-plane.md`.

Rolling back to a release that predates actions is safe only for webhook hooks. A webhook hook's record also keeps its `url` at the top level, which that release reads, and a change it makes to the `url` is read back by this one. A `start-workflow` or `notify` hook has no `url`, so the older release cannot read it, treats it as unreadable, and deletes its pending deliveries when it resumes; delete those hooks, or disable them and let their deliveries finish, before a rollback. A hook with a `scope` is stored as `version: 2` (a hook without one as `version: 1`), which a release that predates scopes does not read, webhook hooks included; clear its scope or delete it before a rollback.

## Which URLs

`http` or `https`, with a host, no user name or password, no fragment, and at most 2048 characters. Link-local addresses (`169.254.0.0/16`, which holds the cloud metadata endpoint `169.254.169.254`, and `fe80::/10`), the IPv6 metadata endpoint `fd00:ec2::254`, the unspecified addresses and multicast are always refused, even when private networks are allowed: a metadata endpoint is never a legitimate local receiver. Loopback and private-network addresses are **allowed by default**, because a local receiver is the main use of a local-first Interborough; a hosted deployment, a remote Interborough home included, **must** pass `hooks: { urlPolicy: { allowPrivateNetworks: false } }` when it enables hooks, because the default exists for the person's own machine and would otherwise let a hook reach the deployment's internal network. The check reads the URL, not the network: a hostname that resolves to a refused address is not caught, and redirects are never followed. The policy is applied when a hook is created or changed and again when a delivery is sent.

## Who sees what

A hook, and its deliveries, belong to the principal that created them and are visible to nobody else without `bureau.hooks:read` (`get`, `list`, `deliveries`) or `bureau.hooks:write` (`update`, `delete`, `test`); see the predicate table in `external-control-plane.md`. A hook observes the whole Bureau's events, so anything that decides where they go also needs `bureau.events:observe-all` of the **caller**, whoever created the hook: `create`, and an `update` that sets `url`, sets `action`, sets `events`, sets `scope`, or sets `enabled: true`. Renaming, replacing the secret and disabling need no such scope, and neither does `test`, which sends a fixed message and never an event. Without this a key holding only `bureau.hooks:write` could re-point another owner's fleet-wide hook at its own URL. The audit entries (`hook.created`, `hook.updated`, `hook.deleted`, `hook.tested`) name the caller as the actor and the hook's owner in their detail; the actor is left out when the credential names none.
