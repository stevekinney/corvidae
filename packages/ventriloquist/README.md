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
- `CORPUS` and the partition helpers: the shared byte fixtures that the protocol suite delivers in every two-chunk split, byte by byte, and in 1,000 partitions from a checked-in seed.

An input acknowledgement means the operation entered the host FIFO. Consumed-output acknowledgement means the client parsed those bytes. Process exit is a separate message. None implies another.

## Commands

- `bun run typecheck`: both TypeScript programs.
- `bun run test`: the package tests.
- `bun run test:protocol`: the protocol tests only, including the corpus matrix. An empty selection or a missing matrix cell fails.
- `bun run test:coverage`: the tests with LCOV output, then the ratchet in `coverage-ratchet.json` through `@lostgradient/testing/coverage-ratchet`. TypeScript lines and functions are held at 100 percent.
