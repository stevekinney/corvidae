# @lostgradient/ventriloquist

`@lostgradient/ventriloquist` is the terminal wire protocol and session core for Corvidae, plus the Bun-only helpers that host a terminal session. The accepted contract lives in [`documentation/terminal/contract.md`](../../documentation/terminal/contract.md).

## Workspace usage

Declare `"@lostgradient/ventriloquist": "workspace:*"` in the consuming workspace's dependencies and run `bun install` from the Corvidae root. The package is private and exports TypeScript source directly, so there is no build step.

## Entry points

- `@lostgradient/ventriloquist`: the platform-neutral wire protocol and session core. It has no Bun, Node, DOM, process, filesystem, or WebSocket implementation dependency, so browser code may import it.
- `@lostgradient/ventriloquist/bun`: Bun pipe and PTY helpers. Bun processes and tests only.
- `@lostgradient/ventriloquist/websocket`: the authorized Bun WebSocket server. Bun processes and tests only.

Browser code must import only the root entry. `@lostgradient/terminal` enforces that with its `test:boundaries` script.

## How the neutral boundary is enforced

`tsconfig.json` covers the whole package, including `src/bun/` and `src/websocket/`, with Bun's types. `tsconfig.neutral.json` checks `src/index.ts`, `src/protocol/`, and `src/session/` with `lib: ["ESNext"]` and `types: []`, so a Bun, Node, or DOM reference reachable from the root entry, including one imported from `src/bun/` or `src/websocket/`, fails `bun run typecheck`. Test files and `*.test-support.ts` scaffolding stay out of that program.

## The byte protocol

`src/protocol/` implements the version 1 wire schema from the contract. The neutral entry exports:

- `encodeFrame` and `decodeFrame`: one complete application frame in or out. Control messages are JSON text frames; `input` and `output` are binary frames with a 40 byte big-endian header (version, kind, direction, channel, session identifier, generation, sequence and payload length). Decoding returns a typed `ProtocolFailure` instead of throwing, checks size before structure, and copies accepted payloads.
- `HostEndpoint` and `ClientEndpoint`: the two halves of one attachment's conversation. They validate session, generation, strictly consecutive sequence, capabilities, direction, and acknowledgements before the caller sees a message, and build every frame they send. They own no transport, process or timer.
- `FAILURE_TABLE` and `describeFailure`: the failure and cleanup table as data, including each code's WebSocket close code.
- `CORPUS`, `REQUIRED_CORPUS_FIXTURE_IDS`, `SUPPLEMENTARY_CORPUS_FIXTURE_IDS` and the partition helpers: the shared byte fixtures (the required identifiers are exactly the ten the contract freezes; the supplementary ones are extra cases that also run) that the protocol suite delivers in every two-chunk split, byte by byte, and in 1,000 partitions from a checked-in seed.

An input acknowledgement means the operation entered the host FIFO. Consumed-output acknowledgement means the client parsed those bytes. Process exit is a separate message. None implies another.

## The session core

`src/session/` is the platform-neutral session core. It owns the three things the wire protocol deliberately does not: who holds the one ownership slot, how much work may queue, and what must happen when the connection ends.

- `Session`: one terminal session. Its state is three independent axes (`process`, `connection`, `cleanup`) plus a `quarantined` flag, so an exit, a disconnect and a cleanup can race without any of them overwriting another. It takes at most one attachment, ever. The attachment is issued a fresh generation, and its capabilities are derived on the server: a read-only request or grant, or a session with no backend process, yields no input, resize or kill, and there is no safe-reply exception for automatic terminal replies.
- Once that attachment is revoked, whether by stop, disconnect, liveness expiry, a protocol failure, a backend failure, overflow or a throwing callback, the session freezes input, runs the owner's cleanup policy and closes. It never issues a second generation, replays input or respawns the process.
- `SessionSlot`: the host-side ownership slot. A replacement needs a new session identity and is refused until the old session has closed with a `complete` cleanup. `incomplete` and `unknown` leave the slot quarantined, and nothing in this package can clear it, because only a host-authorized attestation can.
- `SessionConnection`: joins a transport to a session through `HostEndpoint`, so a stale or unauthorized frame never reaches the process, the view or cleanup.

A backend that is known to have no input channel, such as a pipe opened without stdin, sets `acceptsInput: false`, and its attachments then advertise no input and refuse it as `unsupported`.

Budgets default to the values in [`documentation/terminal/security-and-budgets.md`](../../documentation/terminal/security-and-budgets.md) and are range-checked by `resolveSessionBudgets`. Input and resize share one FIFO of 256 operations with 8 more slots reserved for stop, revoke and cleanup, which a full FIFO cannot consume. Input is limited to 64 KiB of unsettled bytes and output to 1 MiB of bytes the consumer has not reported parsed. Output capacity returns only when the consumer reports that chunk's own parse completion (`outputParsed`, or the cumulative count in an `output-consumed` frame), never at a paint. A chunk that does not fit fails the session visibly and quarantines the slot, because a source that cannot be paused must not outrun its consumer.

