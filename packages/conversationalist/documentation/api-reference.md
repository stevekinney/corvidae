# Conversationalist Public API Reference

This document describes the public API exposed by the `conversationalist` package root.

## Core conversation API

### Functions

- `appendAssistantMessage`
- `appendMessages`
- `appendSystemMessage`
- `appendToolCall`
- `appendToolCalls`
- `appendToolResult`
- `appendToolResultAsync`
- `appendToolResults`
- `appendToolResultsAsync`
- `appendUnsafeMessage`
- `appendUserMessage`
- `assertConversationHistoryIntegrity`
- `collapseSystemMessages`
- `createConversationHistory`
- `createConversationHistoryUnsafe`
- `currentConversationFromSnapshot`
- `deserializeConversationHistory`
- `getFirstSystemMessage`
- `getMessageAtPosition`
- `getMessageById`
- `getMessageIds`
- `getMessages`
- `getPendingToolCalls`
- `getStatistics`
- `getSystemMessages`
- `getToolInteractions`
- `hasSystemMessage`
- `materializeToolCall`
- `materializeToolCalls`
- `materializeToolResult`
- `materializeToolResultAsync`
- `materializeToolResults`
- `materializeToolResultsAsync`
- `migrateConversationSnapshotV1`
- `pipeConversationHistory`
- `prependSystemMessage`
- `redactMessageAtPosition`
- `removeMessage`
- `replaceToolResult`
- `replaceSystemMessage`
- `searchConversationMessages`
- `setMessageHidden`
- `toChatMessages`
- `updateMessage`
- `validateConversationHistoryIntegrity`
- `withConversationHistory`

### Guards

- `isConversationHistory`
- `isConversationStatus`
- `isJSONValue`
- `isMessage`
- `isMessageInput`
- `isMessageRole`
- `isMultiModalContent`
- `isTokenUsage`
- `isToolCall`
- `isToolResult`

### Errors

- `ConversationalistError`
- `createDuplicateIdError`
- `createInvalidInputError`
- `createInvalidPositionError`
- `createInvalidToolReferenceError`
- `createLockedError`
- `createNotFoundError`
- `createSerializationError`
- `createValidationError`

### Class

- `Conversation`

### Root types

- `AppendToolCallOptions`
- `AppendToolResultOptions`
- `AppendableToolAction`
- `AppendableToolCallInput`
- `AppendableToolError`
- `AppendableToolResult`
- `AssistantMessage`
- `ChatMessage`
- `ChatMessageRole`
- `ConversationActionType`
- `ConversationEnvironment`
- `ConversationEvent`
- `ConversationEventDetail`
- `ConversationEventMap`
- `ConversationEventType`
- `ConversationHistory`
- `ConversationHistoryDraft`
- `ConversationHistoryHeader`
- `ConversationNodeSnapshot`
- `ConversationNodeSnapshotV1`
- `ConversationProvider`
- `ConversationSnapshot`
- `ConversationSnapshotIntegrity`
- `ConversationSnapshotLineage`
- `ConversationSnapshotV1`
- `ConversationStatus`
- `ConversationalistErrorCode`
- `ImageContent`
- `IntegrityIssue`
- `IntegrityIssueCode`
- `JSONValue`
- `MaterializeToolCallOptions`
- `Message`
- `MessageInput`
- `MessageUpdate`
- `MessageRole`
- `MultiModalContent`
- `RedactMessageOptions`
- `TextContent`
- `TokenUsage`
- `ToolAction`
- `ToolActionInput`
- `ToolCall`
- `ToolCallInput`
- `ToolError`
- `ToolErrorCategory`
- `ToolErrorInput`
- `ToolInteraction`
- `ToolResult`
- `ToolResultInput`

