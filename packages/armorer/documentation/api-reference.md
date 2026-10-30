# Armorer Public API Reference

Armorer is a private workspace library. Import its supported runtime, type, adapter, registry, and test utilities from `armorer`. The [package manifest](../package.json) also exposes three subpaths that keep optional or platform-specific dependencies out of the root: `armorer/protocol` (the dependency-free tool protocol), `armorer/open-ai/agents` (the OpenAI Agents SDK integration, which loads `@openai/agents`), and `armorer/coding` (the Bun-only coding tools). Every capability group below comes from the root unless its section names a subpath.

```typescript
import { createTool, createToolbox, createRegistry, defineTool } from 'armorer';
```

## Runtime API

### Functions

- `combineToolboxes`: merge multiple toolboxes into one.
- `createMiddleware`: type-preserving helper for middleware creation.
- `createTool`: create an executable tool from a configuration object.
- `createToolCall`: create a canonical tool call object with validated arguments.
- `createToolbox`: create a toolbox instance or rehydrate one from serialized/imported definitions.
- `isTool`: runtime type guard for tools.
- `isToolbox`: runtime type guard for toolboxes.
- `lazy`: memoized lazy loader for deferred execute functions.
- `materializeToolCall`: normalize one `ToolCallInput` into a JSON-safe `ToolCall`.
- `materializeToolCalls`: normalize multiple tool calls.
- `materializeToolResult`: normalize one non-streaming `ToolResultInput`.
- `materializeToolResultAsync`: normalize one tool result, collecting stream payloads when needed.
- `materializeToolResults`: normalize multiple non-streaming tool results.
- `materializeToolResultsAsync`: normalize multiple tool results, collecting streams when needed.
- `readToolShortDescription`: read a tool's `metadata.shortDescription`, the one line a screen shows in place of its model-facing `description`, or `undefined` when it declares none.
- `renderToolSummary`: write a tool's `metadata.summary` template for one call, such as `Refund order order-1001 for $42.00`.
- `withContext`: bind extra runtime context into a tool factory.

### Types

- `CreateToolOptions`
- `DefaultToolEvents`
- `ImportedToolConfiguration`
- `ImportedToolboxOptions`
- `JSONValue`
- `MinimalAbortSignal`
- `MinimalToolConfiguration`
- `ObservableLike`
- `Observer`
- `SerializedToolbox`
- `SerializedToolboxJSONSchema`
- `Subscription`
- `Tool`
- `ToolAction`
- `ToolActionInput`
- `ToolCall`
- `ToolCallInput`
- `ToolCallWithArguments`
- `ToolConfiguration`
- `ToolContext`
- `ToolCustomEvent`
- `ToolDiagnostics`
- `ToolDiagnosticsAdapter`
- `ToolDigestOptions`
- `ToolError`
- `ToolErrorCategory`
- `ToolErrorInput`
- `ToolEventsMap`
- `ToolExecuteOptions`
- `ToolExecuteWithOptions`
- `ToolExecutionResult`
- `ToolMetadata`
- `ToolMiddleware`
- `ToolParametersSchema`
- `ToolPolicyAfterContext`
- `ToolPolicyContext`
- `ToolPolicyContextProvider`
- `ToolPolicyDecision`
- `ToolPolicyHooks`
- `ToolProvider`
- `ToolRepairHint`
- `ToolResolution`
- `ToolResolutionFailureReason`
- `ToolResult`
- `ToolResultInput`
- `ToolResultLike`
- `ToolStatusUpdate`
- `ToolValidationReport`
- `ToolValidationWarning`
- `Toolbox`
- `ToolboxCallInputForTools`
- `ToolboxContext`
- `ToolboxEntries`
- `ToolboxEntry`
- `ToolboxEvents`
- `ToolboxOptions`
- `ToolboxRuntimeContext`
- `ToolsFromEntries`
- `WithContext`

### Runtime conveniences on `createToolbox`

- `createToolbox.fromProvider(provider, definitions, options?)`
- `createToolbox.fromOpenAITools(definitions, options?)`
- `createToolbox.fromAnthropicTools(definitions, options?)`
- `createToolbox.fromGeminiTools(definitions, options?)`

### Runtime conveniences on `Toolbox`