An accepted operation means only that it entered the host FIFO. The backend then has `inputAcknowledgementDeadlineMilliseconds` to settle it: a rejection is `failed`, a missed deadline is `unknown`, and neither is retried. Operations still queued when authority is revoked are `canceled` with an explicit event.

The session reports `processExit` at most once, which may arrive before trailing output and disables input at once. End of file (`sourceComplete`) is a separate event. One final `sessionClosed` follows once accepted output has been parsed or the drain deadline has passed, and the cleanup result is known; nothing is delivered after it. A natural close can wait up to `cleanupDeadlineMilliseconds` to drain and then up to the same deadline again for cleanup.

Owned streams are canceled and their reader released, owned async iterators receive `return()` when they have one, and borrowed subscriptions are only unsubscribed. A rejection, or a source that cannot be released, is `incomplete`. A release still running at the deadline is `unknown`.

`src/session/fixtures/` is exported from the root entry for the conformance suite: `ManualClock`, `createDeferred`, scripted backends and sources, and `createFixtureTransport`, which pairs a real `ClientEndpoint` with a session in memory.

## The Bun helpers

`@lostgradient/ventriloquist/bun` turns a process into the two things a `Session` consumes: a `ProcessBackend` and its `OutputSource` values. The host passes both to `new Session(...)`, then calls `hosted.reportExitTo(session)` so the exit reaches the session after the output it follows. Nothing is spawned until the session starts the backend, and the helpers are Bun-only, so they run on macOS and Linux (x64 and arm64) and nowhere else.

- `createPipeProcess({ profile, acceptsInput? })`: `Bun.spawn` with piped stdio, run as its own process group. Standard output and standard error are two separate owned sources tagged `stdout` and `stderr`, so a partial escape sequence on one channel is never spliced into the other. Standard input exists only when `acceptsInput` is set. A pipe has no terminal, so it offers no resize and is never a PTY.
- `createPtyProcess({ profile, dimensions })`: `Bun.spawn({ terminal })`, which makes the child the leader of its own session and process group. All output is one combined stream tagged `pty`. The helper decodes, splits and echoes nothing; the kernel's line discipline is all that sits between the process and the consumer, so echo and `\n` to `\r\n` translation are the terminal's, not the host's. When the leader exits the terminal hangs up its session, so a descendant cannot write after it; a pipe has no such hangup, and its sources end only when every holder of the pipe has closed it.
- `createByteOutputSource(output)`: ingests an already-created `ReadableStream<Uint8Array>` or async byte iterable, such as a Bun Shell result, as an owned `stdout` source. Pair it with a session that has no backend: that session is output-only, advertises no input, resize or kill, and reports source completion instead of an exit code. The package exports no shell template, evaluation or command-construction helper, and a Bun Shell pipe is never presented as a terminal.

A `ProcessProfile` is the host's decision: an executable, its arguments, an absolute working directory and the complete environment. Nothing is inherited from the host process and nothing is passed through a shell. A malformed profile or dimensions throw synchronously. A host outside the supported matrix, or a Bun that returns no terminal, fails the start as `unsupported-runtime` and never falls back to a pipe; a spawn the operating system refuses fails it as `spawn-failed`. A PTY child does not run its command until `Bun.spawn` has returned: it starts as a small shell held on a release byte (a Bun 1.4.2 macOS hang, [oven-sh/bun#45300](https://github.com/oven-sh/bun/issues/45300), strikes when a terminal child finishes before the spawn call does), and the host sends the byte once the call is back. The shell receives the profile as separate arguments and runs `exec "$@"`, so nothing is interpreted by it. The command keeps the pid, session, process group and controlling terminal. Because of that, a PTY whose executable is missing, is a directory or lacks the executable bit is detected after the spawn, before the release, and fails the start as `spawn-failed` without the command ever running; a Bun that provides no release channel fails it as `unsupported-runtime`. Both are `ProcessStartFailure`, available as `hosted.startFailure`, and neither is a process exit or a transport failure.

Process exit and end of file are separate events: the exit comes from the process, end of file from the stream, and neither is derived from the other. A terminal's data callback cannot be paused and a write Bun has accepted says nothing about the output, so output the session has not yet read is bounded (`maximumBufferedOutputBytes`, 1 MiB by default, shared by a pipe's stdout and stderr) and exceeding the bound fails the source visibly instead of dropping bytes.

Cleanup ends the owned process group with TERM, then KILL once `terminationGraceMilliseconds` has passed, and reports `complete` only after a probe finds the group empty. The scope of that claim is the process group:

- A descendant that started a session or group of its own, such as one that called `setsid`, is beyond it. While the leader is alive cleanup reads the process table first and reports `unknown` if it finds one; once the leader has exited, or if the table cannot be read, that observation is unavailable.
- Anything left running by a crashed host is also beyond it, and no helper can report it. Replacement waits on a host-authorized clearance, as the security budgets document describes.
- A group that is still occupied after the KILL window is `incomplete`.

## The WebSocket host

