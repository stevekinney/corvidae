# Terminal security and resource budgets

Status: accepted COR-483 candidate. This document defines the fail-closed security and resource policy for the COR-436 terminal contract. Measurements are collected by `scripts/terminal/resource-probe.ts` into the ignored `tmp/terminal-probes/resources.json`; the committed evidence schema and semantic validator are authoritative.

## Ownership and threat model

The browser is an untrusted view and transport peer. The host owns authentication, origin checks, command profiles, process creation, process-group cleanup, PTY privileges, resource accounting, and the final cleanup attestation. The package owns framing, generation and sequence validation, bounded queues, typed overflow, parser/renderer isolation, projection limits, and fail-closed state transitions. Neither layer claims guarantees owned by the other.

Treat terminal output as hostile bytes. Escape sequences, control strings, OSC payloads, invalid UTF-8, extreme Unicode, and output that resembles protocol or shell input remain data. They cannot invoke package callbacks, change command profiles, cross attachment generations, or create a second transport. Every callback is wrapped; a thrown callback revokes the attachment and enters cleanup rather than leaving a half-live session.

The server authenticates before issuing an attachment generation and checks the expected origin, session, token, direction, frame size, and strictly increasing sequence. Tokens are never echoed, persisted in reports, or accepted from query strings. A stale or cross-tenant message receives a typed failure and cannot affect the current attachment. A compromised page gets no arbitrary executable, cwd, environment, inherited descriptor, signal, or PTY authority: it selects only a host-owned command profile. The host must use an allowlisted executable, fixed cwd policy, scrubbed environment, a new process group, and the minimum PTY privileges required by the selected profile.

Transport is secure by default. A forwarded scheme is believed only from a proxy address the host listed in `trustedProxies` (exact IPs, no ranges), only its last `X-Forwarded-Proto` value counts, and only `https` is secure; from an unlisted peer the header is ignored, so a client cannot claim TLS by sending it. Session ownership is the host's: `slotFor` is required, so the package holds no unbounded per-subject state.

Paste is data, not a command boundary. Bracketed-paste mode is enabled where supported; terminators, newlines, carriage returns, and escape sequences are counted against the input budget and are never silently rewritten into an approval or submit action. Input is disabled immediately on revocation, disconnect, cleanup start, and read-only mode. No fallback, reset, replay, optimistic reuse, or automatic reconnect is permitted.

The host owns guarantees the package cannot prove: descendants outside the owned scope (a pipe's process group, a PTY's session), detached grandchildren, kernel-held resources, a host crash, a killed browser, and operating-system sandbox policy. These are reported as `unknown`, never inferred as clean. The owned scope differs by mode. A pipe owns its process group. A PTY owns its whole session, because a shell on a terminal puts each background job in a process group of its own, which a group-only cleanup never reaches: cleanup hangs up the session leader with `SIGHUP`, gives it at most one poll tick (20 ms) to forward the hangup, then sends `SIGTERM` (and `SIGCONT`, so a stopped job can act on it) to every live process whose session ID is the PTY's, and `SIGKILL` once the termination grace has passed, and reports `complete` only when no process remains in that session within the descendant observation window. Session membership is read with `getsid(2)` immediately before each signal, never inferred from `ps` output (on macOS `ps` cannot print a session ID), so a process outside the session is never signaled, including one that took over a recycled pid. If the leader exits while members survive, the sweep still targets the old session id. Linux cannot recycle that pid while any member lives. macOS does not document the same guarantee, so there a recycled pid that then called `setsid` could match; the leader is never hung up once it is known to have exited, and each target's session is re-read immediately before it is signaled. A live process whose session cannot be read blocks cleanup (`incomplete`, or `unknown` when it is a descendant) only if it could belong to the session: a descendant of the leader or of a member, in a member's process group, or a pid cleanup has already seen as a readable member during this cleanup. That memory lasts the whole cleanup, so a member reparented to init and alone in its group still blocks `complete` if it turns unreadable; a remembered pid is dropped once it is seen gone, a zombie or in another session, so a recycled pid inherits nothing. A process that was never seen readable, is unrelated by ancestry and group, and cannot be read is ignored. Only a process that deliberately left the session with `setsid`, or a double-forked daemon that did, is beyond that: it is `unknown`. A host-authorized clearance attestation may clear a quarantine only when it names the session, generation, process-group identity, observed checks, authority, and timestamp; the package cannot manufacture one.

