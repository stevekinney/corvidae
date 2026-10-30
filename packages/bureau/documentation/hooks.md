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

and one that does not computes the same thing with the platform:

```ts
async function digest(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
console.log(await digest('secret', 1800000000, '{}'));
```

## Delivery, retries and restarts

A 2xx answer is delivered. Any other status, a network error, or a timeout (10 seconds by default, `hooks.requestTimeoutMilliseconds`) is a failed attempt, retried with the notifier's backoff up to its `maxAttempts`, then `exhausted` (also audited as `hook.delivery.exhausted`, filed under `hook:<id>`, without the URL). A redirect is a failed attempt and is never followed. `bureau.hooks.test` sends one `hook.test` delivery with one attempt and no retry, even to a disabled hook.

A delivery record keeps the request without its signature, each attempt's outcome, status, and the first 1024 bytes of the response, and the owner. Records survive a restart. A restart resumes every `pending` delivery whose lease has run out, under one rule: **one attempt record produces at most one HTTP request.** An attempt is written as `sending` before the request is made; a restart that finds one still `sending` does not know its outcome, closes it as `interrupted` (it counts toward `maxAttempts`), and sends the next attempt under a new number, a new timestamp and the same `Idempotency-Key`. A receiver that saw the interrupted request can drop the repeat by that key. A process that stops cleanly releases its leases; one that crashes leaves them to expire.

Events that happen while the Bureau is down are not replayed.

## Which URLs

`http` or `https`, with a host, no user name or password, no fragment, and at most 2048 characters. Link-local addresses (`169.254.0.0/16`, the cloud metadata endpoint, and `fe80::/10`), the unspecified addresses and multicast are always refused. Loopback and private-network addresses are **allowed by default**, because a local receiver is the main use of a local-first Interborough; a hosted deployment sets `hooks.urlPolicy.allowPrivateNetworks` to `false`. The check reads the URL, not the network: a hostname that resolves to a refused address is not caught, and redirects are never followed. The policy is applied when a hook is created or changed and again when a delivery is sent.

## Who sees what

A hook, and its deliveries, belong to the principal that created them and are visible to nobody else without `bureau.hooks:read` (`get`, `list`, `deliveries`) or `bureau.hooks:write` (`update`, `delete`, `test`); see the predicate table in `external-control-plane.md`. A hook observes the whole Bureau's events, so creating one, or changing its `events`, also needs `bureau.events:observe-all`.