The compaction types (`CompactionAttempt`, `CompactionOptions`, `CompactionPreservePolicy`, `CompactionResult`, `ConversationCompactionResult`, and `Summarizer`) are also root types. [Compaction](#compaction) documents each field.

## `Conversation` class

### Static methods

- `Conversation.from(snapshot, environment?)`
- `Conversation.fromProvider(provider, payload, environment?)`
- `Conversation.fromOpenAIMessages(messages, environment?)`
- `Conversation.fromAnthropicMessages(payload, environment?)`
- `Conversation.fromGeminiMessages(payload, environment?)`

### Event methods

- `addEventListener(type, listener, options?)`
- `removeEventListener(type, listener, options?)`
- `dispatchEvent(event)`
- `watch(run)`
- `on(type, options?)`
- `once(type, listener, options?)`
- `subscribe(type, observerOrNext?, error?, complete?)`
- `toObservable()`
- `events(type, options?)`
- `complete()`
- `completed`

### State getters

- `current`
- `ids`
- `env`
- `revision`
- `branchCount`
- `branchIndex`
- `redoCount`
- `getSnapshot()`

`revision` is the monotonic controller revision. Every committed state transition moves it, including undo, redo, branch switches, and a compaction commit. `getSnapshot().revision`, `snapshot().controllerRevision`, and every event's `revision` carry the same value.

### History methods

- `push(next)`
- `undo()`
- `redo(childIndex?)`
- `switchToBranch(index)`
- `getPath()`
- `snapshot()`

### Query methods

- `getMessages(options?)`
- `getMessageAtPosition(position)`
- `getMessageIds()`
- `getMessageById(id)`
- `get(id)`
- `searchMessages(predicate)`
- `getStatistics()`
- `hasSystemMessage()`
- `getFirstSystemMessage()`
- `getSystemMessages()`
- `toChatMessages()`
- `estimateTokens(estimator?)`
- `getRecentMessages(limit, options?)`
- `getStreamingMessage()`
- `getPendingToolCalls()`
- `getToolInteractions()`

### Mutation methods

- `appendMessages(...inputs)`
- `appendUserMessage(content, metadata?)`
- `appendAssistantMessage(content, metadata?, goalCompleted?)`
- `appendSystemMessage(content, metadata?)`
- `prependSystemMessage(content, metadata?)`
- `replaceSystemMessage(content, metadata?)`
- `collapseSystemMessages()`
- `redactMessageAtPosition(position, options?)`
- `truncateFromPosition(position, options?)`
- `rewindBeforePosition(position, options?)`
- `rewindBeforeMessage(messageId, options?)`
- `truncateToTokenLimit(maxTokens, options?)`
- `appendStreamingMessage(role, metadata?)`
- `updateStreamingMessage(messageId, content)`
- `finalizeStreamingMessage(messageId, options?)`
- `cancelStreamingMessage(messageId)`
- `appendToolCall(toolCall, options?)`
- `appendToolCalls(toolCalls)`
- `appendToolResult(toolResult, options?)`
- `appendToolResultAsync(toolResult, options?)`
- `appendToolResults(toolResults)`
- `appendToolResultsAsync(toolResults)`
- `appendProvider(provider, payload)`

### Compaction method

- `compact(summarizer, options?)`: resolves a `ConversationCompactionResult`. See [Compaction](#compaction).

### Provider export methods

- `toProvider(provider, options?)`
- `toOpenAIMessages()`
- `toOpenAIMessagesGrouped()`
- `toAnthropicMessages()`
- `toGeminiMessages()`

## Conversation helpers

### Functions

- `appendAssistantMessage`
- `appendMessages`
- `appendSystemMessage`
- `appendToolCall`
- `appendToolCalls`
- `appendToolResult`
- `appendToolResultAsync`
- `appendToolResults`
- `appendToolResultsAsync`
- `appendUnsafeMessage`
- `appendUserMessage`
- `assertConversationHistoryIntegrity`
- `collapseSystemMessages`
- `createConversationHistory`
- `createConversationHistoryUnsafe`
- `deserializeConversationHistory`
- `getFirstSystemMessage`
- `getMessageAtPosition`
- `getMessageById`
- `getMessageIds`
- `getMessages`
- `getPendingToolCalls`
- `getStatistics`
- `getSystemMessages`
- `getToolInteractions`
- `hasSystemMessage`
- `materializeToolCall`
- `materializeToolCalls`
- `materializeToolResult`
- `materializeToolResultAsync`
- `materializeToolResults`
- `materializeToolResultsAsync`
- `prependSystemMessage`
- `redactMessageAtPosition`
- `removeMessage`
- `replaceToolResult`
- `replaceSystemMessage`
- `searchConversationMessages`
- `setMessageHidden`
- `toChatMessages`
- `updateMessage`
- `validateConversationHistoryIntegrity`
- `withEnvironment`

### Types

- `AppendToolCallOptions`
- `AppendToolResultOptions`
- `AppendableToolAction`
- `AppendableToolCallInput`
- `AppendableToolError`
- `AppendableToolResult`
- `ConversationEnvironment`
- `IntegrityIssue`
- `IntegrityIssueCode`
- `MaterializeToolCallOptions`
- `MessageUpdate`
- `RedactMessageOptions`
- `ToolCallInput`
- `ToolInteraction`

### Immutable mutation contracts

- `updateMessage(history, messageId, updates, environment?)` replaces editable content, metadata, visibility, token usage, or cache-boundary fields while preserving message identity and order. Explicit `undefined` clears optional token-usage and cache-boundary fields.
- `removeMessage(history, messageId, environment?)` removes one message and restores contiguous positions across the survivors.
- `setMessageHidden(history, messageId, hidden, environment?)` changes visibility without removing the stored message.
- `replaceToolResult(history, toolCallId, toolResult, environment?)` replaces the result paired with a tool-call identifier while preserving the result message's identity and position. The replacement `callId` must match `toolCallId`.

All four helpers return the original history unchanged for an unknown target. Successful mutations return a new immutable history after schema and integrity validation. Helpers that create an updated message run configured message plugins against the stored and updated inputs before validation, then apply the complete processed mutable payload. They preserve assistant completion state in plugin inputs and verify repeatable, idempotent plugin output for both inputs. Message plugins used by mutation helpers must be deterministic, side-effect-free, and idempotent. Plugin-processed tool calls and results must retain their identifiers, regardless of whether the edit uses `updateMessage` or `replaceToolResult`.

## Context and truncation

### Functions

- `estimateConversationTokens`
- `getRecentMessages`
- `rewindBeforeMessage`
- `rewindBeforePosition`
- `simpleTokenEstimator`
- `truncateFromPosition`
- `truncateToTokenLimit`

### Types

- `AsyncEstimateConversationTokensOptions`
- `AsyncTruncateOptions`
- `EstimateConversationTokensOptions`
- `RewindOptions`
- `TruncateOptions`

## Compaction

`Conversation.compact()` summarizes older messages and publishes the result only through a compare-and-swap on the controller revision. The [README](../README.md#compaction) walks through the contract with examples.

### Functions

- `compactConversation(history, summarizer, options?, environment?)`
- `stripToolResultDetails(messages)`

`compactConversation` is the pure transform that `compact()` runs. It resolves `{ conversation, result }`, where `result` is a `CompactionResult`. When nothing is eligible, it returns the input history with `compacted: false`. It has no revision check, emits no events, and publishes nothing. If you publish its output yourself, use `applyMutation({ expectedRevision }, () => compacted)` with the revision you read before summarizing. `push()` commits unconditionally.

`stripToolResultDetails` is the pass applied to each chunk before it reaches the summarizer:

- tool-result content and server-tool payloads become `[tool result]`
- `citations` fields are removed
- document blocks become reference text
- thinking and redacted-thinking blocks are dropped

Kept messages are not stripped.

### `Conversation` method

- `compact(summarizer, options?)`: returns `Promise<ConversationCompactionResult>`

### Event classes

- `CompactionStartedEvent`: `compaction.started`
- `CompactionCompletedEvent`: `compaction.completed`

`compaction.failed`, `compaction.cancelled`, and `compaction.stale-discarded` dispatch as `ConversationEvent` and are typed in `ConversationEventMap`. Each compaction event carries the attempt on `compaction`, typed as `CompactionAttempt`.

### Types

- `CompactionAttempt`
- `CompactionOptions`
- `CompactionPreservePolicy`
- `CompactionResult`
- `ConversationCompactionResult`
- `Summarizer`

#### `Summarizer`

`(messages: Message[], options?: { maxTokens?: number; signal?: AbortSignal }) => Promise<string>`

Within one `compact()` or `compactConversation()` call, the summarizer is called once per chunk, in order, and never concurrently. A tool call that is immediately followed by its result stays in the same chunk. `maxTokens` is `CompactionOptions.maxSummaryTokens`, which the library forwards but does not enforce. From `compact()`, `signal` aborts when the caller's `signal` aborts or when the conversation closes or is disposed. From `compactConversation()`, it is the caller's `signal` unchanged. Either way, the library forwards `signal` without checking it, so only the summarizer can stop work early.

#### `CompactionOptions`

| Field | Default | Meaning |
| --- | --- | --- |
| `signal` | none | Forwarded to the summarizer. The library does not check it between chunks, so a summarizer that ignores it runs every chunk. `compact()` combines it with the conversation's lifecycle signal, and an aborted attempt rejects with `error:operation-cancelled` and publishes nothing, whether the summarizer stopped early or ran every chunk. `compactConversation()` passes it through unchanged: an ignored signal has no effect and the call resolves normally, while a summarizer that honours it makes the call reject with the summarizer's own abort error. |
| `preserveRecentCount` | `4` | Number of most recent visible non-system messages to keep. Hidden messages do not count toward it. With this many visible non-system messages or fewer, nothing is eligible and the attempt is a no-op. |
| `preserveSystemMessages` | `true` | Keeps every visible `system` message. When `false`, visible system messages are eligible for summarizing. A hidden system message is kept either way. |
| `preserveToolPairs` | `true` | Keeps both halves of a visible tool call and result when the recent window includes one of them. With `false`, a recent window that holds a tool result whose call would be summarized (for example, a window that begins on that result) makes the attempt reject with `error:invalid-tool-reference`. A hidden call is always kept, so a kept tool result whose call is hidden does not reject under either setting. The summarizer has already run by then. `compact()` emits `compaction.failed` and publishes nothing, and `compactConversation()` rejects the same way. |
| `baseChunkRatio` | `0.4` | Chunk budget as a fraction of the eligible tokens: `floor(eligibleTokens × ratio ÷ safetyMargin)`, and at least `1`. |
| `minimumChunkRatio` | `0.15` | Used instead of `baseChunkRatio` when the average eligible message is more than 30% of the eligible total. |
| `safetyMargin` | `1.2` | Divisor applied to the chunk budget. |
| `maxSummaryTokens` | none | Forwarded to the summarizer as `maxTokens`. |
| `preservePolicy` | every field `true` | `CompactionPreservePolicy` for annotated messages. |

Open streaming messages are always kept, and so are the visible tool partners of streaming and policy-kept messages, whatever these options say. These retention rules predate revisioned commits and are unchanged by them.

The summarizer sees visible messages only, and the recency window counts visible non-system messages only. Every hidden message is kept, never summarized and never dropped, whatever its role or metadata:

- A hidden `system`, pinned, decision, error, or streaming message survives a commit.
- `messagesRemoved` equals the number of messages that left history.
- A hidden tool call or tool result is kept together with its visible partner, so a kept visible tool result whose call is hidden does not fail the attempt, whatever `preserveToolPairs` is set to.
- A no-op publishes nothing, so hidden messages survive it too.

#### `CompactionPreservePolicy`

| Field | Default | Keeps |
| --- | --- | --- |
| `pinned` | `true` | Messages with `metadata.pinned === true`. |
| `decisions` | `true` | Messages with `metadata.decision === true`. |
| `errors` | `true` | Tool results whose `outcome` is `'error'`, and messages with `metadata.error === true`. |

A hidden message is kept whether or not the policy matches it, so a hidden pinned, decision, or error message survives a commit.

#### `CompactionResult`

| Field | Type | Meaning |
| --- | --- | --- |
| `compacted` | `boolean` | `true` when a summary replaced eligible messages. From `compact()`, `true` only on `committed`. |
| `chunksProcessed` | `number` | Summarizer calls made. A `discarded` result still counts the chunks its dropped candidate summarized. |
| `messagesRemoved` | `number` | Messages the summary replaced, which is the number that left history. Kept messages, hidden or not, are not counted. From `compact()`, `0` unless `committed`. From `compactConversation()`, the candidate's own count, which is `0` only when nothing was eligible. |
| `summaryContent` | `string` | The summary text, with chunk summaries joined by `\n\n---\n\n`. The stored summary message holds exactly this text; message plugins do not run over it. From `compact()`, empty unless `committed`. From `compactConversation()`, the candidate's own summary, which is empty only when nothing was eligible. |

A committed history starts with one `system` message that has `metadata.compactionSummary: true`, followed by the kept messages in their original order. Kept messages are carried over, not rebuilt:

- Each kept message keeps its `id`, `createdAt`, content, metadata, `hidden`, tool call or tool result, `tokenUsage`, `cacheBoundary`, and assistant `goalCompleted`. Only `position` changes, because the messages now follow the summary.
- The conversation's message plugins do not run again over kept messages or over the summary message. The stored summary is exactly `summaryContent`.

#### `CompactionAttempt`

| Field | Type | Meaning |
| --- | --- | --- |
| `attemptId` | `string` | Identity of one `compact()` call, minted from the environment runtime's identifiers. |
| `baseRevision` | `number` | Controller revision of the snapshot the candidate is built from, captured synchronously when `compact()` is called. |
| `observedRevision` | `number` | Controller revision when this record was taken. It equals `baseRevision` on a commit and is the newer revision on a discard. |
| `durationMs` | `number` | Milliseconds since the attempt started, on the environment runtime's clock. Never negative. |
| `baseTokens` | `number` | Estimated tokens in the base snapshot, using the conversation's token estimator. |
| `candidateTokens` | `number \| undefined` | Estimated tokens in the candidate. Absent on `compaction.started`, `compaction.failed`, and `compaction.cancelled`. |

Both revisions are values of the conversation's own controller revision. An attempt never keeps a counter of its own.

#### `ConversationCompactionResult`

A `CompactionResult` plus these fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `outcome` | `'committed' \| 'no-op' \| 'discarded'` | How the attempt settled. |
| `revision` | `number` | Controller revision after the attempt settled: `baseRevision + 1` when committed, unchanged on a no-op, and the newer revision on a discard. |
| `attempt` | `CompactionAttempt` | The attempt record. It equals the record on the settling event. |
| `reason` | `'revision-conflict'` | Present only on `discarded`. |

- **`committed`**: `compacted: true`. The candidate was published by compare-and-swap against `attempt.baseRevision` as one new history node.
- **`no-op`**: `compacted: false`, `chunksProcessed: 0`, `messagesRemoved: 0`, and `summaryContent: ''`. Nothing was eligible and the revision had not moved. `attempt.candidateTokens` equals `attempt.baseTokens`.
- **`discarded`**: `compacted: false`, `messagesRemoved: 0`, and `summaryContent: ''`. The conversation moved past `attempt.baseRevision` before the compare-and-swap, so the candidate was dropped unpublished. The current history, revision, store snapshot, and history tree are left byte-for-byte unchanged. A no-op whose base revision went stale also resolves `discarded`.

A failed attempt rejects with the error that ended it. That is usually the summarizer's error, but not always. Checking the kept messages rejects with `error:invalid-tool-reference` when a kept tool result's call is not kept, which happens under `preserveToolPairs: false` when the call would be summarized. A hidden call is always kept. A thrown value that is not an `Error` is wrapped in one. A cancelled attempt rejects with `error:operation-cancelled`. Neither publishes anything.

### Events

| Event | Emitted when | `revision` | `outcome` | `reason` |
| --- | --- | --- | --- | --- |
| `compaction.started` | Inside the `compact()` call, before it returns | base revision | `started` | none |
| `compaction.completed` | The candidate committed, or the attempt was a no-op | base + 1 on commit, base on a no-op | `completed` | none |
| `compaction.stale-discarded` | The revision moved before the compare-and-swap | the newer revision | `discarded` | `revision-conflict` |
| `compaction.failed` | The attempt threw while the conversation was open and the attempt was not aborted | current revision | `failed` | the error, as a string |
| `compaction.cancelled` | The attempt's `signal` aborted while the conversation was open | current revision | `cancelled` | the abort reason, or the error the aborted summarizer threw, as a string |

A commit emits `change` (with `action: 'compaction.completed'`), then `push`, then `compaction.completed`. All three carry the new revision and the same `compaction` record. Their `messageIds` list every identifier the commit removed, which are the summarized messages and nothing else: kept messages, hidden or not, keep their identifiers. An attempt that publishes nothing emits no `change` or `push`. Closing or disposing the conversation mid-attempt emits no `compaction.cancelled`; the promise still rejects with `error:operation-cancelled`.

### Not provided

- **Stale-result rebasing.** A discarded candidate is never merged into newer history, and `compact()` never retries on its own. [Background compaction](#background-compaction) reschedules a fresh candidate under a bounded policy.
- **Durable-boundary gating in `compact()`.** A tool call that is still waiting for its result can be summarized away if it falls outside the recent window. Appending its result afterwards throws `error:invalid-tool-reference`, and `appendToolResultAsync()` rejects with it. An open streaming message is kept under its own identifier, so stream updates, finalize, and cancel keep acting on it. The background scheduler starts candidates only at a durable boundary.
- **Abort checks between chunks.** The library forwards `signal` to the summarizer and never checks it itself. Passing the signal through to your model call is what stops the work.
- **Serialized calls.** Overlapping `compact()` calls each run their own summarizer. The first to finish commits, and the rest resolve `discarded`.
- **Progress events.** There is no per-chunk progress event.
- **Preservation-policy changes.** The retention rules above behave as they did before revisioned commits.

## Background compaction

### Functions and constants

- `createCompactionScheduler(conversation, options)`
- `createIdleCompactionSchedule(options?)`
- `createTimerCompactionSchedule(options?)`
- `DEFAULT_MAX_STALE_RETRIES`

### Types

- `CompactionCancelReason`
- `CompactionRequestOptions`
- `CompactionScheduleAdapter`
- `CompactionScheduleCancel`
- `CompactionScheduler`
- `CompactionSchedulerCounts`
- `CompactionSchedulerOptions`
- `CompactionSchedulerOutcome`
- `CompactionSchedulerPhase`
- `CompactionSchedulerState`
- `IdleCallbackHost`
- `IdleCompactionScheduleOptions`
- `TimerCompactionScheduleOptions`

A `CompactionScheduler` prepares compaction candidates outside the caller's critical path. It publishes only by calling `Conversation.compact()`, so every candidate still commits through the revision compare-and-swap. The schedule adapter only decides when queued work runs. The default adapter uses a zero-delay timer, which is available on Bun, Node, and browsers. `createIdleCompactionSchedule()` uses `requestIdleCallback` with a starvation `timeout`, and falls back to a timer on hosts that do not have it.

- **Single flight**: overlapping requests join the job that is already queued or running. A new candidate waits for a cancelled one that is still running, so two summaries never run at the same time.
- **Stale policy**: when a newer write makes a candidate stale, the candidate is discarded and rescheduled in a new adapter window. This happens at most `maxStaleRetries` times per request (default `2`), after which the request settles `discarded`. Stale candidates are never rebased and never retried inline.
- **Durable boundaries**: a candidate starts only when no stream is open and no tool call is waiting for its result. Every streamed token moves the revision, so a candidate started mid-stream would be discarded as stale, and compacting mid-tool-execution could summarize away a call whose result has not arrived. A window that opens away from a boundary starts nothing. The request stays `pending` until a committed change reaches a boundary, then queues a new window. That wait spends no candidate and no stale retry, it is withdrawn like queued work, and `counts.deferred` records each window that waited.
- **Cancellation**: `cancel()`, `dispose()`, an aborted request `signal`, and closing or disposing the conversation all withdraw queued work and abort the running candidate. A summary that comes back after that point cannot publish. `cancel()` and `dispose()` resolve once the candidate that was running has settled.
- **Observation**: `scheduler.state` is a frozen `{ phase, disposed, candidate, attempt, counts }` snapshot, where `phase` is one of `idle`, `pending`, `running`, `committed`, `no-op`, `discarded`, `cancelled`, or `failed`. `subscribe(listener)` delivers every new state. Neither depends on conversation events. `request()` resolves a typed outcome and never rejects.

## Streaming

- `appendStreamingMessage`
- `appendUnsafeStreamingMessage`
- `cancelStreamingMessage`
- `finalizeStreamingMessage`
- `finalizeUnsafeStreamingMessage`
- `getStreamingMessage`
- `isStreamingMessage`
- `updateStreamingMessage`
- `updateUnsafeStreamingMessage`

### Streaming safety

Messages flagged as streaming (`isStreamingMessage` returns `true`) are automatically protected across the library:

- **Compaction**: compaction always keeps visible streaming messages, with their tool partners, so they are never summarized away. A commit keeps every streaming message, hidden or not, under its existing identifier. See [Compaction](#compaction).
- **Truncation**: `truncateToTokenLimit` locks streaming message blocks alongside system and protected blocks. `truncateFromPosition` preserves streaming messages that fall below the cutoff position.
- **Adapters**: All three provider adapters (OpenAI, Anthropic, Gemini) skip streaming messages during export so that incomplete content is never sent to an API. Once a streaming message is finalized via `finalizeStreamingMessage`, the streaming flag is removed and the message participates normally in all subsystems.
- **Late updates**: `updateStreamingMessage` writes only to a message that is still streaming. After `finalizeStreamingMessage` (or `cancelStreamingMessage`, which removes the message), it returns the conversation unchanged rather than appending to a message the UI has already presented as final, and it does not read `environment.now()` on that path. `Conversation.updateStreamingMessage` propagates the rejection: it skips the commit when the returned conversation is the one it passed in, so no history node is recorded and no event is emitted. `updateUnsafeStreamingMessage` skips the streaming-status check for render-side projections.

## Projection

- `createProjection`
- `isProjectionPrefixExtension`
- `Projection`
- `ProjectionEventIdentity`
- `ProjectionOptions`
- `ProjectionReducer`
- `ProjectionReducerContext`
- `ProjectionReducerResult`

Projection builders compare stable event identities to detect prefix extensions. Use durable event ids or sequence numbers, not array or object identity, so reactive proxies can pass fresh arrays safely.

## Conversation history

- `Conversation`
- `ConversationActionType`
- `ConversationEvent`
- `ConversationEventDetail`
- `ConversationEventMap`
- `ConversationEventType`

## Message helpers

- `createMessage`
- `isAssistantMessage`
- `messageHasImages`
- `messageParts`
- `messageText`
- `messageToJSON`
- `messageToString`

## Utilities

### Content helpers

- `normalizeContent`
- `toMultiModalArray`

### Message helpers

- `createMessage`
- `isAssistantMessage`
- `messageHasImages`
- `messageParts`
- `messageText`
- `messageToJSON`
- `messageToString`

### Tool pairing

- `pairToolCallsWithResults`
- `ToolCallPair`

### Transient metadata

- `isTransientKey`
- `stripTransientFromRecord`
- `stripTransientMetadata`

### General helpers

- `hasOwnProperty`
- `toReadonly`

## Testing helpers

- `ConversationRecorder`
- `createConversationRecorder`
- `createTestConversation`
- `createTestConversationEnvironment`
- `TestConversationEnvironment`
- `TestConversationEnvironmentOptions`

## Markdown

### Functions

- `conversationFromMarkdown`
- `conversationToMarkdown`
- `fromMarkdown`
- `getRoleFromLabel`
- `getRoleLabel`
- `toMarkdown`

### Constants and classes

- `LABEL_TO_ROLE`
- `MarkdownParseError`
- `ROLE_LABELS`

### Types

- `ToMarkdownOptions`

## Export helpers

- `exportMarkdown`
- `normalizeLineEndings`

## Schemas

- `conversationSchema`
- `conversationShape`
- `jsonValueSchema`
- `messageInputSchema`
- `messageRoleSchema`
- `messageSchema`
- `multiModalContentSchema`
- `tokenUsageSchema`
- `toolActionSchema`
- `toolCallInputSchema`
- `toolCallSchema`
- `toolErrorCategorySchema`
- `toolErrorSchema`
- `toolResultSchema`

## OpenAI adapter

### Functions

- `appendOpenAIMessages`
- `fromOpenAIMessages`
- `toOpenAIMessages`
- `toOpenAIMessagesGrouped`

### Adapter object

- `openAIConversationAdapter`

### Types

- `OpenAIAssistantMessage`
- `OpenAIContentPart`
- `OpenAIConversationExportOptions`
- `OpenAIImageContentPart`
- `OpenAIMessage`
- `OpenAISystemMessage`
- `OpenAITextContentPart`
- `OpenAIToolCall`
- `OpenAIToolMessage`
- `OpenAIUserMessage`

## Anthropic adapter

### Functions

- `appendAnthropicMessages`
- `fromAnthropicMessages`
- `toAnthropicMessages`

### Adapter object

- `anthropicConversationAdapter`

### Types

- `AnthropicBase64ImageSource`
- `AnthropicContentBlock`
- `AnthropicConversation`
- `AnthropicImageBlock`
- `AnthropicImageSource`
- `AnthropicMessage`
- `AnthropicTextBlock`
- `AnthropicToolResultBlock`
- `AnthropicToolUseBlock`
- `AnthropicUrlImageSource`

## Gemini adapter

### Functions

- `appendGeminiMessages`
- `fromGeminiMessages`
- `toGeminiMessages`

### Adapter object

- `geminiConversationAdapter`

### Types

- `GeminiContent`
- `GeminiConversation`
- `GeminiFileDataPart`
- `GeminiFunctionCallPart`
- `GeminiFunctionResponsePart`
- `GeminiInlineDataPart`
- `GeminiPart`
- `GeminiTextPart`

## PII redaction

- `createPIIRedaction`
- `createPIIRedactionPlugin`
- `DEFAULT_PII_RULES`
- `redactPii`

## Versioning

- `CURRENT_SCHEMA_VERSION`

## Deterministic sorting

- `sortMessagesByPosition`
- `sortObjectKeys`

## Supporting root types

These are exported from `conversationalist`:

- `ConversationProvider`
- `ExportOptions`
- `MessagePlugin`
- `TokenEstimator`
- `ChatMessage`
- `ChatMessageRole`
- `ImageContent`
- `MultiModalContent`
- `TextContent`
