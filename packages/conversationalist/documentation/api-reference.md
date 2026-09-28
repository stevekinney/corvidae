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
- `CompactionOptions`
- `CompactionResult`
- `Summarizer`
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
- `branchCount`
- `branchIndex`
- `redoCount`
- `getSnapshot()`

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

- **Compaction**: `partitionMessages` adds streaming messages to the preserved set so they are never summarized away.
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
