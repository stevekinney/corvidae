# attention-queue

A mod plus an optional companion service. The service owns a small queue of things that need a person (approvals, failed checks, expired claims, handoffs) and the live presence of sessions. The mod polls it, draws the queue in a band and a pane, and sends a heartbeat. Acknowledging an item is a deliberate press in the pane.

Reach for this shape only when a mod cannot do the job alone: durable or shared state, an SDK or database client, or work that must outlive one session. The mod never imports the service, and the service is not a mod: it is an ordinary Bun (or Node.js) process with the network and file access a mod's runtime does not have.

## Layout

| Path | Role |
| :-- | :-- |
| `plugin/` | The mod. Validate and test this directory. |
| `plugin/hooks/protocol.ts` | The wire contract: names, version, shapes, and parsers. Pure, with no imports, and imported by both sides. |
| `plugin/hooks/connection.ts` | The poller: health and protocol check, backoff with jitter, one cycle at a time, stale-result suppression, presence |
| `plugin/hooks/view.ts` | Pure wording for the band, the pane, and the status line |
| `plugin/hooks/register.tsx` | The hooks module: binds `$` into a narrow adapter in `session.start` and draws from `$.state` |
| `service/handler.ts` | The whole HTTP surface as a function from Request to Response |
| `service/queue.ts` | An in-memory queue with bounded size, idempotent upserts, and presence expiry |
| `service/server.ts` | The Bun entry point |
| `service/node-server.ts` | The same service on Node.js 23.6 or later |
| `service/runtime-file.ts` | Writes and removes the runtime file |

## How the two sides find and trust each other

The service binds `127.0.0.1` only. At startup it generates a random token and writes a runtime file, `~/.attention-queue/runtime.json` by default, holding the URL, token, protocol version, and process id. The file is created with mode `0600` in a `0700` directory through a temporary file and a rename. The token is never printed. The mod reads that file with `$.fs.read`, refuses any URL that is not loopback, checks that `/health` names this service and protocol version before it sends the token, and then calls `/v1` with a bearer token. A second service instance fails to bind the port and exits without touching the first one's runtime file, so the port is the single-owner lock. The service also refuses any Host header other than its own loopback names and any request carrying an `Origin` header, which keeps browser pages out.

The mod does not start the service. A child started with `$.process.spawn` dies whenever the module reloads and belongs to one session, so it cannot be the single owner several sessions share. Start the service yourself while developing, or supervise it with your operating system's service manager.

## Run it

From this directory, with Bun installed:

```bash
bun service/server.ts
```

With Node.js 23.6 or later instead:

```bash
node service/node-server.ts
```

`ATTENTION_QUEUE_PORT` changes the port (47615 by default) and `ATTENTION_QUEUE_RUNTIME_FILE` the runtime file. If you move the runtime file, set the mod's `runtimeFile` option to the same absolute path.

In another terminal, load the mod:

```bash
claude --plugin-dir ./plugin
```

Producers add items with a stable `id`, so a retried submission replaces itself and never reopens an acknowledged item:

```bash
TOKEN=$(bun -e "console.log(JSON.parse(await Bun.file(process.env.HOME + '/.attention-queue/runtime.json').text()).token)")
curl -s -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"id":"ci-main-1","kind":"failed-check","title":"unit tests failed on main","source":"ci","createdAt":1}' http://127.0.0.1:47615/v1/items
```

## Check it

```bash
claude plugin validate ./plugin
claude plugin test ./plugin
bun test service
```

Verified on 2026-11-12:

- **Mod**: `claude plugin validate` and `claude plugin test` passed on Claude Code 2.1.295, 2.1.309, 2.1.316, and 2.1.321, and the type-check passed against the 2.1.321 declarations.
- **Service**: `bun test service` passed on Bun 1.4.4, and a type-check with Bun's types passed.
- **Smoke run**: both entry points ran under Bun 1.4.4 and Node.js 26.6. The runtime file was `0600`, an unauthenticated `/v1` request got 401, a second instance exited with status 1, and SIGTERM removed the runtime file.
- **End to end**: `claude -p "/attention" --plugin-dir ./plugin` on 2.1.321, against a running service holding one approval, answered `attention-queue: Attention: 1 waiting (1 approval)` after the debug log showed the health check, the item list, and the presence heartbeat.

The queue lives in memory and is lost when the service stops. Claims, leases, accepted decisions, and anything that must survive a restart belong in durable storage behind the same handler.