`@lostgradient/ventriloquist/websocket` joins a `Bun.serve` listener to the session core. `createTerminalWebSocketServer(options)` returns `handleUpgrade(request, server)` for the listener's `fetch`, the `websocket` handlers to spread into `Bun.serve`, and the host's revocation controls. `serveTerminalWebSocket(options)` starts a listener that does nothing else. The host supplies two callbacks and a process factory; there is no default for either callback, so an unauthenticated server cannot be built.

- `authenticate(request)`: runs before the upgrade. The host reads its own HttpOnly session cookie from the request and answers with a trusted `subject` and a relative `expiresInMilliseconds`, or a typed denial (`unauthenticated`, `expired`, `forbidden`, `unavailable`). A callback that throws, or an answer without a subject and a positive finite lifetime, admits nothing.
- `authorize(request)`: runs when the client's `hello` names a session, before any process exists. It receives the subject, the profile name the upgrade URL carried, the session identity, the requested mode, the operation (`attach`) and the `hello`'s `token` as `ticket`. It answers with a grant and the whole immutable launch (`mode`, a `ProcessProfile`, dimensions), which the package copies, freezes and validates, or with a typed denial. The client picks a profile name and nothing else: tenant identifiers and launch arguments in a `hello` are an unknown field and break the protocol.
- `createProcess(launch)`: turns that launch into a `HostedProcess`. `createBunProcessFactory()` is the default, built on the Bun helpers.

An upgrade is admitted only after these checks, in order. The method and `Upgrade` header must be a WebSocket handshake. The transport must be secure: only an `https:` request is admitted, and a forwarded-protocol header is never consulted. `allowInsecureLoopback` is the explicit development switch, and it admits plain `http:` only when the listener is bound to a loopback address and the peer is loopback too, so a wildcard bind refuses it. The `Origin` must be on the required allowlist; a missing, `null` or unparseable origin is denied, and an empty allowlist throws at construction. The URL must carry a `profile` name and no credential, and a query parameter that looks like one (`token`, `access_token`, `password` and similar) is refused unread. Then `authenticate` runs. Every refusal is a status with a typed reason in the body and nothing else: no cookie, no ticket and no detail of which check failed is echoed or logged.

After an upgrade the socket holds only the subject, the lifetime and the profile name. A socket that sends no valid `hello` is closed at the handshake deadline. `SessionSlot` keeps one live session per subject by default (supply `slotFor` to share one); a second attachment is closed with 1013 and a quarantined slot with 1008, without disturbing the session that holds it.

The lifetime and the host's `revokeSubject(subject)` and `revokeSession(sessionId)` freeze input and start cleanup. Pending operations are canceled with explicit results, and a write already in flight is unknown delivery. Liveness is the transport's own: the host pings on the session clock and a pong extends the session deadline, so an idle read-only viewer survives while a silent peer expires. Nothing reconnects, replays or resumes; a dropped socket revokes the attachment and cleans up the process the connection owns, and a restart is a new session.

Transport limits are range-checked by `resolveWebSocketLimits`: the frame and operation budgets the client is told, the socket buffer bound (a send that leaves more than `maximumBufferedBytes` unsent fails the attachment), the handshake deadline, the ping interval and the connection cap. The socket's payload ceiling is derived from the frame budget, `perMessageDeflate` is off, and `closeOnBackpressureLimit` is on. A send the socket drops, or one to a socket that is no longer open, fails the attachment closed with 1011. A frame the socket merely queued under backpressure is delivered and is never an acknowledgement: only the client's `output-consumed` count releases output capacity, so receipt, `bufferedAmount` and paint cannot.

## Commands

- `bun run typecheck`: both TypeScript programs.
- `bun run test`: the package tests.
- `bun run test:protocol`: the protocol tests only, including the corpus matrix. An empty selection or a missing matrix cell fails.
- `bun run test:session`: the session tests only. It also writes `test-results/cleanup.json`, a `runtime` evidence report under `scripts/terminal/evidence.schema.json` with one cell for each outcome (`complete`, `incomplete`, `unknown`) of an owned and a borrowed source, and fails if the report is invalid or a cell is missing. The report is regenerated, not committed.
- `bun run test:websocket`: the WebSocket host tests only, over real loopback sockets with fault injection. They cover close during the handshake, input, resize, output and exit, a slow consumer, malformed frames, origin rejection, missing credentials, expired authority, stale generations, the operation window, liveness and transport security. `websocket-evidence.test.ts` writes `test-results/websocket.json`, a `runtime` evidence report under `scripts/terminal/evidence.schema.json` with one cell for each of those cases (matrix owner key `websocket`), and fails if the report is invalid or a cell is missing. The report is regenerated, not committed.
- `bun run test:bun`: the Bun helper tests only, against real pipe and PTY children on the current host. They cover prompt and input, no-newline output, progress rewrites, alternate screen, resize, Unicode chunks, nonzero exit, signals, stubborn descendants and the byte corpus in both modes, and the matrix test fails if a cell did not run.
- `bun run test:coverage`: the tests with LCOV output, then the ratchet in `coverage-ratchet.json` through `@lostgradient/testing/coverage-ratchet`. TypeScript lines and functions are held at 100 percent.
