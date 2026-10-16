# @lostgradient/ventriloquist

`@lostgradient/ventriloquist` is the terminal wire protocol and session core for Corvidae, plus the Bun-only helpers that host a terminal session. The accepted contract lives in [`documentation/terminal/contract.md`](../../documentation/terminal/contract.md).

## Workspace usage

Declare `"@lostgradient/ventriloquist": "workspace:*"` in the consuming workspace's dependencies and run `bun install` from the Corvidae root. The package is private and exports TypeScript source directly, so there is no build step.

## Use it inside corvidae

The [terminal example application](../../applications/terminal-example/README.md) is the reference host: run `bun run --filter=@lostgradient/terminal-example dev` from the Corvidae root and open the start URL it prints. Its `src/server/application.ts` wires this package to `Bun.serve` the way every host does:

```ts
import { SessionSlot } from '@lostgradient/ventriloquist';
import {
  createBunProcessFactory,
  createTerminalWebSocketServer,
  type Authentication,
  type Authorization,
  type AuthorizationRequest,
  type SocketData,
} from '@lostgradient/ventriloquist/websocket';

// Your own host decisions: who the cookie names, and what a profile name may launch.
declare function authenticate(request: Request): Authentication; // { ok, subject, expiresInMilliseconds } or a denial
declare function authorize(request: AuthorizationRequest): Authorization; // a grant and the whole server-owned launch, or a denial
declare function slotFor(subject: string): SessionSlot; // one slot per subject, held for as long as you decide

const terminal = createTerminalWebSocketServer({
  host: { authenticate, authorize },
  createProcess: createBunProcessFactory(),
  allowedOrigins: ['http://127.0.0.1:54240'],
  allowInsecureLoopback: true, // development only, and only with `boundHostname`
  boundHostname: '127.0.0.1',
  slotFor,
});

Bun.serve<SocketData>({
  port: 54240,
  hostname: '127.0.0.1',
  fetch: (request, server) => terminal.handleUpgrade(request, server),
  websocket: terminal.websocket,
});
```

Behind a TLS-terminating proxy, drop the loopback switch and list the proxy's exact addresses in `trustedProxies` instead. Pick the mode in `authorize`: `pty` for a shell or a full-screen program, `pipe` when standard output and standard error must stay apart. The browser half is [`@lostgradient/terminal`](../../components/terminal/README.md).

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
- `createPtyProcess({ profile, dimensions })`: the helper opens the pseudo-terminal itself (libc through `bun:ffi`, with a small C wrapper that Bun compiles for the variadic `ioctl` and `fcntl` calls) and spawns the child on its slave with `detached: true`, which makes it the leader of its own session and process group. Bun's `terminal` option is not used because its reader cannot be paused. A worker thread reads the master only while the session is taking output, so a producer that is not read blocks in the kernel. All output is one combined stream tagged `pty`. The helper decodes, splits and echoes nothing; the kernel's line discipline is all that sits between the process and the consumer, so echo and `\n` to `\r\n` translation are the terminal's, not the host's. When the leader exits the terminal hangs up its session, so a descendant cannot write after it; a pipe has no such hangup, and its sources end only when every holder of the pipe has closed it.
- `createByteOutputSource(output)`: ingests an already-created `ReadableStream<Uint8Array>` or async byte iterable, such as a Bun Shell result, as an owned `stdout` source. Pair it with a session that has no backend: that session is output-only, advertises no input, resize or kill, and reports source completion instead of an exit code. The package exports no shell template, evaluation or command-construction helper, and a Bun Shell pipe is never presented as a terminal.

A `ProcessProfile` is the host's decision: an executable, its arguments, an absolute working directory and the complete environment. Nothing is inherited from the host process and nothing is passed through a shell. A malformed profile or dimensions throw synchronously. A host outside the supported matrix, or one that cannot open a terminal this way (no libc binding, no C compiler or no worker thread), fails the start as `unsupported-runtime` and never falls back to a pipe; a spawn the operating system refuses fails it as `spawn-failed`. A PTY child does not run its command until `Bun.spawn` has returned: it starts as a small shell held on a release byte (a Bun 1.4.2 macOS hang, [oven-sh/bun#45300](https://github.com/oven-sh/bun/issues/45300), strikes when a terminal child finishes before the spawn call does), and the host sends the byte once the call is back. The shell receives the profile as separate arguments and runs `exec "$@"`, so nothing is interpreted by it. The command keeps the pid, session, process group and controlling terminal. Because of that, a PTY whose executable is missing, is a directory or lacks the executable bit is detected after the spawn, before the release, and fails the start as `spawn-failed` without the command ever running; a Bun that provides no release channel fails it as `unsupported-runtime`. Both are `ProcessStartFailure`, available as `hosted.startFailure`, and neither is a process exit or a transport failure.