- `toolbox.toProvider(provider, options?)`
- `toolbox.toOpenAITools()`
- `toolbox.toAnthropicTools()`
- `toolbox.toGeminiTools()`
- `toolbox.getAvailable()`
- `toolbox.getTool(nameOrId)`: the tool a reference names, or `undefined` when it names none or several.
- `toolbox.resolveTool(idOrName)`: the one tool a reference names, or `{ ok: false, reason: 'missing' | 'ambiguous' | 'version-mismatch', candidates }`.
- `toolbox.asExecuteResolver()`

## Core primitives

### Context types

- `AbortSignalLike`
- `Logger`
- `Span`
- `Tracer`
- `CoreToolContext`
- `ToolTenant`
- `ToolUser`

### Errors

- `ToolError`
- `ToolErrorCategory`
- `isToolError`

### Availability

- `ToolAvailabilityContext`
- `ToolAvailabilityHook`

### Identity

- `ToolId`
- `ToolIdentity`
- `ToolIdentityInput`
- `formatToolId`
- `normalizeIdentity`
- `parseToolId`

### Inspection

- `InspectorDetailLevel`
- `MetadataFlags`
- `MetadataFlagsSchema`
- `RegistryInspection`
- `RegistryInspectionSchema`
- `SchemaSummary`
- `SchemaSummarySchema`
- `ToolInspection`
- `ToolInspectionSchema`
- `extractMetadataFlags`
- `extractSchemaSummary`
- `inspectRegistry`
- `inspectTool`

### Query predicates

- `NormalizedTextQuery`
- `TextMatchScore`
- `TextQuery`
- `TextQueryField`
- `TextQueryMode`
- `TextQueryWeights`
- `TextSearchIndex`
- `ToolPredicate`
- `buildTextSearchIndex`
- `internalQueryPredicateTestUtilities`
- `normalizeTextQuery`
- `schemaHasKeys`
- `schemaMatches`
- `scoreTextMatch`
- `scoreTextMatchFromIndex`
- `scoreTextMatchValueFromIndex`
- `tagsMatchAll`
- `tagsMatchAny`
- `tagsMatchNone`
- `textMatches`

### Registry and search

`buildNameCandidates` produces normalized and final-segment candidates for fuzzy tool resolution. `buildRegistryNameCandidates` preserves the registry's character-suffix candidates. `resolveFuzzyToolName` returns `ResolutionResult`; `resolveName` returns `RegistryResolutionResult`, whose unresolved result still carries a resolution tier.

- `Embedder`
- `EmbeddingMatch`
- `EmbeddingVector`
- `MetadataFilter`
- `MetadataPrimitive`
- `MetadataRange`
- `QueryEvent`
- `QueryResult`
- `QuerySelectionResult`
- `RegisterOptions`
- `RegistryOptions`
- `ResolveOptions`
- `RiskFilter`
- `SchemaFilter`
- `SearchEvent`
- `TagFilter`
- `ToolMatch`
- `ToolMatchDetails`
- `ToolQuery`
- `ToolQueryCriteria`
- `ToolQueryInput`
- `ToolQueryOptions`
- `ToolQuerySelect`
- `ToolRankContext`
- `ToolRankResult`
- `ToolRanker`
- `ToolRegistry`
- `ToolRegistryLike`
- `ToolSearchOptions`
- `ToolSearchRank`
- `ToolSearchRanker`
- `ToolSummary`
- `ToolTieBreaker`
- `VersionSelector`
- `createRegistry`
- `internalRegistryTestUtilities`
- `queryTools`
- `registerToolIndexes`
- `reindexSearchIndex`
- `searchTools`
- `unregisterToolIndexes`

### Risk

- `ToolRisk`

### Schema utilities

- `ToolSchema`
- `getSchemaKeys`
- `getSchemaShape`
- `isZodObjectSchema`
- `isZodSchema`
- `schemasLooselyMatch`
- `unwrapSchema`

### Serialization

- `JsonArray`
- `JsonObject`
- `JsonPrimitive`
- `JsonSchema`
- `JsonValue`
- `SerializedToolDefinition`
- `assertJsonValue`
- `serializeRegistry`
- `serializeToolDefinition`
- `sortJsonValue`
- `stableStringifyJson`

### Tag utilities

- `EnforceKebabCaseArray`
- `KebabCaseString`
- `NormalizeTagsOption`
- `assertKebabCaseTag`
- `normalizeTags`
- `uniqTags`

### Tool definitions

