# Hooks

A hook sends a signed webhook when a published Bureau event happens (COR-1939). It is owned by the principal that created it, matches the event kinds `bureau.events` serves (`PUBLISHED_BUREAU_EVENT_KINDS`), and keeps every delivery's request, response and attempts on a record that survives a restart. The operations are `bureau.hooks.create`, `update`, `delete`, `get`, `list`, `test` and `deliveries`; in-process they are `bureau.hooks`.

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

## The signing secret

The caller chooses it (16 to 256 characters) and sends it with `create` or `update`. It is write-only: Bureau seals it with the scheme secret answers use (AES-GCM under `answerEncryption.current`, bound to the hook so a ciphertext copied to another hook does not open), keeps only the ciphertext, and returns it from nothing: not an operation, a record, a log line, a diagnostic, or an audit entry. A response body or an error message that repeats the secret has it removed (`[redacted]`) before it is kept.

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

## Which URLs

`http` or `https`, with a host, no user name or password, no fragment, and at most 2048 characters. Link-local addresses (`169.254.0.0/16`, which holds the cloud metadata endpoint `169.254.169.254`, and `fe80::/10`), the IPv6 metadata endpoint `fd00:ec2::254`, the unspecified addresses and multicast are always refused, even when private networks are allowed: a metadata endpoint is never a legitimate local receiver. Loopback and private-network addresses are **allowed by default**, because a local receiver is the main use of a local-first Interborough; a hosted deployment, a remote Interborough home included, **must** pass `hooks: { urlPolicy: { allowPrivateNetworks: false } }` when it enables hooks, because the default exists for the person's own machine and would otherwise let a hook reach the deployment's internal network. The check reads the URL, not the network: a hostname that resolves to a refused address is not caught, and redirects are never followed. The policy is applied when a hook is created or changed and again when a delivery is sent.

## Who sees what

A hook, and its deliveries, belong to the principal that created them and are visible to nobody else without `bureau.hooks:read` (`get`, `list`, `deliveries`) or `bureau.hooks:write` (`update`, `delete`, `test`); see the predicate table in `external-control-plane.md`. A hook observes the whole Bureau's events, so anything that decides where they go also needs `bureau.events:observe-all` of the **caller**, whoever created the hook: `create`, and an `update` that sets `url`, sets `events`, or sets `enabled: true`. Renaming, replacing the secret and disabling need no such scope, and neither does `test`, which sends a fixed message and never an event. Without this a key holding only `bureau.hooks:write` could re-point another owner's fleet-wide hook at its own URL. The audit entries (`hook.created`, `hook.updated`, `hook.deleted`, `hook.tested`) name the caller as the actor and the hook's owner in their detail; the actor is left out when the credential names none.
