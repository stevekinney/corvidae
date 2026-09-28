# Terminal security and resource budgets

Status: accepted COR-483 candidate. This document defines the fail-closed security and resource policy for the COR-436 terminal contract. Measurements are collected by `scripts/terminal/resource-probe.ts` into the ignored `tmp/terminal-probes/resources.json`; the committed evidence schema and semantic validator are authoritative.

## Ownership and threat model

The browser is an untrusted view and transport peer. The host owns authentication, origin checks, command profiles, process creation, process-group cleanup, PTY privileges, resource accounting, and the final cleanup attestation. The package owns framing, generation and sequence validation, bounded queues, typed overflow, parser/renderer isolation, projection limits, and fail-closed state transitions. Neither layer claims guarantees owned by the other.

Treat terminal output as hostile bytes. Escape sequences, control strings, OSC payloads, invalid UTF-8, extreme Unicode, and output that resembles protocol or shell input remain data. They cannot invoke package callbacks, change command profiles, cross attachment generations, or create a second transport. Every callback is wrapped; a thrown callback revokes the attachment and enters cleanup rather than leaving a half-live session.

The server authenticates before issuing an attachment generation and checks the expected origin, session, token, direction, frame size, and strictly increasing sequence. Tokens are never echoed, persisted in reports, or accepted from query strings. A stale or cross-tenant message receives a typed failure and cannot affect the current attachment. A compromised page gets no arbitrary executable, cwd, environment, inherited descriptor, signal, or PTY authority: it selects only a host-owned command profile. The host must use an allowlisted executable, fixed cwd policy, scrubbed environment, a new process group, and the minimum PTY privileges required by the selected profile.

Paste is data, not a command boundary. Bracketed-paste mode is enabled where supported; terminators, newlines, carriage returns, and escape sequences are counted against the input budget and are never silently rewritten into an approval or submit action. Input is disabled immediately on revocation, disconnect, cleanup start, and read-only mode. No fallback, reset, replay, optimistic reuse, or automatic reconnect is permitted.

The host owns guarantees the package cannot prove: descendants outside the owned process group, detached grandchildren, kernel-held resources, a host crash, a killed browser, and operating-system sandbox policy. These are reported as `unknown`, never inferred as clean. A host-authorized clearance attestation may clear a quarantine only when it names the session, generation, process-group identity, observed checks, authority, and timestamp; the package cannot manufacture one.

## Conservative budgets

Defaults are intentionally below the largest passing probe values and include operational headroom. Units are part of the contract; missing, non-finite, negative, or unitless values fail closed.

| Resource | Default | Permitted range | Owner and behavior |
| --- | --: | --: | --- |
| Application frame payload | 64 KiB | 1–256 KiB | Package; oversized frames are rejected before parsing. |
| Host operation FIFO | 256 operations | 1–4,096 | Host; reserved control capacity is excluded from this count. |
| Reserved control capacity | 8 operations | 1–64 | Host; stop, revoke, and cleanup cannot be starved by user input. |
| Input queue | 64 KiB | 1–1 MiB | Package/host boundary; overflow is visible typed `input-overflow`. |
| Output queue | 1 MiB | 64 KiB–16 MiB | Host; overflow revokes the generation and quarantines cleanup. |
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

Pipe mode must prove that stdout and stderr remain separate and that the readable stream exposes no pause/resume authority; backpressure is implemented by the host reader and bounded queue. PTY mode must prove resize, input, PTY EOF, and process exit as separate ordered events. `stop` revokes authority first, reserves control capacity, cancels unsent operations, closes input, terminates the owned process group, closes PTY/pipe handles, observes descendants, and emits exactly one cleanup result. Submitted operations are not retracted and lost acknowledgements are unknown delivery.

The probe records the boundary of these proofs. It cannot prove cleanup of detached descendants, resources held by a crashed host, or a host-level sandbox. Those outcomes become `unknown`, revoke and quarantine the attachment, and require a host-authorized clearance attestation before replacement.

## Cleanup state machine

`complete` means authority was revoked, queues were drained or canceled, owned handles closed, the owned process group terminated, and all required observations passed. `incomplete` means a required action was attempted but its deadline or observation failed. `unknown` means the host could not establish ownership or absence—for example, a crash or detached descendant. Both `incomplete` and `unknown` revoke authority, quarantine the session slot, and prevent replacement. There is no fallback cleanup path, reset, replay, or reuse.

Asset, CSP, parser, render, metadata, and browser-request failures fail closed before a session is considered ready. A report may be consumed only after structural schema validation, exact cell identity validation, semantic consistency checks, and the fail-closed cleanup policy above all pass.