Process exit and end of file are separate events: the exit comes from the process, end of file from the stream, and neither is derived from the other. On Linux the kernel ends a terminal's output with `EIO` once every holder of the slave has closed it, and on macOS with end of file; both end the output source, and any other read error fails it.

Output is paused, not buffered. A session's `drain.unavailableBytes` counts the output it had read and could not deliver or have parsed; it does not count what a paused producer had not yet written or the kernel and the reader's look-ahead still held when the session closed, because that is never read after a revoke and its size is not knowable. (Counting it would mean reading it, which is what a revoked session must not do.) The session reads a pipe or a terminal only while its output queue has room, and the helpers hold nothing back for it: a pipe's two readers are locked in the same turn as the spawn (Bun buffers an unlocked pipe without bound, 13.8 GB in six seconds for `yes`), and the terminal's master is read by a thread that stops when the session stops asking. A flooding producer such as `yes`, a large `cat` or a noisy build therefore waits in the kernel while the consumer catches up, and resumes when `output-consumed` frees room. There is no `maximumBufferedOutputBytes` any more. `output-overflow` is left for a source the session cannot pause, such as a borrowed subscription. Input to a terminal is written to its non-blocking master; what the child has not read is queued and retried, a write settles when the kernel has taken every byte, and the session's input budget bounds the queue. Input to a terminal whose other end has gone stays unsettled and is reported as unknown at close.

Cleanup ends the owned scope with TERM, then KILL once `terminationGraceMilliseconds` has passed, and reports `complete` only after a probe finds the scope empty. The scope depends on the mode:

- A pipe owns its process group. A descendant that started a group or a session of its own, such as one that called `setsid`, is beyond it.
- A PTY owns its whole session (`process-session.ts`). A shell on a terminal puts every background job in a process group of its own, so the shell's group alone would leave `sleep 300 &` running. Cleanup sends `SIGHUP` (then `SIGCONT`) to the session leader so the shell can hang up its own jobs, waits at most one poll tick (20 ms, on the injected clock, less if the leader exits first) for it to do so, then `SIGTERM` (with `SIGCONT`, so a stopped job can act on it) to every live process whose session ID is the PTY's, then `SIGKILL` after the grace, re-reading the session between passes so a job that forks during cleanup is still caught. It reports `complete` only when no process remains in the session within the observation window; a zombie counts as gone. A job that ignores `SIGHUP` is killed by the sweep.
- Session membership is `getsid(2)` through libc, read for each candidate immediately before it is signaled; `ps` only lists the candidates and their states. `ps` cannot be the source: on macOS its `sess` column is the kernel's session pointer, printed as `0` for every process. Because the check and the signal share one synchronous step, a process that exited and whose pid went to an unrelated process is not signaled, and nothing in another session ever is. A leader pid is signaled only while `getsid(leader)` still equals the leader. The residual window is the time between two adjacent calls.
- A descendant that left the owned scope, a process that called `setsid` (or a double-forked daemon that did) in a PTY, or one that started a group of its own in a pipe, is beyond it. While the leader is alive cleanup reads the process table first and reports `unknown` if it finds one; once the leader has exited, or if the table cannot be read, that observation is unavailable.
- Anything left running by a crashed host is also beyond it, and no helper can report it. Replacement waits on a host-authorized clearance, as the security budgets document describes.
- A scope that is still occupied after the KILL window is `incomplete`.

## The WebSocket host

`@lostgradient/ventriloquist/websocket` joins a `Bun.serve` listener to the session core. `createTerminalWebSocketServer(options)` returns `handleUpgrade(request, server)` for the listener's `fetch`, the `websocket` handlers to spread into `Bun.serve`, and the host's revocation controls. `serveTerminalWebSocket(options)` starts a listener that does nothing else. The host supplies two callbacks and a process factory; there is no default for either callback, so an unauthenticated server cannot be built.

