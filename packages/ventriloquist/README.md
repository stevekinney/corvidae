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

Budgets default to the values in [`documentation/terminal/security-and-budgets.md`](../../documentation/terminal/security-and-budgets.md) and are range-checked by `resolveSessionBudgets`. Input and resize share one FIFO of 256 operations with 8 more slots reserved for stop, revoke and cleanup, which a full FIFO cannot consume. Input is limited to 64 KiB of unsettled bytes and output to 1 MiB of bytes the consumer has not reported parsed. Output capacity returns only when the consumer reports that chunk's own parse completion (`outputParsed`, or the cumulative count in an `output-consumed` frame), never at a paint. A chunk that does not fit fails the session visibly and quarantines the slot, because a source that cannot be paused must not outrun its consumer.

An accepted operation means only that it entered the host FIFO. The backend then has `inputAcknowledgementDeadlineMilliseconds` to settle it: a rejection is `failed`, a missed deadline is `unknown`, and neither is retried. Operations still queued when authority is revoked are `canceled` with an explicit event.

The session reports `processExit` at most once, which may arrive before trailing output and disables input at once. End of file (`sourceComplete`) is a separate event. One final `sessionClosed` follows once accepted output has been parsed or the drain deadline has passed, and the cleanup result is known; nothing is delivered after it. A natural close can wait up to `cleanupDeadlineMilliseconds` to drain and then up to the same deadline again for cleanup.

Owned streams are canceled and their reader released, owned async iterators receive `return()` when they have one, and borrowed subscriptions are only unsubscribed. A rejection, or a source that cannot be released, is `incomplete`. A release still running at the deadline is `unknown`.

`src/session/fixtures/` is exported from the root entry for the conformance suite: `ManualClock`, `createDeferred`, scripted backends and sources, and `createFixtureTransport`, which pairs a real `ClientEndpoint` with a session in memory.

## Commands

- `bun run typecheck`: both TypeScript programs.
- `bun run test`: the package tests.
- `bun run test:protocol`: the protocol tests only, including the corpus matrix. An empty selection or a missing matrix cell fails.
- `bun run test:session`: the session tests only. It also writes `test-results/cleanup.json`, a `runtime` evidence report under `scripts/terminal/evidence.schema.json` with one cell for each outcome (`complete`, `incomplete`, `unknown`) of an owned and a borrowed source, and fails if the report is invalid or a cell is missing. The report is regenerated, not committed.
- `bun run test:coverage`: the tests with LCOV output, then the ratchet in `coverage-ratchet.json` through `@lostgradient/testing/coverage-ratchet`. TypeScript lines and functions are held at 100 percent.