## Conservative budgets

Defaults are intentionally below the largest passing probe values and include operational headroom. Units are part of the contract; missing, non-finite, negative, or unitless values fail closed.

| Resource | Default | Permitted range | Owner and behavior |
| --- | --: | --: | --- |
| Application frame payload | 64 KiB | 1–256 KiB | Package; oversized frames are rejected before parsing. |
| Host operation FIFO | 256 operations | 1–4,096 | Host; reserved control capacity is excluded from this count. |
| Reserved control capacity | 8 operations | 1–64 | Host; stop, revoke, and cleanup cannot be starved by user input. |
| Input queue | 64 KiB | 1–1 MiB | Package/host boundary; overflow is visible typed `input-overflow`. |
| Output queue | 1 MiB | 64 KiB–16 MiB | Host; a pipe or PTY is read only while the queue has room, so the producer blocks in the kernel. Overflow revokes the generation and quarantines cleanup only for a source that cannot be paused. |
| Scrollback | 10,000 lines | 1,000–100,000 lines | Package; bounded eviction, never unbounded retention. |
| Single paste | 64 KiB | 1–256 KiB | Package; larger pastes fail without partial replay. |
| Export | 1 MiB | 64 KiB–16 MiB | Package; export is bounded and reports truncation as failure. |
| Accessible snapshot | 64 KiB | 4–512 KiB | Package; snapshot is bounded and never includes raw parser state. |
| Retained sessions | 1 per attachment | 1–8 | Host; extra sessions are rejected, not evicted optimistically. |
| Input acknowledgement deadline | 2 s | 250 ms–10 s | Host; expiry is unknown delivery, never success. |
| Idle/liveness deadline | 30 s | 5–300 s | Host; liveness probes do not grant authority. |
| Cleanup deadline | 5 s | 1–60 s | Host; expiry is incomplete or unknown and quarantines the slot. |
| Descendant observation window | 2 s | 250 ms–30 s | Host; absence of proof remains unknown after the window. |

Changing a default requires a fresh resource report with the same workload and a new source SHA. A required workload failure reopens the limit or engine decision; it does not loosen the comparator. Unsupported process-tree or sandbox guarantees remain explicitly unsupported.

## Measurement protocol

Before collecting any metric, freeze and record a typed `fixtureId`, `environment`, and `plan` containing the deadline, sample/warmup counts, method, and typed target. The report then records a passed structured `control.observed` result and an `observed` result containing actual monotonic duration, sample/warmup counts, typed metrics, and structured raw data. The cell identifier must equal `fixtureId`, and observed metrics must deep-equal the cell metrics. The report must contain every required cell exactly once. Missing, absent, `NaN`, infinite, unitless, or non-numeric required cells fail closed. Unknown required cleanup is a failure, not an acceptable observation.

The required workload covers throughput; input latency p50, p95, and p99; memory plateau; input/output queue peaks; overflow; cleanup; xterm initialization; browser JavaScript, CSS, and WebAssembly transfer; hidden-page liveness; retained projection and accessibility-snapshot memory; and teardown. Measurements are explicit probe output, not default unit-test timing gates.

The probe must establish a control result for each workload before interpreting a candidate result. It records warmup separately, uses monotonic duration, preserves raw observations, and compares each metric to its frozen target with the stated unit. A pass requires finite values, complete metadata, all required cells, and every comparator passing. A process that exits without an observed cleanup result is incomplete; a process tree that cannot be proven absent is unknown.

## Transport, paste, and shutdown proofs