- `authenticate(request)`: runs before the upgrade. The host reads its own HttpOnly session cookie from the request and answers with a trusted `subject` and a relative `expiresInMilliseconds`, or a typed denial (`unauthenticated`, `expired`, `forbidden`, `unavailable`). A callback that throws, or an answer without a subject and a positive finite lifetime, admits nothing. A lifetime longer than one timer can hold (about 24.8 days, since `setTimeout` treats a longer delay as 1 millisecond) is waited out in steps and ends on time.
- `authorize(request)`: runs when the client's `hello` names a session, before any process exists. It receives the subject, the profile name the upgrade URL carried, the session identity, the requested mode, the operation (`attach`) and the `hello`'s `token` as `ticket`. It answers with a grant and the whole immutable launch (`mode`, a `ProcessProfile`, dimensions), which the package copies, freezes and validates, or with a typed denial. The client picks a profile name and nothing else: tenant identifiers and launch arguments in a `hello` are an unknown field and break the protocol.
- `slotFor(subject)`: returns the `SessionSlot` that holds that subject's session.
- `createProcess(launch)`: turns that launch into a `HostedProcess`. `createBunProcessFactory()` is the default, built on the Bun helpers.

An upgrade is admitted only after these checks, in order. The method and `Upgrade` header must be a WebSocket handshake. The transport must be secure: only an `https:` request is admitted. A host that terminates TLS in a reverse proxy lists that proxy's exact IP addresses in `trustedProxies` (no hostnames, wildcards or ranges; an IPv4-mapped form matches the same address). Only when the connecting peer, from `server.requestIP`, is listed is `X-Forwarded-Proto` believed. The rule: if the header carries a list, the last value is the one the nearest trusted proxy appended, so earlier values (which a client or a hop beyond the trust boundary could have written) are ignored; case and padding do not matter; and only `https` counts as secure. `http`, an empty value, any other scheme, a missing header, `X-Forwarded-For` and `Forwarded` alone are refused. From a peer that is not listed the header is never read, and the default is no trusted proxies, so the scheme comes from the URL alone. Origin and authentication apply in every case. `allowInsecureLoopback` is the explicit development switch. It requires `boundHostname`, the hostname given to `Bun.serve`, to be `127.0.0.1` (any 127.x address), `::1` or `localhost`, and throws at construction otherwise (`serveTerminalWebSocket` passes its `hostname` and throws when it is missing). The server's own `hostname` is never trusted for this, because `Bun.serve({ port })` listens on every interface yet reports `localhost`. The peer must be loopback too. The `Origin` must be on the required allowlist; a missing, `null` or unparseable origin is denied, and an empty allowlist throws at construction. The URL must carry exactly one query parameter, `profile`, and nothing else: any other key (`sid`, `jwt`, `session`, `ticket` or any name at all) is refused unread, because a denylist of credential names is always one short. Then `authenticate` runs, under a deadline (`authenticateDeadlineMilliseconds`, 5 s by default) after which the upgrade is refused as `unavailable` and its place in the connection cap is freed. Every refusal is a status with a typed reason in the body and nothing else: no cookie, no ticket and no detail of which check failed is echoed or logged.

After an upgrade the socket holds only the subject, the lifetime and the profile name. A socket that sends no valid `hello` is closed at the handshake deadline, and any frame that arrives after the `hello` but before the attachment exists is a protocol violation that closes with 1002, so no queue can build up behind a slow host decision. `slotFor(subject)` is a required option with no default, because how many sessions a principal may hold, how long a slot is kept and when a quarantined one is cleared are the host's decisions, and a package-owned map would grow without bound; a server built without it throws. A second attachment to a slot is closed with 1013 and a quarantined slot with 1008, without disturbing the session that holds it.

The lifetime and the host's `revokeSubject(subject)` and `revokeSession(subject, sessionId)` (a session identity is chosen by the client and only unique within a subject's slot, so both must match) freeze input and start cleanup. Pending operations are canceled with explicit results, and a write already in flight is unknown delivery. Liveness is the transport's own: the host pings on the session clock and a pong extends the session deadline, so an idle read-only viewer survives while a silent peer expires. Nothing reconnects, replays or resumes; a dropped socket revokes the attachment and cleans up the process the connection owns, and a restart is a new session.

Transport limits are range-checked by `resolveWebSocketLimits`: the frame and operation budgets the client is told, the socket buffer bound (a send that leaves more than `maximumBufferedBytes` unsent fails the attachment), the handshake deadline, the ping interval and the connection cap. The socket's payload ceiling is derived from the frame budget, `perMessageDeflate` is off, and `closeOnBackpressureLimit` is on. A send the socket drops, or one to a socket that is no longer open, fails the attachment closed with 1011. A frame the socket merely queued under backpressure is delivered and is never an acknowledgement: only the client's `output-consumed` count releases output capacity, so receipt, `bufferedAmount` and paint cannot.