- `AnyToolDefinition`
- `DefineToolOptions`
- `ToolDefinition`
- `ToolDisplay`
- `ToolLifecycle`
- `defineTool`

## Query and search

### Functions

- `queryTools`
- `reindexSearchIndex`
- `schemaHasKeys`
- `schemaMatches`
- `tagsMatchAll`
- `tagsMatchAny`
- `tagsMatchNone`
- `textMatches`

### Types

- `Embedder`
- `EmbeddingVector`
- `MetadataFilter`
- `MetadataPrimitive`
- `MetadataRange`
- `NormalizedTextQuery`
- `QueryEvent`
- `QueryResult`
- `QuerySelectionResult`
- `RiskFilter`
- `SchemaFilter`
- `TagFilter`
- `TextMatchScore`
- `TextQuery`
- `TextQueryField`
- `TextQueryMode`
- `TextQueryWeights`
- `TextSearchIndex`
- `ToolPredicate`
- `ToolQuery`
- `ToolQueryCriteria`
- `ToolQueryInput`
- `ToolQueryOptions`
- `ToolQuerySelect`
- `ToolSummary`

## Inspection

- `extractMetadataFlags`
- `extractSchemaSummary`
- `inspectRegistry`
- `inspectTool`
- `MetadataFlags`
- `MetadataFlagsSchema`
- `RegistryInspection`
- `RegistryInspectionSchema`
- `SchemaSummary`
- `SchemaSummarySchema`
- `ToolInspection`
- `ToolInspectionSchema`

## Composition utilities

### Functions

- `bind`
- `materializeToolCall`
- `materializeToolCalls`
- `materializeToolResult`
- `materializeToolResultAsync`
- `materializeToolResults`
- `materializeToolResultsAsync`
- `parallel`
- `pipe`
- `postprocess`
- `preprocess`
- `retry`
- `tap`
- `when`

### Types

- `AnyTool`
- `ComposedTool`
- `ComposedToolEvents`
- `InferToolInput`
- `InferToolOutput`
- `PipelineError`
- `ToolWithInput`

## Lazy execution

- `lazy`

## Registry operations

Registry operations are available from the same root entry:

- `createRegistry`
- `queryTools`
- `searchTools`
- `reindexSearchIndex`
- `registerToolIndexes`
- `unregisterToolIndexes`
- all registry/search types listed under Core primitives above

## Model Context Protocol

Import MCP integration helpers from `armorer`.

### Functions

- `createMCP`
- `fromMcpEndpointTools`
- `fromMcpTools`
- `toMcpTools`
- `toolConfigurationFromMetadata`

### Classes and constants

- `MCPInputRequiredUnsupportedError`
- `MCPTaskClientError`
- `MCPTaskRecordVersionError`
- `MCP_TASKS_EXTENSION`
- `MCP_TASK_KEY_PREFIX`
- `MCP_TASK_RECORD_VERSION`
- `DEFAULT_MCP_TASK_TTL_MS`
- `DEFAULT_MCP_TASK_POLL_INTERVAL_MS`

### Types

- `CreateMCPOptions`
- `FromMcpEndpointToolsOptions`
- `FromMCPToolsOptions`
- `MCPCreateTaskResult`
- `MCPTaskError`
- `MCPTaskOptions`
- `MCPTaskRecord`
- `MCPTaskStatus`
- `MCPTaskStore`
- `MCPTaskStoreCondition`
- `MCPTaskStoreOperation`
- `MCPPromptRegistrar`
- `MCPResourceRegistrar`
- `MCPToolConfiguration`
- `MCPToolDefinition`
- `MCPToolHandler`
- `MCPToolLike`
- `MCPToolSource`
- `ToMCPToolsOptions`

## OpenAI adapters

### Functions

- `createNameMapper`
- `createProviderToolNameMapper`
- `formatOpenAIToolResults`
- `formatOpenAIToolResultsAsync`
- `fromOpenAITools`
- `mapToOpenAIName`
- `parseOpenAIToolCalls`
- `PROVIDER_TOOL_NAME_LIMIT`
- `toOpenAITools`
- `toProviderToolName`

### Types

- `JSONSchema`
- `OpenAIAdapterOptions`
- `OpenAIFunction`
- `OpenAITool`
- `OpenAIToolCall`
- `OpenAIToolMessage`

### Adapter object

