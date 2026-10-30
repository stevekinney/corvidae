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

A record stored before actions existed has a top-level `url` and no `action`. It reads as a webhook with no migration, and is rewritten in the tagged shape the next time it is changed. Likewise a delivery with no `actionType` is a webhook delivery. A `start-workflow` or `notify` delivery has `work` (what it will do, mapped from the event when the delivery was created) in place of a `request`, and its `completed` attempt a `receipt` naming the run or the notification. Two attempt outcomes (`rejected`, `error`) and one delivery status (`failed`) are for these actions.

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
- **At most one run per delivery.** A start carries Weft's `idempotencyKey` `hook:<hookId>:<deliveryId>`. A retry, or the attempt that follows an interrupted one after a restart, is answered with the run the first start made and starts no second. A delivery is made once per hook for each time the Bureau publishes the event, so a kind that is published more than once for one occurrence is delivered more than once: the `goal.*` events are at-least-once (a duplicate delivery of a transition the store already holds is dispatched again), and a hook on one starts a run for each. The idempotency key does not join two deliveries. A restart resumes its deliveries after the workflow files are loaded, and holds the events published while they load (the session outbox is replayed at boot, for one) until they are, so a start is never refused as a workflow that does not exist yet.
- **Authority.** The run is started as the hook's owner (`origin: { kind: 'person', principal: <owner>, surface: 'api' }`), never as whatever the event concerns. It is checked twice: when the hook is written (the owner may start workflows, and the workflow is ready and unpaused) and again for every delivery. In v1 the Bureau knows an owner but not the scopes its credential held, so it cannot re-check a scope when an event fires: the only owner that may have a `start-workflow` hook is the deployment's owner of record, `anonymous:local`, who owns the deployment's workflows. Another owner's `create` is `Forbidden` (`data.reason: "workflow authority"`), even from a key holding `bureau.workflows:write`. On the wire the caller must also be allowed to start workflows (it owns the deployment's, or holds `bureau.workflows:write`), so a key with only `bureau.hooks:write` cannot point another owner's hook at a workflow. The caller's authority is asked when the action is set (`create`, or an `update` that sends `action`); re-enabling or re-scoping a hook that already has one needs only `bureau.events:observe-all`, as for any hook, because the run is the owner's and the owner's authority is checked for every delivery.
- **No test delivery.** `hooks.test` is for webhooks: for the other actions it would start a real run or write a real notification, so it is refused.
- **No chains.** A `start-workflow` hook acts only on an event the Bureau can place, so a workflow it starts can never start itself again, however the events loop. Every published kind has an `origin` in `bureau.events.catalog`:
  - `run`: the payload names a run (`runId`, `goalRunId` or `taskId`, present on every event of the kind). The hook follows it up through the runs it belongs to (an `agent` step of a workflow, a child run, a goal attempt) to the workflow instance. A hook starts that instance tagged `hook-origin:<hookId>`, so if the trail reaches a tag the hook starts nothing. A `run` event that names no run is skipped the same way, with the reason `names no run`.
  - `external`: a short allowlist of kinds that no run, tool or action of a run can cause: `schedule.missed` (downtime or a daylight-saving gap swallowed the occurrences) and `bureau.disposed` (only the host disposes a Bureau). There is nothing to follow, and the hook acts on them.
  - `unattributed`: every other kind, and the default for a new one (fail closed). A run could cause it and nothing on it leads back to the run: `notification.created`, `diagnostic`, `memory.governance`, `definitions.changed` (a run's `workflows-create` tool writes the files it reports), `schedule.attempted` and `schedule.skipped` (a run can create a schedule), `schedule.created`, `schedule.paused`, `schedule.resumed`, `schedule.cancelled`, `session.created`, `session.saved`, `session.deleted`, `steering.accepted`, the `skill.*` kinds and the `asset.*` kinds. A `start-workflow` hook cannot list one: `create` and `update` refuse it with `InvalidParams` on `events`, and a stored record that lists one anyway is skipped when the event fires. (A `notify` hook on `run.settled` and a `start-workflow` hook on `notification.created` would otherwise start a run for every run the first one's workflows made.)

  A skip is on the record, not silent: the delivery is still written and ends `failed` with one `rejected` attempt whose `error` begins `Skipped:`, `work.skip` holds the same text (on the wire, `work.skip` is a string for a skipped `start-workflow` delivery and `null` otherwise), no run is started, and the Bureau reports a `warn` diagnostic with scope `hooks`. A run whose origin cannot be read is skipped the same way, with the reason `could not tell`. So a hook on `run.settled` that starts a workflow with an `agent` step starts exactly one run for each run a person or a schedule starts, and the runs it starts raise events that start nothing. The guard is the Bureau's, not the owner's: it applies to every `start-workflow` hook and only to that action. `webhook` and `notify` hooks still fire for the events of a hook-started run, and may list any kind (a `notify` hook but for `notification.created`). What the guard cannot see is a start that carries no tag: a run that creates a schedule, whose later fires are runs no hook started, and a workflow that starts another workflow some other way.

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

A delivery record keeps the request without its signature, each attempt's outcome, status, and the first 1024 bytes of the response, and the owner. Records survive a restart. A restart resumes every `pending` delivery whose lease has run out, under one rule: **one attempt record produces at most one HTTP request.** An attempt is written as `sending` before the request is made; a restart that finds one still `sending` does not know its outcome, closes it as `interrupted` (it counts toward `maxAttempts`), and sends the next attempt under a new number, a new timestamp and the same `Idempotency-Key`. A receiver that saw the interrupted request can drop the repeat by that key. A process that stops cleanly releases its leases; one that crashes leaves them to expire. A restart inside that window leaves such a delivery alone at first and scans again when the earliest lease runs out (and again for any that remain), so a quick restart does not leave it pending until the next one; a shutdown cancels the wait.

Events that happen while the Bureau is down are not replayed.

Rolling back to a release that predates actions is safe only for webhook hooks. A webhook hook's record also keeps its `url` at the top level, which that release reads, and a change it makes to the `url` is read back by this one. A `start-workflow` or `notify` hook has no `url`, so the older release cannot read it, treats it as unreadable, and deletes its pending deliveries when it resumes; delete those hooks, or disable them and let their deliveries finish, before a rollback.

## Which URLs

`http` or `https`, with a host, no user name or password, no fragment, and at most 2048 characters. Link-local addresses (`169.254.0.0/16`, which holds the cloud metadata endpoint `169.254.169.254`, and `fe80::/10`), the IPv6 metadata endpoint `fd00:ec2::254`, the unspecified addresses and multicast are always refused, even when private networks are allowed: a metadata endpoint is never a legitimate local receiver. Loopback and private-network addresses are **allowed by default**, because a local receiver is the main use of a local-first Interborough; a hosted deployment, a remote Interborough home included, **must** pass `hooks: { urlPolicy: { allowPrivateNetworks: false } }` when it enables hooks, because the default exists for the person's own machine and would otherwise let a hook reach the deployment's internal network. The check reads the URL, not the network: a hostname that resolves to a refused address is not caught, and redirects are never followed. The policy is applied when a hook is created or changed and again when a delivery is sent.

## Who sees what

A hook, and its deliveries, belong to the principal that created them and are visible to nobody else without `bureau.hooks:read` (`get`, `list`, `deliveries`) or `bureau.hooks:write` (`update`, `delete`, `test`); see the predicate table in `external-control-plane.md`. A hook observes the whole Bureau's events, so anything that decides where they go also needs `bureau.events:observe-all` of the **caller**, whoever created the hook: `create`, and an `update` that sets `url`, sets `action`, sets `events`, or sets `enabled: true`. Renaming, replacing the secret and disabling need no such scope, and neither does `test`, which sends a fixed message and never an event. Without this a key holding only `bureau.hooks:write` could re-point another owner's fleet-wide hook at its own URL. The audit entries (`hook.created`, `hook.updated`, `hook.deleted`, `hook.tested`) name the caller as the actor and the hook's owner in their detail; the actor is left out when the credential names none.