## Commands

- `bun run typecheck`: both TypeScript programs.
- `bun run test`: the package tests.
- `bun run test:protocol`: the protocol tests only, including the corpus matrix. An empty selection or a missing matrix cell fails.
- `bun run test:session`: the session tests only. It also writes `test-results/cleanup.json`, a `runtime` evidence report under `scripts/terminal/evidence.schema.json` with one cell for each outcome (`complete`, `incomplete`, `unknown`) of an owned and a borrowed source, and fails if the report is invalid or a cell is missing. The report is regenerated, not committed.
- `bun run test:websocket`: the WebSocket host tests only, over real loopback sockets with fault injection. They cover close during the handshake, input, resize, output and exit, a slow consumer, malformed frames, origin rejection, missing credentials, expired authority, stale generations, the operation window, liveness and transport security. `websocket-evidence.test.ts` writes `test-results/websocket.json`, a `runtime` evidence report under `scripts/terminal/evidence.schema.json` with one cell for each of those cases (matrix owner key `websocket`), and fails if the report is invalid or a cell is missing. The report is regenerated, not committed.
- `bun run test:bun`: the Bun helper tests only, against real pipe and PTY children on the current host. They cover prompt and input, no-newline output, progress rewrites, alternate screen, resize, Unicode chunks, nonzero exit, signals, stubborn descendants and the byte corpus in both modes, plus (`pty-session-cleanup.test.ts`) that a PTY's background, stopped and hang-up-ignoring jobs end with it while a pipe's job in a group of its own is still `unknown`, and the matrix test fails if a cell did not run.
- `bun run test:conformance`: the conformance suite in `src/conformance/`, part of the default `test`. One set of behavioral cases runs through the in-memory `SessionConnection` path and the real Bun WebSocket path, against real `Bun.spawn` pipe and PTY children, so the two paths are held to the same story (the same message kinds in the same order and the same close code). Controls run first: corrupted and over-budget frames, a corrupted byte comparison, unknown and incomplete cleanup, missing parse completion, a late callback after close and input revoked mid-paste each make their failure happen and must be detected. The pause cells run a flooding `yes` and a six mebibyte `cat` through real pipes and PTYs: with a client that parses as it goes nothing overflows and host memory stays bounded, a client that stops parsing holds the producer in the kernel and resuming completes the output byte for byte, and stop, revocation, input and cleanup stay responsive and end a paused producer. `output-overflow` is a scripted cell now, because only a pushed source can still overflow. Ordering races use deterministic barriers and fake clocks; byte delivery, owned and borrowed source disposal, failing and hanging cancellation, stubborn descendants and descriptor stability use real processes and sockets. It also covers spawn failure, exit before attach, output after exit and before end of file, end of file without an exit, permission expiry, a lost input acknowledgement, server shutdown and stale generations, the PTY session cells (a background job and a stopped job, a job that ignores `SIGHUP`, and a `setsid` escape that stays `unknown`), plus bounded output, a full FIFO that keeps reserved control capacity, a visible non-pausable overflow and an idle consumer that is kept alive by pings. It writes `test-results/conformance.json`, a `runtime` evidence report with one cell for each case, path, mode and parity check on the host it ran on (`darwin-arm64:...`, `linux-arm64:...`). One run proves one host; `bun scripts/check-conformance-hosts.ts <report>...` reads the reports from each host at one commit and fails, naming the cell, for any required host without a passing report. The Linux cells run in the Dev Container image (see `AGENTS.md`).
- `bun run test:benchmarks`: the timing and throughput targets COR-483 froze, measured on demand with its sample counts and comparators and kept out of `bun run test`. It writes `test-results/benchmarks.json`, a `resource` evidence report, before asserting any target, so a miss still leaves its numbers behind and then exits nonzero. Flood throughput of a real `cat` through a pipe and a PTY, the latency from a full output queue to the host's last delivered byte (pause) and from the client freeing it to the next byte of output (resume), both through the in-memory path, and memory growth while a producer is paused are measured alongside the older cells. Every cell records a control measured on a trivial in-memory stand-in, the host's load average and the versions it ran on.
- `bun run test:coverage`: the tests with LCOV output, then the ratchet in `coverage-ratchet.json` through `@lostgradient/testing/coverage-ratchet`. TypeScript lines and functions are held at 100 percent.