- `openAIToolAdapter`

## Anthropic adapters

### Functions

- `formatAnthropicToolResults`
- `formatAnthropicToolResultsAsync`
- `fromAnthropicTools`
- `parseAnthropicToolCalls`
- `toAnthropicTools`

### Types

- `AnthropicAdapterOptions`
- `AnthropicContentBlock`
- `AnthropicInputSchema`
- `AnthropicTextBlock`
- `AnthropicTool`
- `AnthropicToolResultBlock`
- `AnthropicToolUseBlock`
- `JSONSchemaProperty`

### Adapter object

- `anthropicToolAdapter`

## Gemini adapters

### Functions

- `formatGeminiToolResults`
- `formatGeminiToolResultsAsync`
- `fromGeminiTools`
- `parseGeminiToolCalls`
- `toGeminiTools`

### Types

- `GeminiAdapterOptions`
- `GeminiFileDataPart`
- `GeminiFormatToolResultsOptions`
- `GeminiFunctionCallPart`
- `GeminiFunctionDeclaration`
- `GeminiFunctionResponsePart`
- `GeminiInlineDataPart`
- `GeminiPart`
- `GeminiSchema`
- `GeminiTextPart`
- `GeminiTool`

### Adapter object

- `geminiToolAdapter`

## OpenAI Agents integration

Import these from `armorer/open-ai/agents`.

### Functions

- `createOpenAIToolGate`
- `toOpenAIAgentTools`

### Types

- `OpenAIAgentTool`
- `OpenAIAgentToolConfiguration`
- `OpenAIAgentToolOptions`
- `OpenAIAgentToolsResult`
- `OpenAIToolGateDecision`
- `OpenAIToolGateOptions`

### Test seam

- `internalOpenAIAgentsTestUtilities`

## Coding tools

Import these from `armorer/coding`. They use Bun APIs, so they stay out of the browser-facing root.

### Functions

- `createCodingToolbox`
- `createCodingTools`
- `createGlobTool`
- `createGrepTool`
- `createReadFileTool`
- `createRootJail`
- `isPathTraversalError`

### Constants

- `DEFAULT_GLOB_MAX_RESULTS`
- `DEFAULT_GREP_MAX_FILE_BYTES`
- `DEFAULT_GREP_MAX_MATCHES`
- `DEFAULT_READ_FILE_MAX_BYTES`
- `DEFAULT_READ_FILE_MAX_LINES`

### Errors

- `PathTraversalError`

### Types

- `CodingTools`
- `CreateCodingToolsOptions`
- `CreateGlobToolOptions`
- `CreateGrepToolOptions`
- `CreateReadFileToolOptions`
- `GlobResult`
- `GrepMatch`
- `GrepResult`
- `ReadFileResult`
- `ReadFileTruncatedReason`
- `RootJail`

## Prebuilt tools

### Functions

- `createSearchTool`

### Types

- `CreateSearchToolOptions`
- `SearchTool`
- `SearchToolsInput`
- `SearchToolsResult`

## Instrumentation

- `instrument`
- `InstrumentationOptions`

## Middleware

- `createCacheMiddleware`
- `createRateLimitMiddleware`
- `createTimeoutMiddleware`
- `createTruncationMiddleware`: also wraps async iterable `stream`/`result` fields with character-limited iteration
- `ToolResultTruncationOptions`

## Result truncation

- `truncateToolResultContent`
- `truncateText`
- `safeSlice`
- `createTruncatingAsyncIterable`: wraps an `AsyncIterable`, yielding chunks until the character limit is reached then emitting a truncation marker
- `containsBase64Data`
- `stripBase64Data`
- `isHighSurrogate`
- `isLowSurrogate`
- `DEFAULT_MAX_CHARACTERS`
- `DEFAULT_ERROR_MAX_CHARACTERS`
- `TruncationOptions`
- `ToolResultTruncationOptions`

## Test utilities

### Functions

- `createMockTool`
- `createTestRegistry`
- `createTestToolbox`
- `createToolboxRecorder`

### Types

- `MockToolOptions`
- `TestRegistry`
- `ToolboxRecorder`

## Public but intentionally low-level test seams

These root exports support focused internal verification:

- `internalToolTestUtilities`
- `internalOpenAIAgentsTestUtilities`
- `internalQueryPredicateTestUtilities`
- `internalRegistryTestUtilities`
