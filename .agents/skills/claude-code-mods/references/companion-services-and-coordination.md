# Companion services and coordination

A companion service is an ordinary process, usually Bun (Node.js works too), that a mod talks to. It exists for what a hooks module cannot do: hold durable or shared state, use an SDK or a database client, keep credentials away from the mod, and coordinate work across sessions and machines. Do not add one when the mod can do the job alone. Each service adds a process to start, a protocol to version, and a port to secure (Recommendation).

## When a companion is warranted

| Need | Without a service | With one |
| :-- | :-- | :-- |
| A value that survives the session, for one person on one machine | `$.store` | Not needed |
| Several local sessions changing one value safely | `$.store` races, and its last write wins | A transaction in the service's database |
| Claims, leases, accepted decisions, acknowledgments, recovery after a crash | Not possible | Durable storage with expiry |
| An npm SDK, a database driver, a long-lived connection | Not importable into a hooks module | The service imports it |
| Third-party credentials | `$.env` or `$.settings` would expose them to the mod | The service holds them and exposes narrow actions |
| CPU-heavy work | Blocks the shared hooks worker | Runs in its own process |
| Session history across projects | Not in the mods API | The Agent SDK's `listSessions`, called by the service |

## What the mod side has

The mod reaches a service through `$.http.fetch(url, init)`, with these contracts (2.1.321 declarations and the [mods reference](https://code.claude.com/docs/en/plugins/mods/reference) limits):

- **Requests**: `init` takes `method`, `headers`, `body` (a string), `auth` (a handle from `$.session.authorize()`, honored only for Anthropic's own hosts), and `socketPath`, an absolute path of a Unix domain socket of about 100 bytes at most. The declaration describes that socket as one per session in a private directory, so test it on the target build before relying on it.
- **Responses**: the call resolves `{ status, ok, headers, text }` once the whole body is read. There is no streaming, Server-Sent Events, or WebSocket for a mod's own requests. `isStreaming` appears only on engine requests a hook intercepts.
- **Limits**: 30 seconds per call including redirects, 4 MiB for the request and the response, and five redirects. A cross-origin redirect keeps only the `accept`, `accept-language`, `content-type`, and `user-agent` headers, so `Authorization` is dropped.
- **No cancellation**: `init` takes no `AbortSignal`, so an abandoned request still completes. Suppress its result instead.
- **Policy**: an organization policy that disallows WebFetch refuses every mod's `$.http.fetch` too. A `WebFetch` deny rule or `CLAUDE_CODE_DISABLE_WEB_FETCH` does not ([admin page](https://code.claude.com/docs/en/plugins/mods/admin)).
- **Debug log**: each request is logged as `$.http.fetch (<plugin>): GET <url>` with its status and size (observed on 2.1.321). Never put a token or personal data in a URL.

## Processes: run, spawn, or supervise

|  | `$.process.run(argv, init)` | `$.process.spawn({ argv, cwd, env, input })` | An externally supervised service |
| :-- | :-- | :-- | :-- |
| Shape | One shot: resolves `{ exitCode, stdout, stderr }` on exit, whatever the code | A stream of `{ stream, text }` pieces, then `{ code, signal }` | Started by the person, `launchd`, `systemd`, or a container |
| Shell | None; an argument vector. Git runs with repository hooks off | None | Its own |
| Limits | 30 seconds by default, 10 minutes at most; 4 MiB per stream | While the loop runs | Its own |
| Ends when | It exits, or at the timeout, which rejects | The loop ends, `return()` is called on the stream, `next.signal` aborts, or the module unloads, which happens on every hot reload | Its supervisor decides |
| Good for | `git status`, a CLI query, a short build step | Following a watcher's output for the module's lifetime | Shared state, durable work, anything several sessions use |

`$.process` is declared "CLI only". `$.process.run` reads the whole output, so a background process that keeps the pipe open holds the call until the timeout. A daemon started that way must detach and close its output. Neither API is a process supervisor: nothing restarts a crashed child, and a spawned child does not outlive the module.

## Starting and owning the service

Several sessions can start at once, so a check-then-start sequence races: two sessions each see no service and each start one. The single owner has to be decided by something atomic (Recommendation, demonstrated in the [companion template](../assets/templates/companion-service/README.md)):

- **The port as the lock**: the service binds a fixed loopback port. A second instance fails to bind and exits without touching anything. Observed with Bun 1.4.4 and Node.js 26.6: the second instance exited with status 1.
- **A runtime file written after the bind**: the URL, a fresh token, the protocol version, and the process id. Write it with mode `0600` in a `0700` directory, through a temporary file and a rename, and remove it at shutdown only if it still names this process.
- **A health check that identifies the service**: `/health` answers the service's name and protocol version without needing the token. The mod sends the token only after the health check matches, so an unrelated program on the port never receives it.
- **Discovery and failure handling**: the mod reads the runtime file on every cycle, refuses a URL that is not loopback, and treats a missing file as not running. It backs off instead of starting anything.

Prefer starting the service yourself during development and with the operating system's service manager in daily use. If a mod must start a helper, a child from `$.process.spawn` belongs to one session and dies on every reload. That suits a per-session helper, never a shared owner. Find the executable by running it, as in `$.process.run(['bun', '--version'])` inside `try`, because `$.process.run` rejects when a program cannot start. Resolve the plugin's own files from `$.plugin.root`.

In a cloud session, `localhost` is the cloud machine. With Remote Control, the hooks run on the person's machine, so `localhost` is that machine ([mods overview](https://code.claude.com/docs/en/plugins/mods)). Check `$.session.surfaces()` and the runtime file before assuming a service is reachable.

## Refreshing without overload

Without push, a mod polls. Poll politely (Recommendation, from the template's poller):

- **One cycle at a time**: chain timers with `$.clock.after` rather than `$.clock.every`, so a slow request never overlaps the next one
- **Coalesce**: a refresh requested while a cycle runs sets a flag that runs one more cycle afterwards, not one per request
- **Back off with jitter**: after a failure, wait an exponentially growing interval with a cap, half fixed and half random. Spread the steady interval too, so many sessions do not poll in step.
- **Separate problems**: a problem the person must fix, such as a refused token or another program on the port, is checked again slowly and reported on the status line. A transient one backs off.
- **Suppress stale results**: a cycle records the generation it started in and drops its answer if the generation moved while it waited
- **Never fetch from a render hook**: refresh from events and timers, and write `$.state` so the drawings follow

`$.process.spawn` of a watcher command can push lines to the mod for as long as the module lives. It is the closest a mod comes to a stream, and it needs a fresh start after every reload.

## Coordinating several sessions

Keep three questions apart, because they have different sources of truth:

| Question | Source | Mechanism |
| :-- | :-- | :-- |
| Which sessions existed, and what happened in them? | History | The Agent SDK's `listSessions`, `getSessionInfo`, `getSessionMessages`, in the service |
| Which sessions are alive right now? | Presence | Heartbeats with an expiry; silence means gone |
| Who owns this piece of work? | Ownership | A transactional claim or lease with an expiry, and a fencing token checked on every write |

Use distinct identifiers for distinct things:

| Identifier | Changes when | Source |
| :-- | :-- | :-- |
| Conversation | `/clear` or a resume | `$.session.id()` |
| Mod instance | Every load and reload | `crypto.randomUUID()` at module top level |
| Agent or execution | Each subagent or run | `$.agent.spawn`'s `agentId`, or the service's own job id |
| Event | Each submission | Chosen by the producer and stable across retries |

Make every registration an upsert keyed by those identifiers, so re-running `session.start` after a reload is harmless. Carry the protocol version, a timestamp, and a sequence number where order matters. The template's service ignores a heartbeat whose sequence is not newer than the last one from the same instance, and replaces the entry when a new instance id arrives.

## Delivery and work states

Exactly-once delivery is not available between a mod and a service. Design for at-least-once delivery with deduplication instead (Recommendation):

- **Stable ids**: every submitted item or event carries an id the producer chose, and the service treats a repeat as an update. A retry must never reopen something a person already acknowledged.
- **Explicit acknowledgment**: work moves through states the service records: requested, accepted, started, completed, failed, cancelled. A queued message (`$.session.send` resolving `isDelivered`) is only "requested".
- **Bounded retries**: a retry queue held in a module variable is lost on reload, and one in `$.store` is shared by every local session. Either way, cap its size and its attempts, and drop or surface what exceeds them.
- **Retry only what failed**: when posting a report fails after a mutation succeeded, retry the report, never the mutation.

The mod's `$.state` is a local view of the service's authoritative records, a cache the drawings read. Claims, leases, accepted decisions, acknowledgments, and recovery data live in the service's durable storage. A resumed conversation restores a transcript, not a job checkpoint or a filesystem snapshot. Work in flight when a session ended must be recovered from the service's records and leases.

## Securing the service

- **Loopback only**: bind `127.0.0.1`. Check the Host header against the loopback names and refuse any request with an `Origin` header, which keeps browser pages and DNS rebinding out.
- **Authenticate**: require a bearer token on everything except an identity-only health check. Compare tokens in constant time, keep the token in the `0600` runtime file, and never print or log it.
- **Validate**: parse every payload into a known shape and refuse the rest. Cap body sizes and collection sizes.
- **Expose narrow actions**: offer "acknowledge item", not "run this command" or "write this path". If an action must touch files, restrict it to an allow-list of workspace roots, compared after resolving real paths.
- **Keep third-party credentials in the service**: give the mod only the actions it needs. The mod then never reads a third-party API key from the environment or settings.
- **Keep secrets out of logs and links**: no credentials, tokens, or personal data in URLs, debug lines, or `Link` elements

The [companion template](../assets/templates/companion-service/README.md) implements each of these. Its handler is a function from Request to Response, tested without starting a server, and it runs under both `Bun.serve` and a small Node.js adapter.
