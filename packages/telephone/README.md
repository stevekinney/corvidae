# @lostgradient/telephone

Carries an Operative agent run onto `@lostgradient/chat`'s stream wire.

One host runs the agent; another renders it. This is the piece in between — it turns an `AgentRun`'s events into the exact NDJSON frames `decodeChatStreamEvents` expects.

```ts
import {
  createChatAgent,
  createChatStreamWriter,
  pumpChatRun,
  startChatRun,
} from '@lostgradient/telephone';

const writer = createChatStreamWriter((line) => send(line));
const run = startChatRun(
  createChatAgent({ generate, toolbox, requestContext, writer }),
  conversation,
);
const envelope = await pumpChatRun(run, writer);
```

`writer` takes a sink for whole NDJSON lines, so the transport is the host's choice: an HTTP response body, an RPC message, a socket frame.

## What it guarantees

These are the properties a reader depends on, and the reason this is a package rather than something each host writes for itself.

- **One terminal frame.** Derived from `run.result()`, not from Operative's own events: for a failed run Operative fires `run.error` _and_ `run.completed` with `finishReason: 'error'`, and mirroring both would put two terminals on the wire.
- **A strictly increasing `sequence`** from zero across every frame, legacy and typed alike, from a single counter. The writer refuses anything after the terminal frame.
- **No credential leakage.** An error becomes `{ name, message }` and nothing else — never `cause`, which for a provider failure can be the raw HTTP response with authorization headers on it, and never `stack`. `classifyChatRunFailure` extracts only Operative's retryability verdict.
- **`pumpChatRun` never rejects.** It always resolves and always writes exactly one terminal frame, because a consumer treats a stream that ends without one as truncated.

Frames are encoded by `@lostgradient/chat`'s own `encodeChatStreamEvent`, so this side cannot emit a frame the published decoder would reject.

## Why it is not part of another package

`@lostgradient/operative` cannot own it without depending on the chat wire, which points the agent runtime at a presentation contract. `@lostgradient/chat` cannot own it without promoting Operative from a development dependency to a runtime one, which would make every browser consumer of `Chat` compile the agent runtime. `conversationalist` owns the message model, not the stream envelope.

So this is the leaf that depends on all three and is depended on by none of them.

## A note on the `*.css` shim

`src/ambient.d.ts` declares `*.css`. That is not cosmetic: `@lostgradient/chat` has one public entry point — its browser barrel — so importing `encodeChatStreamEvent` also reaches `@lostgradient/cinder`'s per-component stylesheet imports, which a bundler-free `tsc` program cannot resolve. Nothing is loaded at runtime; the only path that reaches a stylesheet is type-only, and `verbatimModuleSyntax` erases it.

## Scope

The browser-owned turn: one agent run, streamed, ending in a terminal frame. Server-owned durable conversations, recovery, and elicitation are not here — the retired SvelteKit lab's versions of those are in this repository's history.