Pipe mode must prove that stdout and stderr remain separate and that the host stops reading them when the output queue is full: a subprocess pipe is read through a pull-based reader taken in the same turn as the spawn, so an unread producer blocks on the kernel's pipe buffer. PTY mode reads the master through a worker thread behind a 256 KiB credit window, so an unread terminal fills the kernel's terminal queue and blocks its writer. Both channels of one process share the one output queue. PTY mode must prove resize, input, PTY EOF, and process exit as separate ordered events. `stop` revokes authority first, reserves control capacity, cancels unsent operations, closes input, terminates the owned process group, closes PTY/pipe handles, observes descendants, and emits exactly one cleanup result. Submitted operations are not retracted and lost acknowledgements are unknown delivery.

Output pause bounds, by design and by measurement (`test:conformance` cells `flood-yes`, `flood-cat`, `stalled-consumer-pauses`, `stalled-consumer-completes`, `stop-while-paused`, `revoke-while-paused`, `input-while-paused` and `cleanup-kills-paused-producer`; `test:benchmarks` cells `flood-throughput-*`, `pause-latency-*`, `resume-latency-*` and `paused-memory-*`):

- The host holds at most the output queue limit plus one source chunk per source that it has read and not yet been able to hand over (a pipe chunk was up to 256 KiB on both hosts; a PTY chunk is at most 64 KiB, and the worker reads at most 256 KiB ahead of the session).
- A paused producer is not ended and not failed. It resumes when `output-consumed` has freed at least 64 KiB, or a quarter of the queue if that is smaller, and a source with less room waits for it, so a small queue still moves.
- A freed queue is delivered in turns, not in one run: a pull-based source gives the event loop a turn after every 16 KiB it delivers, so one flooding session cannot hold the loop (and the client sharing it) for the milliseconds a megabyte of frames takes to build and send. Measured on macOS with client and host in one process, that took the WebSocket resume p50 for a PTY from about 8.7 ms to about 0.7 ms.
- `drain.unavailableBytes` counts output the host had already read. Output a paused producer had not yet delivered when the session closed (in the kernel's pipe or terminal buffer, or in the reader's look-ahead) is not counted: it is never read after a revoke, and its size cannot be known without reading it.
- Pausing does not delay control. Stop, revocation and disposal end a paused process group (a paused PTY's whole session), and on macOS cleanup reads and discards the terminal while it ends them, because closing a terminal with unread output otherwise waits for it to drain (about 600 ms measured).
- `output-overflow` still applies to a borrowed subscription: its chunks arrive whether or not they are wanted, so the first one that does not fit fails the session and quarantines cleanup. Bytes already read are counted as unavailable, never dropped silently.
- Each PTY session costs one worker thread, two descriptors on macOS and about four on Linux, and about 3 MiB of resident memory, and adds no process: the gate shell becomes the command.
- The PTY master is opened through libc (`posix_openpt`) with a C wrapper compiled by Bun's `cc` for the variadic `ioctl` and `fcntl` calls, which Bun's plain FFI mis-calls on Apple arm64. A host whose libc is neither glibc nor libSystem, or whose Bun cannot compile the wrapper, fails the start as `unsupported-runtime`.

The probe records the boundary of these proofs. It cannot prove cleanup of descendants that left the owned scope (a pipe's group, a PTY's session), resources held by a crashed host, or a host-level sandbox. Those outcomes become `unknown`, revoke and quarantine the attachment, and require a host-authorized clearance attestation before replacement.

## Cleanup state machine

`complete` means authority was revoked, queues were drained or canceled, owned handles closed, the owned scope terminated (the process group for a pipe, the session for a PTY), and all required observations passed. `incomplete` means a required action was attempted but its deadline or observation failed. `unknown` means the host could not establish ownership or absence—for example, a crash or a descendant that left the owned scope. Both `incomplete` and `unknown` revoke authority, quarantine the session slot, and prevent replacement. There is no fallback cleanup path, reset, replay, or reuse.

Asset, CSP, parser, render, metadata, and browser-request failures fail closed before a session is considered ready. A report may be consumed only after structural schema validation, exact cell identity validation, semantic consistency checks, and the fail-closed cleanup policy above all pass.
