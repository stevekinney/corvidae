# Tool Protocol

`@corvidae/tool-protocol` owns the JSON-safe contracts shared by Corvidae's tool execution, conversation, agent, skill, and bureau packages.

## Workspace usage

Declare `"@corvidae/tool-protocol": "workspace:*"` in the consuming workspace's dependencies. Import the private source package through `@corvidae/tool-protocol`; it has no build or publication step.

## What it does

- Defines JSON-safe primitive, object, array, tool-call, tool-result, tool-error, tool-action, and tool-policy types.
- Materializes permissive tool inputs into canonical runtime records.
- Rejects synchronous materialization of live streaming tool results and provides asynchronous collection variants.
- Uses `@corvidae/lifecycle` runtime services for deterministic identifier generation.

## Materializing a call and result

**Materialization** turns a permissive runtime input into the protocol record that another package can store or exchange. A missing call identifier comes from the supplied generator or the Lifecycle runtime; omitted arguments become an empty object.

```typescript
import { materializeToolCall, materializeToolResult } from '@corvidae/tool-protocol';

const call = materializeToolCall(
  { name: 'lookup-order', arguments: { orderId: 'order-42' } },
  { generateId: () => 'call-1' },
);
const result = materializeToolResult({
  callId: call.id,
  outcome: 'success',
  content: { status: 'shipped' },
});
console.log(call.id, result.content);
```

Materialization preserves an existing identifier. It normalizes non-JSON values through serialization or a string fallback, and strips runtime-only result fields. It is not strict input validation or a deep-copy guarantee: already JSON-safe content can retain its object identity. Use `isJSONValue` or `assertJSONValue` when your boundary must reject unsupported values instead of representing them.

## Streaming results

`materializeToolResult` rejects a live stream because a synchronous call cannot wait for its chunks. Use `await materializeToolResultAsync(result, { signal })` to collect an async iterable before producing the record. The resulting `content` is an array of collected chunks, normalized as JSON; this API does not forward a live stream to the caller.

The plural asynchronous helper collects results concurrently with `Promise.all`. Supply cancellation when the owner can stop waiting, and avoid collecting unbounded streams into one protocol record. Tool execution, authorization, retries, and storage belong to the runtime that uses these records.

## Boundary

This package owns only the protocol exchanged between tool-producing and tool-consuming packages. Embedding contracts belong to `@corvidae/embeddings`; hashing and signing primitives belong to `@corvidae/cryptography`; schema normalization belongs to the package that owns the schema boundary.

## Development

Run `bunx turbo run lint typecheck test --filter=@corvidae/tool-protocol --concurrency=1` from the repository root. Run `bun run validate` for the complete workspace.
