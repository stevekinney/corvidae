# Conversationalist

`conversationalist` manages immutable conversation state for large language model applications. It gives you a JSON-safe `ConversationHistory` data type, a mutable `Conversation` runtime for undo and redo, provider adapters for [OpenAI](https://platform.openai.com/docs/), [Anthropic](https://docs.anthropic.com/), and [Gemini](https://ai.google.dev/gemini-api/docs), and serialization utilities for storage and testing.

## What It Does

- Represents conversation state as immutable, JSON-safe `ConversationHistory` values.
- Provides a mutable `Conversation` runtime for undo, redo, branching, events, and provider import/export.
- Materializes tool calls and tool results through the shared tool protocol contracts that `armorer/protocol` exports.
- Converts conversations to and from OpenAI, Anthropic, and Gemini message formats.
- Supports streaming messages, compaction, redaction, Markdown export, templates, and deterministic test helpers.

## How It Works

Pure helper functions transform `ConversationHistory` values without side effects. The `Conversation` class wraps those helpers with evented runtime behavior for applications that need stateful history management. Provider adapters sit at the edges so the internal message model stays stable even when an external provider expects a different message shape.

Public conversation values are deeply frozen when they enter the runtime. `current`, `getSnapshot()`, history paths, events, forks, and serialized trees therefore expose the same cached object until a committed transition replaces it, without exposing a mutable alias. Validation, freezing, and snapshot serialization remain separate boundaries so callers can measure their costs independently.

`Conversation.snapshot()` returns snapshot format version 2: an integrity-protected envelope containing the conversation schema version, monotonic controller revision, tree and branch identities, strict current path, creation time, fork/prune lineage, the optional per-message `streamSequences` counters (written only when non-empty, so digests and older readers stay compatible without a format bump), and a table holding each distinct message once. Every history node stores its conversation relative to its parent—the parent's ids it keeps, the ids it appends, and references to the messages that changed—so a snapshot grows with the conversation's distinct messages rather than with every node's full transcript. Nodes are a flat, pre-ordered list that names each node's parent, so a snapshot's nesting depth stays constant however long the history grows, which keeps it within depth-limited codecs such as msgpack. `Conversation.from()` accepts version 2 and version 1, verifies the digest and every identity/path/revision/delta invariant, schema-validates each message table entry once and then checks every node's positions, tool pairing, and conversation integrity, and rejects unsupported or partial data with `error:serialization`. Version 1 is the migration floor: it is restored only through the explicit, version-pinned `migrateConversationSnapshotV1()`, which validates the v1 digest before re-encoding the same tree as version 2. `currentConversationFromSnapshot()` returns just the current branch's validated conversation without restoring a `Conversation`.

## Project role

`conversationalist` owns conversation state in Corvidae. `@lostgradient/operative` consumes it for agent loops and provider payloads; `@lostgradient/chat` uses it for transcript state. Tool-call and result contracts are shared through `@lostgradient/tool-protocol`.

## Workspace usage

Declare `"conversationalist": "workspace:*"` in the consuming workspace's dependencies. Install dependencies from the Corvidae root with `bun install --frozen-lockfile`. The private package exports TypeScript source from `conversationalist`; the consumer compiles it. Shared external versions come from the root Bun catalog.

## Host Support

The root entry includes conversation state, streaming, schemas, provider conversion, Markdown serialization, and their types. Markdown parsing uses synchronous YAML loading and works in browser and server consumers.

Use `createPublicConversationProjection()` before serializing a transcript into an SSR response or browser payload. It intentionally removes hidden messages, internal instruction roles, metadata, provider-private reasoning, tool input and results, token usage, citations, document and image references, container identifiers, and managed-asset grants. It retains only user and assistant text and always applies the package's default personal-data and credential redaction rules. Supply `redactText` to apply stricter domain-specific redaction after those defaults.

```typescript
import { createPublicConversationProjection } from 'conversationalist';

const browserHistory = createPublicConversationProjection(authoritativeConversation.current);
const serialized = JSON.stringify(browserHistory);
```

## Quick Start

```typescript
import {
  Conversation,
  appendAssistantMessage,
  appendUserMessage,
  createConversationHistory,
} from 'conversationalist';

let history = createConversationHistory({
  title: 'Order Support',
  metadata: { orderId: 'ord_123' },
});

history = appendUserMessage(history, 'Where is my order?');
history = appendAssistantMessage(history, 'Let me look that up.');

const conversation = new Conversation(history);
const openAIRequest = await conversation.toProvider('openai');
```

## Core Model

- **`ConversationHistory`**: immutable, JSON-safe conversation data.
- **`Conversation`**: runtime history manager with undo, redo, branching, event emission, provider import/export helpers, and convenience wrappers around the immutable helpers.
- **`Message`**: ordered conversation entry with roles such as `user`, `assistant`, `system`, `developer`, `tool-call`, `tool-result`, and `snapshot`.
- **`ToolCall`** and **`ToolResult`**: canonical, JSON-safe tool interaction payloads shared with `armorer` through its `armorer/protocol` subpath.

### State integrity and restoration

Conversation state is revisioned, deeply frozen, and owned by the `Conversation` controller. A mutation either commits a new revision or returns a rejected result; callers never patch `current` in place. For a client that can race with another writer, pass the expected revision to `applyMutation()` and treat a rejected result as a signal to re-read and reconcile.

`Conversation.snapshot()` and `Conversation.from()` are the durable boundary. Snapshot format version 2 verifies its digest, branch identities, current path, revision, message deltas, fork lineage, and stream sequence counters before restoring; a version 1 snapshot is migrated explicitly through `migrateConversationSnapshotV1()` first. Unsupported versions, partial envelopes, and mismatched identities throw `error:serialization`. Persist the snapshot as JSON and keep provider payloads at the edge—provider adapters are not a substitute for restoring the authoritative conversation.

## Identifiers and Timestamps

Every function that mints a conversation id or timestamp—`createConversationHistory`, `createConversationHistoryUnsafe`, `buildMessage`, and the `Conversation` class—reads them through a `ConversationEnvironment`. By default, that environment reads through `runtime`, an injectable `RuntimeServices` seam (`lifecycle`'s AB-92/AB-252 contract, exposing `clock` and `identifiers`) that defaults to a real-globals implementation. Pass a manual runtime—for example `lifecycle`'s `createManualRuntimeServices()`—to make a conversation's id and timestamps reproducible across two identically-seeded runs:

```typescript
import { createConversationHistory } from 'conversationalist';
import { createManualRuntimeServices } from '@lostgradient/lifecycle';

const runtime = createManualRuntimeServices({ origin: '2030-01-01T00:00:00.000Z' });
const conversation = createConversationHistory(undefined, { runtime });
// conversation.id === 'conversation-1'
// conversation.createdAt === '2030-01-01T00:00:00.000Z'
```

An explicit `now`/`randomId` override on the environment still wins over `runtime` when both are supplied—the seam generalizes the existing override mechanism rather than replacing it, so a test double that customizes only one function keeps working unchanged.

## Updating a Transcript

Use the immutable mutation helpers when a user edits a message, a row leaves the transcript, visibility changes, or a pending tool approval resolves. Each helper returns a validated `ConversationHistory`; the history and messages you pass in stay untouched.

```typescript
import {
  appendMessages,
  createConversationHistory,
  removeMessage,
  replaceToolResult,
  setMessageHidden,
  updateMessage,
} from 'conversationalist';

let history = appendMessages(
  createConversationHistory(),
  { role: 'user', content: 'Look up account acct_123.' },
  { role: 'assistant', content: 'I can do that.' },
  {
    role: 'tool-call',
    content: '',
    toolCall: { id: 'call-account', name: 'lookupAccount', arguments: { id: 'acct_123' } },
  },
  {
    role: 'tool-result',
    content: '',
    toolResult: { callId: 'call-account', outcome: 'action_required', content: null },
  },
);

const [userMessageId, assistantMessageId] = history.ids;

history = updateMessage(history, userMessageId!, {
  content: 'Look up account acct_456.',
  metadata: { edited: true },
});
history = setMessageHidden(history, assistantMessageId!, true);
history = replaceToolResult(history, 'call-account', {
  callId: 'call-account',
  outcome: 'success',
  content: { status: 'active' },
});
history = removeMessage(history, assistantMessageId!);
```

`updateMessage` preserves the message identifier, role, position, creation time, assistant completion state, and all tool identifiers; explicitly setting `tokenUsage` or `cacheBoundary` to `undefined` clears that optional field. `updateMessage`, `setMessageHidden`, and `replaceToolResult` run configured message plugins and apply the complete processed mutable payload. That preserves cross-field policies such as hiding newly blocked content or clearing sensitive tool data. Message plugins used by mutation helpers must be deterministic, side-effect-free, and idempotent. The helpers verify repeatable and idempotent output for both the stored and updated inputs, rejecting invalid plugins rather than reprocessing unchanged values. `removeMessage` closes the position gap left by the removed row. `replaceToolResult` targets the result paired with a tool-call identifier and rejects a caller or plugin result whose `callId` differs from that target. Plugin-processed tool calls and results must retain their existing identifiers. Passing an unknown message or tool-call identifier is a no-op, so event handlers can safely ignore stale work.

## Rebuilding From an Append-Only Event Log

If your worker stores durable transcript rows instead of a serialized `ConversationHistory`, replay those rows through the immutable append helpers after a restart. The helpers rebuild the ordered message list and validate that every tool result references an earlier tool call.

```typescript
import {
  appendAssistantMessage,
  appendToolCalls,
  appendToolResults,
  appendUserMessage,
  createConversationHistory,
  getToolInteractions,
  type AppendableToolCallInput,
  type AppendableToolResult,
  type ConversationHistory,
  type JSONValue,
} from 'conversationalist';

type TranscriptEventRow =
  | {
      sequence: number;
      messageId: string;
      createdAt: string;
      kind: 'user' | 'assistant';
      content: string;
      metadata?: Record<string, JSONValue>;
    }
  | {
      sequence: number;
      messageId: string;
      createdAt: string;
      kind: 'tool-call';
      toolCall: AppendableToolCallInput;
    }
  | {
      sequence: number;
      messageId: string;
      createdAt: string;
      kind: 'tool-result';
      toolResult: AppendableToolResult;
    };

function replayTranscriptRows(rows: readonly TranscriptEventRow[]): ConversationHistory {
  const seenSequences = new Set<number>();
  const orderedRows = [...rows].sort((left, right) => left.sequence - right.sequence);
  const firstRow = orderedRows[0];
  let conversation = createConversationHistory(
    {
      title: 'Durable activity transcript',
    },
    {
      now: () => firstRow?.createdAt ?? new Date(0).toISOString(),
      randomId: () => (firstRow ? `conversation-${firstRow.messageId}` : 'empty-transcript'),
    },
  );

  for (const row of orderedRows) {
    if (seenSequences.has(row.sequence)) {
      throw new Error(`Duplicate transcript sequence: ${row.sequence}`);
    }
    seenSequences.add(row.sequence);

    const environment = {
      now: () => row.createdAt,
      randomId: () => row.messageId,
    };

    switch (row.kind) {
      case 'user': {
        conversation = appendUserMessage(conversation, row.content, row.metadata, environment);
        break;
      }
      case 'assistant': {
        conversation = appendAssistantMessage(conversation, row.content, row.metadata, environment);
        break;
      }
      case 'tool-call': {
        conversation = appendToolCalls(conversation, [row.toolCall], environment);
        break;
      }
      case 'tool-result': {
        conversation = appendToolResults(conversation, [row.toolResult], environment);
        break;
      }
    }
  }

  return conversation;
}

const rows: TranscriptEventRow[] = [
  {
    sequence: 1,
    messageId: 'message-user-1',
    createdAt: '2026-06-24T12:00:00.000Z',
    kind: 'user',
    content: 'Find the account status.',
  },
  {
    sequence: 2,
    messageId: 'message-tool-call-1',
    createdAt: '2026-06-24T12:00:01.000Z',
    kind: 'tool-call',
    toolCall: {
      id: 'tool-call-account-1',
      name: 'lookupAccount',
      arguments: { accountId: 'acct_123' },
    },
  },
  {
    sequence: 3,
    messageId: 'message-tool-result-1',
    createdAt: '2026-06-24T12:00:02.000Z',
    kind: 'tool-result',
    toolResult: {
      callId: 'tool-call-account-1',
      outcome: 'success',
      content: { status: 'active' },
    },
  },
];

const conversation = replayTranscriptRows(rows);
const orderedMessages = conversation.ids.map((id) => conversation.messages[id]);
const interactions = getToolInteractions(conversation);

console.assert(
  orderedMessages.map((message) => message.id).join(',') ===
    rows.map((row) => row.messageId).join(','),
);
console.assert(interactions.length === 1);
console.assert(interactions.every(({ call, result }) => call.id === result?.callId));
```

The `sequence` column is the replay authority. The message identifier and timestamp hooks keep the rebuilt `ConversationHistory` aligned with the external event rows, while the tool-call identifier remains the durable key that pairs every tool result with its call across process restarts.

## Incremental Projection During Streaming

Use `createProjection` when a UI receives the complete event log on every SSE frame. The projection owns the processed-count cursor: prefix extensions reduce only the new tail, while reconnects, reloads, or session switches reset to the seed and refold the supplied log.

```typescript
import {
  appendUserMessage,
  createConversationHistory,
  createProjection,
  type ConversationHistory,
} from 'conversationalist';
import {
  appendUnsafeStreamingMessage,
  finalizeUnsafeStreamingMessage,
  updateUnsafeStreamingMessage,
} from 'conversationalist';

type StreamEvent =
  | { id: string; kind: 'user.message'; content: string }
  | { id: string; kind: 'assistant.delta'; delta: string }
  | { id: string; kind: 'assistant.done' };

type ProjectionState = {
  assistantMessageId?: string;
  assistantText: string;
};

const projection = createProjection<StreamEvent, ProjectionState>({
  seed: createConversationHistory({ title: 'Live transcript' }),
  initialState: () => ({ assistantText: '' }),
  identify: (event) => event.id,
  reduce({ conversation, event, state }) {
    switch (event.kind) {
      case 'user.message':
        return {
          conversation: appendUserMessage(conversation, event.content),
          state,
        };
      case 'assistant.delta': {
        let nextConversation: ConversationHistory = conversation;
        let messageId = state.assistantMessageId;
        if (!messageId) {
          const appended = appendUnsafeStreamingMessage(nextConversation, 'assistant');
          nextConversation = appended.conversation;
          messageId = appended.messageId;
        }

        const assistantText = state.assistantText + event.delta;
        return {
          conversation: updateUnsafeStreamingMessage(nextConversation, messageId, assistantText),
          state: { assistantMessageId: messageId, assistantText },
        };
      }
      case 'assistant.done':
        return state.assistantMessageId
          ? {
              conversation: finalizeUnsafeStreamingMessage(conversation, state.assistantMessageId),
              state: { assistantText: '' },
            }
          : { conversation, state };
    }
  },
});

for await (const events of streamTranscriptEvents()) {
  projection.apply(events);
  renderConversation(projection.snapshot());
}
```

`identify` must return a stable event identity such as a durable event id or sequence number. The projection compares those identities, not array references or event object references, so reactive proxies from frameworks such as Svelte or Vue can pass fresh proxied arrays without triggering unnecessary refolds.

Keep a pure full rebuild in tests and assert it deep-equals the incremental snapshots after each chunk. That equivalence check is the guardrail: if `projection.apply(eventsSoFar); projection.snapshot()` ever differs from rebuilding from an empty seed over `eventsSoFar`, the reducer or event identity contract is wrong.

## Package Structure

### Root API

The primary runtime API. Imports the `Conversation` class, all immutable helpers, errors, guards, and types.

```typescript
import {
  Conversation,
  appendAssistantMessage,
  appendSystemMessage,
  appendToolCalls,
  appendToolResultsAsync,
  appendUserMessage,
  createConversationHistory,
  deserializeConversationHistory,
  getPendingToolCalls,
  hasSystemMessage,
  pipeConversationHistory,
  prependSystemMessage,
  removeMessage,
  replaceToolResult,
  setMessageHidden,
  updateMessage,
  validateConversationHistoryIntegrity,
  withConversationHistory,
} from 'conversationalist';
```

**Key exports:**

- `Conversation`—the runtime class with undo/redo/branching/events.
- `createConversationHistory(options?)`—creates an empty, valid `ConversationHistory`.
- `createConversationHistoryUnsafe(data)`—skips validation; use only when you control the input.
- `deserializeConversationHistory(raw)`—parses and validates a stored JSON blob.
- Append helpers: `appendMessages`, `appendUserMessage`, `appendAssistantMessage`, `appendSystemMessage`, `appendUnsafeMessage`.
- System-message helpers: `hasSystemMessage`, `getSystemMessages`, `getFirstSystemMessage`, `prependSystemMessage`, `replaceSystemMessage`, `collapseSystemMessages`.
- Query helpers: `getMessages`, `getMessageById`, `getMessageAtPosition`, `getMessageIds`, `getStatistics`, `searchConversationMessages`, `toChatMessages`.
- Tool helpers: `appendToolCall`, `appendToolCalls`, `appendToolResult`, `appendToolResultAsync`, `appendToolResults`, `appendToolResultsAsync`, `getPendingToolCalls`, `getToolInteractions`.
- Materializer helpers: `materializeToolCall`, `materializeToolCalls`, `materializeToolResult`, `materializeToolResultAsync`, `materializeToolResults`, `materializeToolResultsAsync`.
- Validation: `validateConversationHistoryIntegrity`, `assertConversationHistoryIntegrity`.
- Builder helpers: `withConversationHistory`, `pipeConversationHistory`.
- Projection helpers: `createProjection`, `isProjectionPrefixExtension`.
- Mutation helpers: `updateMessage`, `removeMessage`, `setMessageHidden`, `replaceToolResult`, `redactMessageAtPosition`.
- Guards: `isConversation`, `isConversationHistory`, `isMessage`, `isToolCall`, `isToolResult`, and more.
- Error constructors: `ConversationalistError`, `createNotFoundError`, `createValidationError`, and others.
- Composition exports: `createInstructionComposer`, `createInstructionTemplate`, `createConditionalInstructionComposer`, `whenStep`, `whenToolsAvailable`, `whenAnyToolAvailable`, `whenMetadata`, `whenMetadataPresent`.
- Event classes: `ConversationChangeEvent`, `ConversationPushEvent`, `MessagesAppendedEvent`, `StreamStartedEvent`, `StreamFinalizedEvent`, and others.

**Media content (COR-716):** an image, audio, video, document, or file part is one of `ImageContent`, `AudioContent`, `VideoContent`, `DocumentContent`, or `FileContent` (together `MediaContent`), each with a literal `type`. They share `MediaContentFields`: a required `source: ContentSource` and optional `mimeType`, `name`, `alt`, `caption`, `transcript`, `extractedText`, and `metadata`. `source` is a `ContentSource`, the only place a part names its bytes or location: `inline`, `data-url`, `remote-url`, `local-file`, `upload`, `provider-file`, `mcp-resource`, `a2a-reference`, or `managed-asset` (with an asset id and optional revision). `contentSourceSchema` validates exactly those nine kinds, and pins a `remote-url` to `http` or `https` and a `data-url` to `data`, so a persisted source never names a `file:`, `blob:`, or `javascript:` URL.

`Modality`, `MimeFamily`, `MediaLimitScope`, `MediaLimits`, and `ModalityMatrix` are the portable content vocabulary other packages (notably `@lostgradient/operative`'s `BackendDescriptor`) cite. `contentSourceDisplayUrl(source)` returns a URL a UI may show (defined for `data-url` and `remote-url` only), and `mediaDisplayUrl(part)` also builds a data URL from inline base64 bytes with a declared media type. `renderMediaPlaceholder(part)` is a one-line description for display; no provider or compaction path substitutes it for a part. The schema also requires base64 (inline, and after `;base64` in a data URL) to decode, and a declared `mimeType` to fit the part: `image/*` for an image, `audio/*` for audio, `video/*` for video, and `application/pdf`, `text/*`, structured text, or an office type for a document (`mimeTypeFitsModality`). Every inbound adapter checks third-party base64 at its mapping boundary too, and refuses with its own mapping error naming what base64 requires. Every media-type comparison in the package reads the base type through `baseMimeType`, so a parameter (`application/pdf;version=1.7`, `text/plain; charset=utf-8`) or the type's case never changes what a part is, and the one document table decides both which types are documents and which are text (`isTextualMimeType`; `application/rtf` is both, being ASCII markup). Data URLs are split in one place, `splitDataUrl`, which reads the scheme, the media type, and the `;base64` flag without regard to case (RFC 2397), so validation, every exporter, and the body reader agree on what a URL holds. Every exporter names a part's bytes by one rule, `effectiveMimeType`: the resolver's type, then the data URL's own, then the part's stored `mimeType`. Every inbound adapter classifies a media type through `modalityFromMimeType`, which uses the same document table the schema checks (a PDF, `text/*`, JSON, XML, RTF, and the office formats are documents), so what a provider sends in is what its exporter accepts back out. `readMediaBody(part, resolved?)` returns the text a provider reads from a part's own bytes (`status: 'text'`, `'none'`, or `'undecodable'`), decoded as UTF-8 whatever `charset` the type declares; the PII plugin and Operative's input guardrail both read media through it, the plugin refuses a text body that does not decode, and it re-encodes a body only when the redaction changed it, so a body with nothing to redact stays byte-for-byte as stored. Validating an append decodes only the base64 the append adds: a message already validated and frozen is not decoded again on later appends.

A conversation stored under another `CURRENT_SCHEMA_VERSION` is refused with an `error:unsupported-schema-version` `ConversationalistError` (`context: { schemaVersion, expected }`), not read: there is no migration or dual-read path. Version 6 replaced `{ type: 'image', url }` and the `base64`/`reference` document sources with `source: ContentSource`.

### Immutable conversation helpers

Pure immutable conversation helpers with no `Conversation` class dependency. Import these named functions from `conversationalist` when you want functional transforms over data.

```typescript
import {
  appendUserMessage,
  appendAssistantMessage,
  createConversationHistory,
  getPendingToolCalls,
  getSystemMessages,
  prependSystemMessage,
  removeMessage,
  replaceToolResult,
  searchConversationMessages,
  setMessageHidden,
  updateMessage,
  validateConversationHistoryIntegrity,
} from 'conversationalist';
```

**Key exports:** `createConversationHistory`, `createConversationHistoryUnsafe`, `appendMessages`, `appendUserMessage`, `appendAssistantMessage`, `appendSystemMessage`, `appendUnsafeMessage`, `updateMessage`, `removeMessage`, `setMessageHidden`, `replaceToolResult`, `getMessages`, `getMessageById`, `getMessageAtPosition`, `getMessageIds`, `getStatistics`, `searchConversationMessages`, `getSystemMessages`, `getFirstSystemMessage`, `hasSystemMessage`, `prependSystemMessage`, `replaceSystemMessage`, `collapseSystemMessages`, `redactMessageAtPosition`, `deserializeConversationHistory`, `validateConversationHistoryIntegrity`, `assertConversationHistoryIntegrity`, `toChatMessages`, `appendToolCall`, `appendToolCalls`, `appendToolResult`, `appendToolResultAsync`, `appendToolResults`, `appendToolResultsAsync`, `getPendingToolCalls`, `getToolInteractions`, `materializeToolCall`, `materializeToolCalls`, `materializeToolResult`, `materializeToolResultAsync`, `materializeToolResults`, `materializeToolResultsAsync`, `withEnvironment`.

### Conversation controller

The `Conversation` runtime class and its event types.

```typescript
import { Conversation } from 'conversationalist';
import type {
  ConversationActionType,
  ConversationEvent,
  ConversationEventType,
} from 'conversationalist';

const conversation = new Conversation();
conversation.appendUserMessage('Hello');

const previous = conversation.undo(); // ConversationHistory | undefined
if (previous) {
  console.log('Undone');
}

conversation.on('change', ({ detail }) => {
  console.log('New history:', detail.current);
});
```

**Key exports:** `Conversation`, `ConversationActionType`, `ConversationEvent`, `ConversationEventDetail`, `ConversationEventMap`, `ConversationEventType`.

### Context management

Context-window management helpers that estimate token counts and trim messages to fit within limits.

```typescript
import {
  estimateConversationTokens,
  getRecentMessages,
  rewindBeforeMessage,
  rewindBeforePosition,
  simpleTokenEstimator,
  truncateFromPosition,
  truncateToTokenLimit,
} from 'conversationalist';

// Estimate total tokens in a conversation
const tokens = estimateConversationTokens(history);

// Use a provider tokenizer when budget math must match the model.
const providerTokens = await estimateConversationTokens(history, {
  async estimateConversationTokens(messages) {
    return countWithProviderTokenizer(messages);
  },
});

// Trim to fit a 4096-token context window
const trimmed = truncateToTokenLimit(history, 4096, {
  preserveSystemMessages: true,
  preserveLastN: 4,
  preserveToolPairs: true,
});

const providerTrimmed = await truncateToTokenLimit(history, 4096, {
  async estimateConversationTokens(messages) {
    return countWithProviderTokenizer(messages);
  },
  preserveLastN: 4,
});

// Get the 10 most recent non-system messages
const recent = getRecentMessages(history, 10);

// Drop everything before position 20
const sliced = truncateFromPosition(history, 20);

// Rewind a branch: drop position 20 and everything after it. The mirror image
// of truncateFromPosition, which keeps that same tail.
const rewound = rewindBeforePosition(history, 20);

// Edit flows usually hold a message id rather than a position.
const beforeEdit = rewindBeforeMessage(history, editedMessageId);
```

The two directions are easy to confuse, so pick by what you are trying to do:

| Goal | Helper | Drops |
| --- | --- | --- |
| Fit a context window | `truncateToTokenLimit`, `getRecentMessages` | Oldest |
| Keep only the tail from a point onwards | `truncateFromPosition` | Oldest |
| Undo a branch (edit-and-resend, regenerate) | `rewindBeforePosition`, `rewindBeforeMessage` | Newest |

Both rewind helpers renumber positions from zero and keep `ids`/`messages`/`updatedAt` consistent, so edit flows never assemble a `ConversationHistory` by hand. A tool-call/tool-result pair straddling the boundary is dropped whole by default; pass `preserveToolPairs: false` to cut strictly at the boundary and leave the call pending. A boundary at or past the end returns the same conversation reference, so a no-op rewind adds no history entry.

**Key exports:** `estimateConversationTokens`, `truncateToTokenLimit`, `getRecentMessages`, `truncateFromPosition`, `rewindBeforePosition`, `rewindBeforeMessage`, `simpleTokenEstimator`. Also exports `EstimateConversationTokensOptions`, `AsyncEstimateConversationTokensOptions`, `TruncateOptions`, `AsyncTruncateOptions`, and `RewindOptions` types.

### Streaming

Streaming-message helpers for building real-time assistant responses token by token.

```typescript
import {
  appendStreamingMessage,
  appendUnsafeStreamingMessage,
  cancelStreamingMessage,
  finalizeUnsafeStreamingMessage,
  finalizeStreamingMessage,
  getStreamingMessage,
  isStreamingMessage,
  updateUnsafeStreamingMessage,
  updateStreamingMessage,
} from 'conversationalist';

// Start a streaming placeholder
let { conversation, messageId } = appendStreamingMessage(history, 'assistant');

// Accumulate tokens as they arrive
for await (const chunk of stream) {
  conversation = updateStreamingMessage(conversation, messageId, accumulatedText);
}

// Mark complete with optional token usage
conversation = finalizeStreamingMessage(conversation, messageId, {
  tokenUsage: { prompt: 120, completion: 48, total: 168 },
});

// Or cancel on error
conversation = cancelStreamingMessage(conversation, messageId);
```

**Key exports:** `appendStreamingMessage`, `appendUnsafeStreamingMessage`, `updateStreamingMessage`, `updateUnsafeStreamingMessage`, `finalizeStreamingMessage`, `finalizeUnsafeStreamingMessage`, `cancelStreamingMessage`, `isStreamingMessage`, `getStreamingMessage`.

Streaming messages (those with `metadata.__streaming === true`) are automatically protected from compaction, truncation, and adapter export until finalized. `updateStreamingMessage` only writes to a message that is still streaming: once the message has been finalized (or cancelled, which removes it outright), the call returns the conversation unchanged. That makes the late-token race—a chunk that lands after the user hits stop—a no-op instead of silently growing a message the UI already froze, so consumers no longer need their own guard. The `Conversation` method of the same name rejects those updates without recording history either: no undo entry is added and no `change` / `messages.updated` / `stream.updated` event fires, so a post-stop token flood cannot inflate the undo stack. Use the unsafe variants only for render-side projections that may contain incomplete tool-call/tool-result pairs, such as partial transcript windows or approval placeholders. `updateUnsafeStreamingMessage` also skips the streaming-status check, so it stays the explicit escape hatch for reprojecting content onto an already-finalized message.

### Event projections

Incremental projection helpers for turning cumulative append-only event logs into render-ready conversation snapshots.

```typescript
import { createProjection, isProjectionPrefixExtension } from 'conversationalist';
```

**Key exports:** `createProjection`, `isProjectionPrefixExtension`. Also exports `Projection`, `ProjectionEventIdentity`, `ProjectionOptions`, `ProjectionReducer`, `ProjectionReducerContext`, and `ProjectionReducerResult` types.

The prefix check compares stable event identities only. Use durable event ids or sequence numbers rather than object references so reactive framework proxies remain safe.

### Message construction

Utility functions for inspecting and formatting individual `Message` objects.

```typescript
import {
  createMessage,
  isAssistantMessage,
  messageHasImages,
  messageParts,
  messageText,
  messageToString,
} from 'conversationalist';

const text = messageText(message);
const parts = messageParts(message); // ReadonlyArray<MultiModalContent>
const hasImages = messageHasImages(message);
```

**Key exports:** `createMessage`, `messageToJSON`, `messageParts`, `messageText`, `messageHasImages`, `messageToString`, `isAssistantMessage`.

### Utilities

Lower-level helpers for content normalization, tool-call pairing, transient metadata, and type-safe object operations.

```typescript
import {
  normalizeContent,
  pairToolCallsWithResults,
  stripTransientMetadata,
  toMultiModalArray,
} from 'conversationalist';
```

**Key exports:** `normalizeContent`, `toMultiModalArray`, `pairToolCallsWithResults`, `stripTransientMetadata`, `isTransientKey`, `stripTransientFromRecord`, `hasOwnProperty`, `toReadonly`. Also re-exports materializer helpers and `MaterializeToolCallOptions` type.

### Markdown serialization

Round-trip Markdown serialization. Converts a conversation to Markdown for display or storage, and parses Markdown back into a `ConversationHistory`.

```typescript
import {
  conversationFromMarkdown,
  conversationToMarkdown,
  fromMarkdown,
  getRoleLabel,
  toMarkdown,
} from 'conversationalist';

// From a Conversation instance
const md = conversationToMarkdown(conversation);

// From raw ConversationHistory
const md2 = toMarkdown(history);

// Parse Markdown back into a Conversation
const restored = conversationFromMarkdown(md);

// Parse Markdown into raw ConversationHistory
const rawHistory = fromMarkdown(md2);

// Markdown with no frontmatter mints a fresh id/timestamp for the conversation and
// every message—`fromMarkdown`'s second, optional `runtime` argument controls that
// (AB-92/AB-252's `RuntimeServices` clock/identifiers seam; defaults to the real
// implementation). `conversationFromMarkdown` forwards `environment?.runtime` into it,
// so a manual runtime supplied for the returned `Conversation` also controls the parse.
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
const runtime = createManualRuntimeServices({ identifierSeed: 'demo' });
const deterministic = fromMarkdown(md2, runtime);
```

**Key exports:** `toMarkdown`, `fromMarkdown`, `conversationToMarkdown`, `conversationFromMarkdown`, `getRoleLabel`, `getRoleFromLabel`, `ROLE_LABELS`, `LABEL_TO_ROLE`, `MarkdownParseError`. Also exports `ToMarkdownOptions` type.

### Export formats

Export helpers that normalize line endings for cross-platform file output.

```typescript
import { exportMarkdown, normalizeLineEndings } from 'conversationalist';

const file = exportMarkdown(history, { includeMetadata: true });
await Bun.write('transcript.md', file);
```

**Key exports:** `exportMarkdown`, `normalizeLineEndings`.

### Schemas

Zod runtime validation schemas for all core types. Use these to validate external data before constructing `ConversationHistory` values.

```typescript
import {
  conversationSchema,
  messageSchema,
  toolCallSchema,
  toolResultSchema,
} from 'conversationalist';

const result = conversationSchema.safeParse(rawData);
if (!result.success) {
  console.error(result.error.flatten());
}
```

**Key exports:** `jsonValueSchema`, `multiModalContentSchema`, `messageRoleSchema`, `toolCallSchema`, `toolCallInputSchema`, `toolErrorCategorySchema`, `toolErrorSchema`, `toolActionSchema`, `toolResultSchema`, `tokenUsageSchema`, `messageInputSchema`, `messageSchema`, `conversationStatusSchema`, `conversationShape`, `conversationSchema`.

### Redaction

PII redaction plugin. Scans assistant and user message text and replaces sensitive patterns with placeholder tokens.

```typescript
import {
  createPIIRedaction,
  createPIIRedactionPlugin,
  DEFAULT_PII_RULES,
  redactPii,
} from 'conversationalist';

// Use the pre-built default plugin (redacts emails, phone numbers, and API keys/secrets)
const conversation = new Conversation(history, {
  plugins: [redactPii],
});

// Or define custom rules
const customPlugin = createPIIRedactionPlugin({
  rules: [{ pattern: /\b\d{9}\b/g, replacement: '[ID_REDACTED]' }],
});

// Or use the lower-level redaction function directly
const redact = createPIIRedaction();
const clean = redact('Call me at 555-123-4567');
// 'Call me at [PHONE_REDACTED]'
```

**Key exports:** `createPIIRedaction`, `createPIIRedactionPlugin`, `redactPii`, `DEFAULT_PII_RULES`. Also exports `PIIRedactionRule` and `PIIRedactionOptions` types.

### Versioning

Schema version constant for serialization compatibility checks.

```typescript
import { CURRENT_SCHEMA_VERSION } from 'conversationalist';

console.log(CURRENT_SCHEMA_VERSION); // 6
```

**Key exports:** `CURRENT_SCHEMA_VERSION`.

### Deterministic sorting

Deterministic sort helpers for consistent ordering and snapshot comparisons.

```typescript
import { sortMessagesByPosition, sortObjectKeys } from 'conversationalist';

const ordered = sortMessagesByPosition([...messages]);
const stable = sortObjectKeys(obj); // alphabetically sorted copy
```

**Key exports:** `sortMessagesByPosition`, `sortObjectKeys`.

### Instruction composition

System-prompt composition helpers. Build rich, context-aware instruction strings from typed sections, templates, and conditional blocks.

```typescript
import {
  createConditionalInstructionComposer,
  createInstructionComposer,
  createInstructionTemplate,
  extractTemplateVariables,
  renderTemplate,
  whenAnyToolAvailable,
  whenMetadata,
  whenStep,
  whenToolsAvailable,
} from 'conversationalist';

// Static instruction composer
const composer = createInstructionComposer([
  { heading: 'Role', content: 'You are a helpful assistant.' },
  { heading: 'Rules', content: 'Be concise.' },
]);

const systemPrompt = await composer.render({ step: 0, metadata: {} });

// Template with variable interpolation
const template = createInstructionTemplate('You are assisting {{userName}} on step {{step}}.');
const rendered = renderTemplate(template, { userName: 'Alice', step: '1' });

// Conditional sections—only included when their predicate passes
const conditionalComposer = createConditionalInstructionComposer([
  whenStep(0, { heading: 'Welcome', content: 'Welcome! Here is how I can help.' }),
  whenToolsAvailable(['search', 'read-file'], {
    heading: 'Available tools',
    content: 'You may search the web and read files.',
  }),
  whenAnyToolAvailable({ heading: 'Tools', content: 'You have tools available.' }),
  whenMetadata('mode', 'strict', { heading: 'Strict mode', content: 'Follow all rules exactly.' }),
]);
```

**Key exports:** `createInstructionComposer`, `createInstructionTemplate`, `createConditionalInstructionComposer`, `renderTemplate`, `extractTemplateVariables`, `whenStep`, `whenToolsAvailable`, `whenAnyToolAvailable`, `whenMetadata`, `whenMetadataPresent`. Also exports types `InstructionComposer`, `InstructionSection`, `InstructionComposerRenderOptions`, `InstructionTemplate`, `MissingVariableStrategy`, `TemplateOptions`, `ConditionalInstructionComposer`, `ConditionalInstructionSection`, `ConditionalInstructionComposerRenderOptions`, `InstructionContext`.

### OpenAI conversion

OpenAI Chat Completions message format adapter.

```typescript
import {
  appendOpenAIMessages,
  fromOpenAIMessages,
  openAIConversationAdapter,
  toOpenAIMessages,
  toOpenAIMessagesGrouped,
} from 'conversationalist';
import type { OpenAIMessage } from 'conversationalist';

// Export to OpenAI format: the wire messages, and one lineage entry per media part delivered
const { messages, lineage } = toOpenAIMessages(history);

// Group tool-call and tool-result pairs (preferred for most providers)
const grouped = toOpenAIMessagesGrouped(history);

// Import from OpenAI format
const imported = fromOpenAIMessages(openAIMessages);

// Append new OpenAI messages to an existing history
const updated = appendOpenAIMessages(history, newMessages);

// Use with Conversation.fromProvider / conversation.toProvider
const restored = await Conversation.fromProvider('openai', { messages: openAIMessages });
```

Every outbound adapter delivers each media part or throws an `UnsupportedContentError` (`error:unsupported-content`) before any provider call. The error names the `provider`, `messageId`, `partIndex`, `partType`, optional `sourceKind`, and a `reason`: `modality-not-accepted`, `source-form-not-accepted`, `mime-family-not-accepted`, `mime-type-required`, `role-not-accepted`, or `part-type-not-accepted`. Nothing becomes marker prose, an empty string, or text alone. OpenAI Chat Completions takes an image as `image_url` (a remote URL or a data URL) and a PDF as a `file` part holding a base64 data URL or a Files API id (`provider-file` from `openai`); it takes PDFs only, and has no audio, video, or generic file input on this endpoint. Anthropic sends a plain-text document as a `text` source whose `media_type` is always `text/plain`, and records the part's own type as `originalMimeType` in lineage. `lineage` (a `ContentPartLineage[]`) records, for each delivered part, its `from` and `to` source kinds and a `transform` (`passthrough`, `data-url-split`, `inline-base64`, `remote-url-delegated`, `provider-file-reference`, or `resolved`). Pass `{ sources }` (a map keyed `${messageId}:${partIndex}` to a `ResolvedMediaSource`) to export a part through a source a resolver projected, such as a managed asset resolved to inline bytes, without rewriting the stored message.

**Key exports:** `toOpenAIMessages`, `toOpenAIMessagesGrouped`, `fromOpenAIMessages`, `appendOpenAIMessages`, `openAIConversationAdapter`. Type exports: `OpenAIExport`, `OpenAIFileContentPart`, `OpenAIMessage`, `OpenAISystemMessage`, `OpenAIUserMessage`, `OpenAIAssistantMessage`, `OpenAIToolMessage`, `OpenAIToolCall`, `OpenAIContentPart`, `OpenAITextContentPart`, `OpenAIImageContentPart`, `OpenAIConversationExportOptions`.

### Anthropic conversion

Anthropic Messages API format adapter.

The neutral adapter has no runtime or type dependency on `@anthropic-ai/sdk`. The SDK-specific conversion is available from the separate `conversationalist/adapters/anthropic/sdk` entry point for consumers that install the optional peer.

```typescript
import {
  appendAnthropicMessages,
  anthropicConversationAdapter,
  fromAnthropicMessages,
  toAnthropicMessages,
} from 'conversationalist';
import type { AnthropicConversation } from 'conversationalist';

const payload = toAnthropicMessages(history);
// payload.system: string, payload.messages: AnthropicMessage[], payload.lineage: ContentPartLineage[]

const imported = fromAnthropicMessages(payload);
const updated = appendAnthropicMessages(history, payload);
```

**Key exports:** `toAnthropicMessages`, `fromAnthropicMessages`, `appendAnthropicMessages`, `anthropicConversationAdapter`. Type exports: `AnthropicConversation`, `AnthropicExport`, `AnthropicMessage`, `AnthropicContentBlock`, `AnthropicTextBlock`, `AnthropicToolUseBlock`, `AnthropicToolResultBlock`, `AnthropicImageBlock`, `AnthropicImageSource`, `AnthropicBase64ImageSource`, `AnthropicUrlImageSource`.

```typescript
import { toAnthropicMessagesForSdk } from 'conversationalist/adapters/anthropic/sdk';

const sdkPayload = toAnthropicMessagesForSdk(history);
```

### Gemini conversion

Google Gemini API format adapter.

```typescript
import {
  appendGeminiMessages,
  fromGeminiMessages,
  geminiConversationAdapter,
  toGeminiMessages,
} from 'conversationalist';
import type { GeminiConversation } from 'conversationalist';

const payload = toGeminiMessages(history);
// payload.contents: GeminiContent[], payload.lineage: ContentPartLineage[]

const imported = fromGeminiMessages(payload);
const updated = appendGeminiMessages(history, payload);
```

**Key exports:** `toGeminiMessages`, `fromGeminiMessages`, `appendGeminiMessages`, `geminiConversationAdapter`. Type exports: `GeminiConversation`, `GeminiExport`, `GeminiContent`, `GeminiPart`, `GeminiTextPart`, `GeminiInlineDataPart`, `GeminiFileDataPart`, `GeminiFunctionCallPart`, `GeminiFunctionResponsePart`.

### AG-UI message mapping

Maps Conversationalist history to and from the `messages` of an [AG-UI](https://docs.ag-ui.com) 1.0 `MESSAGES_SNAPSHOT` event, using the types and schemas of the pinned `@ag-ui/core` package. Event streaming is not included.

```ts
import { agUiConversationAdapter, fromAGUIMessages, toAGUIMessages } from 'conversationalist';

const messages = toAGUIMessages(history); // validated against the @ag-ui/core message schema
const imported = fromAGUIMessages(messages);
```

`system`, `developer`, `user`, and `assistant` messages keep their roles and their ids. A `thinking` part becomes a `reasoning` message placed before its assistant message (id `<assistant id>:reasoning:<n>`, signature as `encryptedValue`), and returns as a `thinking` part of the assistant message that follows; reasoning is therefore hoisted ahead of text. A `tool-call` message becomes an assistant message with one entry in `toolCalls`, and a `tool-result` becomes a `tool` message. Hidden, streaming, and `snapshot` messages are skipped on export, and `activity` messages are skipped on import.

Imported messages keep the AG-UI `id`, and a message that splits into several rows derives the extra ids from its own: an assistant message with text and `toolCalls` is a text row `<id>` plus a `tool-call` row `<id>:call:<toolCall.id>` per call, and one with only `toolCalls` gives its first call the id `<id>`. Export reads that derivation back, so `toAGUIMessages(fromAGUIMessages(x))` reproduces the ids of `x`, and an assistant message with text and calls comes back as one message. Conversation plugins do not run over imported messages, because `appendMessages` treats an input that carries an `id` as already built. `mergeAGUIMessages` adds the rows of a snapshot whose ids (and, for a tool call, whose call id) a conversation does not hold yet and never changes a row it has, which is how a whole-thread `MESSAGES_SNAPSHOT` meets a conversation that already shows part of it.

A tool result travels as the text of its content, with `error` set for a failure and the exact `ToolResult` in the message metadata under `conversationalist:toolResult` whenever the text would not recover it, so a success whose content is a string that looks like JSON stays a string and a success object shaped like a failure stays a success. A tool message from any other backend is read as a success whose content is its text (never parsed as JSON), or its parts as JSON when it carries media, and as a failure when `error` is set. Citations on user text travel in the text part's `metadata`, and on assistant, system, and developer text (which AG-UI holds as a plain string) in message metadata under `conversationalist:textParts`, which keeps the text parts and their boundaries. Content with no AG-UI representation (`redacted_thinking`, provider server-tool and container blocks, non-text system or assistant content) throws an `AGUIMappingError` whose `kind` names it, and an inbound message that fails the `@ag-ui/core` schema throws one with `kind: 'message'`. An assistant message's text parts join with a blank line, and token usage, goal completion, and cache boundaries are not exported.

**Key exports:** `toAGUIMessages`, `fromAGUIMessages`, `appendAGUIMessages`, `mergeAGUIMessages`, `fromAGUIToolMessage`, `agUiConversationAdapter`, `AGUIMappingError`. Type exports: `AGUIMessage`, `AGUIUserMessage`, `AGUIAssistantMessage`, `AGUISystemMessage`, `AGUIDeveloperMessage`, `AGUIToolMessage`, `AGUIReasoningMessage`, `AGUIToolCall`, `AGUIContentPart`.

### A2A content mapping

Pure content-shape mapping between Conversationalist messages and [A2A](https://a2a-protocol.org/) 1.0.1 `Message`, `Artifact`, and `Part` values. The A2A types are hand-written from `specification/a2a.proto` at tag `v1.0.1` and follow its proto3 JSON form. Transport and the A2A task lifecycle are not included.

```typescript
import {
  appendMessages,
  fromA2AMessage,
  resolveA2AArtifactReference,
  toA2AArtifact,
  toA2AMessage,
} from 'conversationalist';

const a2aMessage = toA2AMessage(message); // user -> ROLE_USER, assistant -> ROLE_AGENT
const { messageId, ...input } = fromA2AMessage(a2aMessage); // input: { role, content, metadata? }
conversation = appendMessages(conversation, input); // plugins run; a local id is minted

const artifact = toA2AArtifact({ artifactId: 'summary', content: 'Revenue grew.' });
const resolved = resolveA2AArtifactReference(
  { kind: 'a2a-reference', agentCardUrl, taskId, artifactId: 'summary' },
  { agentCardUrl, taskId, artifacts: [artifact] },
);
```

`text` content maps to a `text` part, and images and documents map to `raw` (inline) or `url` parts. An A2A `data` part comes back as a document holding `JSON.stringify(data)`, typed with the part's media type or `application/json`. On the way out, an inline document becomes a `data` part only when its bytes are exactly what `JSON.stringify` produces for the value they parse to, so no file is rewritten; pretty-printed JSON, or JSON with integers beyond double precision, stays a `raw` part byte for byte. Reasoning, provider server-tool, and container content, and roles other than `user` and `assistant`, throw an `A2AMappingError` whose `kind` names the part kind or role.

`fromA2AMessage` returns the A2A `messageId` as `messageId`, never as `id`: `appendMessages` treats an input with an `id` as an already-built message and skips conversation plugins, and a remote agent should not choose local message ids. An `a2a-reference` source carries the peer's `taskId` as well as its `agentCardUrl` and `artifactId`, because the proto makes an `artifactId` unique only within a task. `resolveA2AArtifactReference` takes a catalog of one agent's artifacts for one task and resolves a reference only when both the agent and the task match, so artifacts with the same id in two tasks never resolve to each other; an id that appears twice in one catalog, or a reference the catalog does not hold, throws an `A2AMappingError`.

Conversationalist content has fewer fields than an A2A part, so these mappings normalize instead of round-tripping exactly: a text part's media type, and part metadata other than text `citations` and image alternative `text`, are not carried; a data part declaring exactly `application/json` comes back without it; a file part without a media type comes back as an `application/octet-stream` document, so an image with no `mimeType` and a non-data URL returns as a document; an unnamed `image/*` document returns as image content; and a `raw` file whose bytes are already compact JSON returns as a `data` part carrying the same bytes. A file or data part without a filename becomes a document named `document`, because a document name must be non-empty, and that name maps back to no filename; a part whose filename is exactly `document` therefore returns unnamed.

**Key exports:** `toA2AMessage`, `fromA2AMessage`, `toA2AArtifact`, `fromA2AArtifact`, `toA2APart`, `toA2AParts`, `fromA2APart`, `toA2AArtifactReference`, `fromA2AArtifactReference`, `referenceA2AArtifact`, `resolveA2AArtifactReference`, `A2AMappingError`. Type exports: `A2AMessage`, `A2AArtifact`, `A2APart`, `A2ATextPart`, `A2ARawPart`, `A2AUrlPart`, `A2ADataPart`, `A2ARole`, `A2AStruct`, `A2AArtifactReference`, `A2AArtifactCatalog`, `A2AReferenceSource`, `A2AInboundMessage`, `A2AArtifactContent`.

### Test utilities

Deterministic test environments with fixed clocks and IDs, prebuilt test conversations, and event recorders.

```typescript
import {
  createConversationRecorder,
  createTestConversation,
  createTestConversationEnvironment,
  createTestInstructionContext,
} from 'conversationalist';

// Deterministic clock + ID generator—no random values in snapshots.
// `now` returns an ISO string; `identifiers` supplies the deterministic id sequence.
const env = createTestConversationEnvironment({
  now: () => '2024-01-01T00:00:00.000Z',
  identifiers: ['id-1', 'id-2', 'id-3'],
});

// Test conversation in a deterministic environment. The first argument is an
// optional initial ConversationHistory; the second is the same options object.
const conversation = createTestConversation(undefined, {
  now: () => '2024-01-01T00:00:00.000Z',
});

// Collect all events emitted during a test
const recorder = createConversationRecorder(conversation);
conversation.appendUserMessage('Hello');
console.log(recorder.events); // [{ type: 'change', ... }, ...]
recorder.clear();

// Instruction rendering context for testing composition helpers
const context = createTestInstructionContext({ step: 0, metadata: { mode: 'strict' } });
```

**Key exports:** `createTestConversationEnvironment`, `createTestConversation`, `createConversationRecorder`. Types: `TestConversationEnvironmentOptions`, `TestConversationEnvironment`, `ConversationRecorder`.

Also exports `createTestInstructionContext`.

## Provider Conversion

### Generic provider helpers

```typescript
import { Conversation } from 'conversationalist';

const conversation = new Conversation();

const openAIPayload = await conversation.toProvider('openai');
const anthropicPayload = await conversation.toProvider('anthropic');

await conversation.appendProvider('openai', [{ role: 'user', content: 'Hello' }]);

const restored = await Conversation.fromProvider('gemini', {
  contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
});
```

### Provider-specific convenience methods

`Conversation` also exposes:

- `Conversation.fromOpenAIMessages(...)`
- `Conversation.fromAnthropicMessages(...)`
- `Conversation.fromGeminiMessages(...)`
- `conversation.toOpenAIMessages()`
- `conversation.toOpenAIMessagesGrouped()`
- `conversation.toAnthropicMessages()`
- `conversation.toGeminiMessages()`

## Tool Interoperability

`conversationalist` is designed to pair naturally with `armorer`.

```typescript
import { appendToolCalls, appendToolResultsAsync } from 'conversationalist';
import { createToolbox } from 'armorer';
import { parseOpenAIToolCalls, toOpenAITools } from 'armorer';

const toolbox = createToolbox();
const tools = await toolbox.toProvider('openai');
const toolCalls = parseOpenAIToolCalls(response);

conversationHistory = appendToolCalls(conversationHistory, toolCalls);

const results = await toolbox.execute(toolCalls, { stream: true });
conversationHistory = await appendToolResultsAsync(conversationHistory, results);
```

Shared tool types and materializers are provided by `armorer/protocol`, a dependency-free subpath of Armorer, and re-exported by both packages.

## Events

For how conversation observation and disposal fit with run, tool, and runtime ownership, see [Runtime contracts across Corvidae](../../documentation/runtime-contracts.md).

`Conversation` is both a framework-neutral external store and a typed event source. Store subscriptions never start work or invoke the listener during setup, so the standard read-subscribe-read pattern closes the setup race and React Strict Mode setup-cleanup-setup remains safe:

```typescript
const conversation = new Conversation(initialHistory);
const before = conversation.getSnapshot();
const unsubscribe = conversation.subscribe(() => {
  const next = conversation.getSnapshot();
  render(next.conversation, next.revision, next.lifecycle);
});
const after = conversation.getSnapshot();
if (after !== before) render(after.conversation, after.revision, after.lifecycle);

const serverSnapshot = conversation.getServerSnapshot();
JSON.stringify(serverSnapshot);

unsubscribe();
conversation.complete();
await conversation.dispose();
```

`getSnapshot()` and `getServerSnapshot()` return the same cached, immutable, serializable `{ conversation, revision, lifecycle }` value until a transition commits. `complete()` and `close()` idempotently close the controller: later writes throw a typed `ConversationalistError` with `error:conversation-closed`, while reads remain available. `dispose()` aborts owned work, awaits final quiescence, releases subscriptions, and changes the lifecycle to `disposed`. Synchronous `Symbol.dispose` starts that cleanup; `Symbol.asyncDispose` awaits it.

Expected-revision clients can use `applyMutation(...)`; external projections can use `reconcileExternalSnapshot(...)`. Both return frozen accepted or rejected results without hidden mutation. Stale external revisions and stale compaction results are discarded; [Compaction](#compaction) describes the compaction compare-and-swap.

The typed event surface remains available independently:

- DOM-style `addEventListener(...)` and `removeEventListener(...)`
- `on(...)`
- `once(...)`
- `subscribe(type, ...)` for typed events, or `subscribe(onStoreChange)` for the external store
- `toObservable()`
- `events(type)`
- `close()`, `complete()`, `dispose()`, `lifecycle`, and `completed`
- `watch(...)` for current-state observation

Event types include:

- `change`
- `push`
- `undo`
- `redo`
- `switch`
- `messages.appended`
- `messages.updated`
- `messages.removed`
- `tool-calls.appended`
- `tool-results.appended`
- `stream.started`
- `stream.updated`
- `stream.finalized`
- `stream.cancelled`
- `compaction.started`
- `compaction.completed`
- `compaction.failed`
- `compaction.cancelled`
- `compaction.stale-discarded`
- `mutation.rejected`
- `snapshot.restored`
- `branch.pruned`
- `controller.closed`
- `controller.disposed`
- `plugin.activated`
- `plugin.failed`
- `session.forked`
- `session.renamed`
- `session.tagged`

Every mutation event carries the resulting controller `revision`, a monotonic event `sequence`, `correlationId`, `durability`, and `outcome`, plus an `actor` when supplied. Stream updates also carry a per-message monotonic `streamSequence`. Fork events identify the child conversation.

Message plugins remain transcript transformations only. Use `defineMessagePlugin({ id, revision }, transform)` to give a plugin stable identity. Duplicate identities are rejected, and activation or failure events include the plugin identity and fixed `transcript-transform` authority; plugins cannot register Bureau, Agent, run, or authorization hooks.

Streaming messages (those with `metadata.__streaming === true`) are automatically protected from compaction, truncation, and adapter export. Compaction always keeps a streaming message rather than summarizing it, under the identifier it already has, so the stream keeps writing to the same message after a commit (see [What compaction keeps](#what-compaction-keeps)). Streaming messages are locked in `truncateToTokenLimit` and `truncateFromPosition`, and excluded from provider adapters so that incomplete content is never sent to an API.

## Compaction

Compaction reclaims context-window space by replacing older messages with a summary. You supply the summarizer, so the library has no large language model dependency. `Conversation.compact()` builds the summary as a candidate that nothing else can see, then publishes it only if the conversation has not changed since the attempt started. If a message, tool result, or streamed token lands while the summary is being written, the candidate is thrown away instead of overwriting that newer state.

### Compacting a conversation

```typescript
import { Conversation, messageText, type Summarizer } from 'conversationalist';

// `summarizeWithModel` is your model call. The library forwards the signal but never
// checks it between chunks, so passing it through is what stops the work on abort.
const summarize: Summarizer = (messages, options) =>
  summarizeWithModel(messages.map((message) => messageText(message)).join('\n'), options?.signal);

const conversation = new Conversation(existingHistory);
const result = await conversation.compact(summarize, { preserveRecentCount: 6 });

switch (result.outcome) {
  case 'committed':
    console.log(`Replaced ${result.messagesRemoved} messages at revision ${result.revision}`);
    break;
  case 'no-op':
    // Nothing was old enough to summarize, and the revision did not move.
    break;
  case 'discarded':
    // result.reason is 'revision-conflict': a newer write landed while the summary
    // was being written. The candidate was dropped and the newer history is untouched.
    console.log(
      `Built at revision ${result.attempt.baseRevision}, stale at ${result.attempt.observedRevision}`,
    );
    break;
}
```

`compact()` resolves one of three outcomes:

- **`committed`**: the candidate replaced the current history as one new history node. `compacted` is `true` and `revision` is the new controller revision.
- **`no-op`**: no message was eligible for summarizing, so nothing was published and the revision did not move.
- **`discarded`**: the conversation moved past the attempt's base revision before the candidate could publish. `reason` is `'revision-conflict'`, `compacted` is `false`, `messagesRemoved` is `0`, `summaryContent` is empty, and `revision` is the newer revision.

Failures reject instead of resolving, and publish nothing. A failed attempt rejects with the error that ended it, which is usually, but not always, the summarizer's error: checking the kept messages can also reject with `error:invalid-tool-reference`, as [What compaction keeps](#what-compaction-keeps) describes. An aborted `signal`, or closing or disposing the conversation mid-attempt, rejects with a `ConversationalistError` whose `code` is `error:operation-cancelled`. The library only forwards the signal to the summarizer and does not check it between chunks, so a summarizer that ignores it runs every chunk before the attempt rejects. Calling `compact()` on a closed or disposed conversation rejects with `error:conversation-closed` or `error:conversation-disposed` before any summarizer runs.

### What compaction keeps

Revisioned commits did not change which messages are summarized. The summarizer sees visible messages only, and of those `compact()` keeps these by default:

- every `system` message
- the most recent `preserveRecentCount` non-system messages (default `4`)
- open streaming messages
- messages marked `metadata.pinned`, `metadata.decision`, or `metadata.error`, and tool results whose outcome is `error`

A kept tool call or tool result keeps its visible partner. For the recent window, that holds only while `preserveToolPairs` is `true`, which is the default. Every other visible message is split into chunks and handed to the summarizer one chunk at a time, in order. Before a chunk reaches the summarizer, its tool-result payloads are replaced with a `[tool result]` placeholder and its thinking blocks are dropped. The [API reference](documentation/api-reference.md#compaction) lists every option and default.

Hidden messages are never summarized and never dropped. A commit keeps every hidden message, whatever its role or metadata, so a hidden `system`, pinned, decision, error, or streaming message survives it. Summarizing them would copy content the transcript deliberately hides into a visible summary, so the summarizer never receives one. The rules around that:

- `messagesRemoved` counts the messages that left history, and only those. Every kept message, hidden or not, stays out of the count.
- The `preserveRecentCount` window counts visible non-system messages only, so a hidden message never uses up a slot in it.
- A hidden tool call or tool result is kept, and pulls its visible partner in with it, so a tool pair stays intact across the hidden/visible boundary.
- A no-op publishes nothing, so hidden messages survive it too.

The committed history starts with a single `system` message carrying `metadata.compactionSummary: true`, followed by the kept messages in their original order. The kept messages are carried over, not rebuilt:

- Each kept message keeps its `id`, `createdAt`, content, metadata, `hidden` flag, tool call or tool result, `tokenUsage`, `cacheBoundary`, and, on an assistant message, `goalCompleted`. Only `position` changes, because the messages now follow the summary.
- The conversation's message plugins do not run over kept messages again, so a plugin that is not idempotent applies once, when the message was first appended.
- The summary message is not passed through the plugins either. The stored summary is exactly `result.summaryContent`, which is the chunk summaries joined with `\n\n---\n\n`.

Compaction never publishes a tool result without its call. A hidden call is always kept, so a kept visible tool result whose call is hidden no longer fails the attempt, whatever `preserveToolPairs` is set to. The attempt still rejects with `error:invalid-tool-reference` in one case:

- **`preserveToolPairs` is `false`.** If the recent window holds a tool result whose call would be summarized, for example because the window begins on that result, the attempt rejects.

The summarizer has already run by then. `compact()` emits `compaction.started` and then `compaction.failed`, and publishes nothing.

### Revisions and compare-and-swap

`conversation.revision` is the controller revision. It is a monotonic counter that moves on every committed state transition, including:

- appending, updating, or removing messages
- streaming tokens, and finalizing or cancelling a stream
- appending tool calls and tool results
- `push()`, `undo()`, `redo()`, and `switchToBranch()`
- an accepted `applyMutation()` or `reconcileExternalSnapshot()`
- a compaction commit itself

It is the same number that `getSnapshot().revision`, `snapshot().controllerRevision`, and every event's `revision` carry. Compaction does not keep a counter of its own.

Each attempt uses the revision like this:

1. `compact()` reads the current history and revision synchronously, before it returns its promise. That revision becomes the attempt's `baseRevision`, and any write you make after the call returns is newer than the candidate.
2. The summarizer runs against that snapshot. While it runs, `current`, `revision`, `getSnapshot()`, `snapshot()`, and the undo tree stay exactly as they were. The attempt emits `compaction.started` and nothing else until it settles.
3. When the summary is ready, `compact()` compares the live revision with `baseRevision`. The comparison and the commit happen in one synchronous step, so no other write can land between them.
4. If the revisions match, the candidate is committed and the revision moves to `baseRevision + 1`.
5. If they differ, the candidate is dropped. The current history, revision, store snapshot, and history tree stay byte-for-byte as the newer write left them, and the attempt's `observedRevision` is that newer revision.

A no-op follows the same rule: if nothing was eligible but the revision moved while the attempt ran, it resolves `discarded`, not `no-op`.

This race mirrors `test/compaction-revision.test.ts`. The summarizer waits on a promise, so a write can land while the summary is being written:

```typescript
import { Conversation, createConversationHistory } from 'conversationalist';

const conversation = new Conversation(createConversationHistory());
for (let index = 0; index < 8; index++) {
  conversation.appendUserMessage(`question ${index}`);
  conversation.appendAssistantMessage(`answer ${index}`);
}

let finishSummary!: () => void;
const summaryWritten = new Promise<void>((resolve) => {
  finishSummary = resolve;
});

const compacting = conversation.compact(
  async (messages) => {
    await summaryWritten;
    return `Summary of ${messages.length} messages`;
  },
  { preserveRecentCount: 2 },
);

// compact() captured revision 16. This append moves the conversation to 17.
conversation.appendUserMessage('arrived mid-summary');
finishSummary();

const result = await compacting;
result.outcome; // 'discarded'
result.attempt.baseRevision; // 16
result.attempt.observedRevision; // 17
conversation.revision; // 17
conversation.getMessages().at(-1)?.content; // 'arrived mid-summary'
```

If you still need the space, call `compact()` again. The new attempt summarizes the newer history.

A committed compaction is an ordinary history node, so `undo()` returns to the uncompacted history, as a new revision like any other undo. Operative's context-epoch sealer versions the conversation source by this revision. A commit therefore always seals a new effective-context epoch, and an attempt that published nothing never does.

### Compaction events

Every attempt emits `compaction.started` and then exactly one settling event. Each event carries the attempt record on `event.compaction`, typed as `CompactionAttempt`:

| Field | Meaning |
| --- | --- |
| `attemptId` | Identity of one `compact()` call, minted from the environment runtime's identifiers. Every event of one attempt carries the same value. |
| `baseRevision` | Controller revision of the snapshot the candidate is built from. |
| `observedRevision` | Controller revision when the record was taken. It equals `baseRevision` on a commit and is the newer revision on a discard. |
| `durationMs` | Milliseconds since the attempt started, on the environment runtime's clock. |
| `baseTokens` | Estimated tokens in the base snapshot, using the conversation's token estimator (the value `conversation.estimateTokens()` returned at the start). |
| `candidateTokens` | Estimated tokens in the candidate. Present only once a candidate exists. |

| Event | Emitted when | `event.revision` | `event.outcome` | `event.reason` | `candidateTokens` |
| --- | --- | --- | --- | --- | --- |
| `compaction.started` | Inside the `compact()` call, before it returns | base revision | `started` | — | absent |
| `compaction.completed` | The candidate committed | base revision + 1 | `completed` | — | present |
| `compaction.completed` | No-op: nothing was eligible and the revision had not moved | base revision | `completed` | — | equals `baseTokens` |
| `compaction.stale-discarded` | The revision moved before the compare-and-swap | the newer revision | `discarded` | `revision-conflict` | present |
| `compaction.failed` | The attempt threw (usually the summarizer) while the conversation was open and the attempt was not aborted | current revision | `failed` | the error, as a string | absent |
| `compaction.cancelled` | The attempt's `signal` aborted while the conversation was open | current revision | `cancelled` | the abort reason, or the error the aborted summarizer threw, as a string | absent |

The result's `attempt` equals the record on the settling event. A commit also emits `change` (with `action: 'compaction.completed'`) and `push` just before `compaction.completed`. All three carry the new revision and the same `compaction` record. Their `messageIds` list every identifier the commit removed, which are the summarized messages and nothing else: kept messages, hidden or not, keep their identifiers. An attempt that publishes nothing emits no `change` or `push`, so store subscribers are not notified. Closing or disposing the conversation mid-attempt emits no `compaction.cancelled`, because the controller has stopped emitting. The promise still rejects with `error:operation-cancelled`.

```typescript
for (const type of [
  'compaction.started',
  'compaction.completed',
  'compaction.stale-discarded',
  'compaction.failed',
  'compaction.cancelled',
] as const) {
  conversation.addEventListener(type, (event) => {
    const attempt = event.compaction;
    if (!attempt) return;
    console.log(type, attempt.attemptId, attempt.baseRevision, attempt.observedRevision);
  });
}
```

`CompactionStartedEvent` and `CompactionCompletedEvent` are exported event classes. The other three compaction events dispatch as `ConversationEvent`.

### Compaction limits

- **No rebasing.** A discarded candidate is never merged into the newer history, and `compact()` never retries on its own. Call it again, or use the background scheduler, which reschedules a fresh candidate under a bounded policy.
- **Preservation policy is unchanged.** Revisioned commits changed _when_ a candidate may publish, not _which_ messages it keeps. The retention rules above behave as they did before.
- **`compact()` does not wait for a durable boundary.** A tool call that is still waiting for its result can be summarized away if it falls outside the recent window. Appending its result afterwards throws `error:invalid-tool-reference`, and `appendToolResultAsync()` rejects with it. An open stream is not at risk: the streaming message is kept under its own identifier, and `updateStreamingMessage`, `finalizeStreamingMessage`, and `cancelStreamingMessage` keep acting on it. Call `compact()` when no tool call is pending, or use the background scheduler, which starts candidates only at a durable boundary.
- **Overlapping calls are not serialized.** Two `compact()` calls started from the same revision each run their own summarizer. The first to finish commits, and the other resolves `discarded`. The background scheduler runs one candidate at a time.
- **No progress events.** An attempt reports `compaction.started` and one settling event. There is no per-chunk progress event.
- **`compactConversation()` has no revision check.** The pure helper resolves `{ conversation, result }`, emits no events, and publishes nothing. It hands `signal` to the summarizer and never checks it, so an ignored signal has no effect and the call resolves normally. `push()` commits its output unconditionally. `applyMutation({ expectedRevision }, () => compacted)` with the revision you read before summarizing rejects a stale result with `reason: 'revision-conflict'`.

### Background compaction

`createCompactionScheduler()` prepares candidates off the caller's critical path. It publishes only by calling `conversation.compact()`, so every candidate goes through the same compare-and-swap. On top of that, the scheduler adds:

- single-flight requests
- a bounded stale-retry policy
- durable-boundary gating
- cancellation
- a state snapshot you can inspect

```typescript
import { createCompactionScheduler, createIdleCompactionSchedule } from 'conversationalist';

const scheduler = createCompactionScheduler(conversation, {
  summarizer: summarize,
  compaction: { preserveRecentCount: 6 },
  // Uses requestIdleCallback in browsers and falls back to a timer elsewhere.
  schedule: createIdleCompactionSchedule(),
});

const outcome = await scheduler.request(); // resolves a typed outcome and never rejects
console.log(outcome.outcome, scheduler.state.phase, scheduler.state.counts);
await scheduler.dispose();
```

A stale candidate is discarded and rescheduled in a new window up to `maxStaleRetries` times (default `2`). After that, the request settles `discarded`. Candidates are never rebased. Scheduling decides only when work runs. It is neither persistence nor ownership of the conversation. The [API reference](documentation/api-reference.md#background-compaction) covers the full policy. `@lostgradient/operative` wires the scheduler into agent steps through `contextManagement.background`.

## Documentation

- [API Reference](documentation/api-reference.md)
- [Runtime contracts across Corvidae](../../documentation/runtime-contracts.md) - Cross-package state, tool, run, and cleanup ownership

## Development

Run the focused checks from this package directory:

```bash
bun run lint
bun run typecheck
bun run test
```

From the Corvidae root, run `bunx turbo run lint typecheck test --filter=conversationalist` for this workspace or `bun run validate` for the complete workspace. Formatting is configured at the root. This library has no build or publishing command.
