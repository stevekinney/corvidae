# Toolbox Registry

## Overview

Register tools, execute tool calls, and query the registry.

For a dedicated guide to tool and registry event streams, see [Eventing](eventing.md). For a dedicated guide to `queryTools`, see [Searching Tools](searching-tools.md).

### Registration

```typescript
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

const echo = createTool({
  name: 'echo',
  description: 'Echo a value',
  input: z.object({ value: z.string() }),
  async execute({ value }) {
    return value;
  },
});

const reverse = createTool({
  name: 'reverse',
  description: 'Reverse a value',
  input: z.object({ value: z.string() }),
  async execute({ value }) {
    return [...value].reverse().join('');
  },
});

// Register tools when the toolbox is created
const toolbox = createToolbox([echo, reverse]);

// Or initialize with tool configurations
const fromConfigurations = createToolbox([echo.configuration, reverse.configuration]);

// Toolboxes are immutable: extend() returns a new toolbox with the extra tools
const shout = createTool({
  name: 'shout',
  description: 'Upper-case a value',
  input: z.object({ value: z.string() }),
  async execute({ value }) {
    return value.toUpperCase();
  },
});
const extended = toolbox.extend(shout);
```

Tool configurations also support lazy execute functions (import from `armorer`). Put the heavy implementation in its own module:

```typescript file=lazy-configuration.ts
import { z } from 'zod';

// A plain configuration's execute receives its arguments as `unknown`, so the
// module narrows them itself.
const input = z.object({ id: z.string() });

export async function execute(params: unknown): Promise<string> {
  const { id } = input.parse(params);
  return `loaded ${id}`;
}
```

Then load it on first use:

```typescript
import { createToolbox, lazy } from 'armorer';
import { z } from 'zod';

const toolbox = createToolbox([
  {
    name: 'lazy-configuration',
    description: 'Loads on first use',
    input: z.object({ id: z.string() }),
    execute: lazy(async () => (await import('./lazy-configuration.ts')).execute),
  },
]);
```

Tool configurations and `createTool()` are consistent: if `input` is omitted, Toolbox defaults it to `z.object({})` for no-params tools.

### Availability

Add `availability` to a tool when it depends on a platform or runtime capability:

```typescript
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

declare function readKeychain(service: string): Promise<string>;

const macosTool = createTool({
  name: 'read-keychain',
  description: 'Read a macOS Keychain item',
  input: z.object({ service: z.string() }),
  availability(context) {
    return context['platform'] === 'darwin';
  },
  async execute({ service }) {
    return readKeychain(service);
  },
});

const toolbox = createToolbox([macosTool], {
  context: { platform: process.platform },
});
```

`await toolbox.getAvailable()` returns only currently runnable tools. The toolbox provider exporters use that same filter, so unavailable tools are not shown to the model. If a caller executes an unavailable tool anyway, the toolbox returns a structured `ToolError` with category `unavailable` and code `TOOL_UNAVAILABLE`.

Availability is for platform and runtime capability checks. Do not use it to hide a keyless tool when an optional API key only increases limits or quota; keep that tool available and handle the configured versus unconfigured behavior inside the implementation.

### Execution

```typescript
import type { AnyToolbox, ToolCallInput } from 'armorer';

declare const toolbox: AnyToolbox;
declare const calls: ToolCallInput[];

// Execute a single tool call
const result = await toolbox.execute({
  id: 'call-id',
  name: 'tool-name',
  arguments: { key: 'value' },
});

// Execute multiple tool calls in parallel
const results = await toolbox.execute([
  { id: 'call-1', name: 'tool-a', arguments: { x: 1 } },
  { id: 'call-2', name: 'tool-b', arguments: { y: 2 } },
]);
// Returns: ToolResult[] - array of results in the same order as input calls

// Execute with AbortSignal support
const controller = new AbortController();
const abortable = await toolbox.execute(calls, { signal: controller.signal });

// Streaming mode: preserve async-iterable tool output
const streamed = await toolbox.execute(
  { id: 'stream-1', name: 'token-tool', arguments: {} },
  { stream: true },
);
for await (const chunk of streamed.stream!) {
  console.log('chunk', chunk);
}
```

When executing multiple tool calls, they are executed in parallel using `Promise.all()`. The return value is an array of `ToolResult` objects in the same order as the input calls. You can listen to events from individual tools using `toolbox.addEventListener`:

```typescript
import type { AnyToolbox } from 'armorer';

declare const toolbox: AnyToolbox;

// Listen for progress events from any tool during parallel execution
toolbox.addEventListener('progress', (event) => {
  console.log(`Tool ${event.tool.identity.name}: ${event.percent}%`);
});

// Listen for execution events
toolbox.addEventListener('execute-start', (event) => {
  console.log(`Starting: ${event.tool.identity.name}`);
});

toolbox.addEventListener('execute-success', (event) => {
  console.log(`Completed: ${event.tool.identity.name}`, event.result);
});
```

### Instrumentation (OpenTelemetry)

Toolbox provides native OpenTelemetry instrumentation via the `armorer` module.

```typescript
import { createToolbox } from 'armorer';
import { instrument } from 'armorer';
import { context, trace } from '@opentelemetry/api';

const toolbox = createToolbox();
const unregister = instrument(toolbox);
const tracer = trace.getTracer('worker');

// All subsequent calls via toolbox.execute() will create OpenTelemetry spans
await tracer.startActiveSpan('temporal.activity', async (activitySpan) => {
  await toolbox.execute(
    { id: 'lookup-account', name: 'lookupAccount', arguments: { accountId: 'acct_123' } },
    {
      parentContext: trace.setSpan(context.active(), activitySpan),
      spanLinks: [{ context: activitySpan.spanContext() }],
    },
  );
});
```

### Middleware

Toolbox supports middleware to wrap tool execution logic. This is useful for cross-cutting concerns like caching, rate limiting, and timeouts.

```typescript
import { createToolbox } from 'armorer';
import { createCacheMiddleware, createRateLimitMiddleware } from 'armorer';

const toolbox = createToolbox([], {
  middleware: [
    // Cache results for 1 minute
    createCacheMiddleware({ ttlMs: 60000 }),
    // Limit to 10 calls per minute per tool
    createRateLimitMiddleware({ limit: 10, windowMs: 60000 }),
  ],
});
```

Available middleware in `armorer`:

- `createCacheMiddleware(options)`
- `createRateLimitMiddleware(options)`
- `createTimeoutMiddleware(ms)`

### Testing

Testing agentic systems is easier with mock tools and test registries from `armorer`.

```typescript
import { createMockTool, createTestRegistry } from 'armorer';

// Create a mock tool with canned responses
const weatherMock = createMockTool({ name: 'get_weather' });
weatherMock.mockResolve({ temp: 72 });

const toolbox = createTestRegistry([weatherMock]);

// Execute your agent logic using the test registry
// ...

// Assert on execution history
console.log(toolbox.history[0]?.call.name); // 'get_weather'
console.log(weatherMock.calls.length); // 1
```

### Querying Tools

```typescript
import { createTool, createToolbox, queryTools } from 'armorer';
import { z } from 'zod';

const toolbox = createToolbox([
  createTool({
    name: 'get-weather',
    description: 'Get current weather for a city',
    input: z.object({ city: z.string() }),
    tags: ['weather', 'api'],
    metadata: { tier: 'premium', capabilities: ['read'], score: 7, owner: 'team-weather' },
    async execute({ city }) {
      return { city, temperature: 72 };
    },
  }),
]);

// Query by tag (OR match)
const mathTools = queryTools(toolbox, { tags: { any: ['math'] } });

// Require all tags (AND match)
const fastMath = queryTools(toolbox, { tags: { all: ['math', 'fast'] } });

// Exclude tags
const safeTools = queryTools(toolbox, { tags: { none: ['destructive', 'dangerous'] } });

// Query by text (name, description, tags, schema keys, metadata keys)
const weatherTools = queryTools(toolbox, { text: 'weather' });

// Fuzzy text with field scoping
const fuzzy = queryTools(toolbox, {
  text: {
    query: 'weathr',
    mode: 'fuzzy',
    threshold: 0.7,
    fields: ['name', 'description'],
  },
});

// Query by schema keys or shape
const toolsByKeys = queryTools(toolbox, { schema: { keys: ['city'] } });
const toolsByShape = queryTools(toolbox, {
  schema: { matches: z.object({ city: z.string() }) },
});

// Query by metadata
const premiumTools = queryTools(toolbox, { metadata: { eq: { tier: 'premium' } } });
const keyedTools = queryTools(toolbox, { metadata: { has: ['capabilities'] } });
const ranged = queryTools(toolbox, { metadata: { range: { score: { min: 5 } } } });
const owned = queryTools(toolbox, { metadata: { contains: { owner: 'team-' } } });

// Custom predicate
const apiTools = queryTools(toolbox, { predicate: (tool) => tool.tags?.includes('api') ?? false });

// Boolean groups + pagination + selection
const summaries = queryTools(toolbox, {
  or: [{ tags: { any: ['fast'] } }, { text: 'priority' }],
  not: { tags: { any: ['deprecated'] } },
  select: 'summary',
  limit: 10,
  offset: 10,
});
```

#### Query Details

`queryTools(input, criteria?)` filters tools with AND semantics across the provided criteria. It accepts a toolbox registry, a single tool, an array of tools, or any iterable of tools. The `criteria` object is optional; if omitted, all tools are returned.

Core criteria:

- `tags`: `{ any?: string[]; all?: string[]; none?: string[] }` (case-insensitive)
- `text`: `string | { query: string; mode?: 'contains' | 'exact' | 'fuzzy'; fields?: TextQueryField[]; threshold?: number; weights?: Partial<Record<TextQueryField, number>> }`
- `schema`: `{ keys?: string[]; matches?: ToolParametersSchema }`
- `metadata`: `{ has?: string[]; eq?: Record<string, unknown>; contains?: Record<string, string | string[] | number | boolean | null>; startsWith?: Record<string, string>; range?: Record<string, { min?: number; max?: number }>; predicate?: (metadata) => boolean }`
- `predicate`: `(tool) => boolean` for custom filtering

Boolean groups:

- `and`: nested criteria that must all match
- `or`: nested criteria where at least one must match
- `not`: criteria or list of criteria to exclude

Selection and paging:

- `select`: `'tool' | 'name' | 'configuration' | 'summary'` (default: `tool`)
- `limit` / `offset`: pagination controls
- `includeSchema` / `includeToolConfiguration`: when `select: 'summary'`, include schema/configuration

Text query fields (`TextQueryField`) are `name`, `description`, `tags`, `schemaKeys`, and `metadataKeys`. Text queries are tokenized (camelCase, snake_case, and diacritics are normalized) and scores scale with the number of matched tokens. Fuzzy matching uses `threshold` (default `0.7`) to determine a match score.

If the registry was created with `embed`, text queries also use embeddings for semantic matches. Lexical matches still apply, so embeddings only broaden recall rather than replacing the existing behavior.

Embedding matches use cosine similarity over the returned vectors. Queries only consult embeddings when lexical matching fails, and `threshold` applies to the similarity score. You can also disable specific fields by setting their `text.weights` to `0`.

#### Embeddings

Provide an embedder to `createToolbox` to enrich text queries with semantic matching. The registry batches searchable fields for each tool (name, description, tags, schema keys, metadata keys) and stores vectors on registration.

The embedder is called with a list of texts and must return a same-length list of numeric vectors; mismatched or invalid vectors are ignored. Embeddings are cached per tool and can be recomputed with `reindexSearchIndex`.

```typescript file=embedded-toolbox.ts
import { createToolbox } from 'armorer';

declare const embeddingsClient: { embed(texts: string[]): Promise<number[][]> };

export const toolbox = createToolbox([], {
  embed: async (texts) => embeddingsClient.embed(texts),
});
```

```typescript
import { reindexSearchIndex } from 'armorer';
import { toolbox } from './embedded-toolbox.ts';

reindexSearchIndex(toolbox);
```

If the embedder is asynchronous, the first query may fall back to lexical matching until vectors are available; subsequent calls will use embeddings automatically.

For detailed examples including OpenAI and Pinecone integration, see the [Embeddings & Semantic Search](embeddings.md) documentation.

#### Type Guards

You can use `isToolbox()` to check if an object is a Toolbox registry:

```typescript
import { isToolbox, createToolbox } from 'armorer';

const registry = createToolbox();
if (isToolbox(registry)) {
  // TypeScript knows registry is Toolbox here
  const tools = registry.tools();
  const inspection = registry.inspect();
}
```

This is useful when working with functions that accept multiple types and you need to determine the type at runtime.

#### Middleware

You can transform tool configurations during registration using middleware. Middleware functions receive a tool configuration and return a (possibly modified) configuration. Middleware is applied in order before the tool is built.

```typescript
import { createTool, createToolbox, createMiddleware } from 'armorer';
import { z } from 'zod';

// Create middleware to add metadata
const addSourceMetadata = createMiddleware((configuration) => ({
  ...configuration,
  metadata: { ...configuration.metadata, source: 'middleware' },
}));

// Create middleware to validate configurations
const validateConfiguration = createMiddleware((configuration) => {
  if (!configuration.name || configuration.name.length < 3) {
    throw new Error('Tool name must be at least 3 characters');
  }
  return configuration;
});

const myTool = createTool({
  name: 'my-tool',
  description: 'An example tool',
  input: z.object({}),
  async execute() {
    return 'ok';
  },
});

// All registered tools will have the middleware applied
const toolbox = createToolbox([myTool], {
  middleware: [validateConfiguration, addSourceMetadata],
});
```

Common middleware patterns:

- **Validation**: Enforce naming conventions, required metadata, or schema constraints
- **Enrichment**: Add default metadata like timestamps, source identifiers, or tags
- **Transformation**: Rename tools, modify schemas, or wrap execute functions
- **Logging**: Track tool registration for observability

Middleware must be synchronous when deserializing from `SerializedToolbox`. The middleware receives the full `ToolConfiguration` including the execute function.

#### getTool() for Deserialization

When deserializing a toolbox (loading from JSON), tool configurations may not have execute functions. Use `getTool()` to provide execute functions dynamically. The resolver can be synchronous or async (for lazy imports).

```typescript
import { createToolbox, type SerializedToolbox } from 'armorer';

declare const serializedConfigurations: SerializedToolbox;

const toolbox = createToolbox(serializedConfigurations, {
  getTool: async (configuration) => {
    // Resolve execute lazily by tool name.
    const mod = await import(`./tools/${configuration.name}.js`);
    return mod.execute;
  },
});
```

If `getTool()` cannot resolve a function (or resolves to a non-function), executing that tool returns an error with the tool name and resolver hint.

#### Pre-computed Embeddings

`registerToolEmbeddings(tool, vectors)` attaches vectors you computed offline (for example, in a build step) to a tool. The keys are text query fields (`name`, `description`, `tags`, `schemaKeys`, `metadataKeys`); other keys and non-numeric vectors are ignored.

```typescript
import { createTool, registerToolEmbeddings } from 'armorer';
import { z } from 'zod';

const tool = createTool({
  name: 'pre-embedded-tool',
  description: 'A tool with pre-computed embeddings',
  input: z.object({ input: z.string() }),
  async execute({ input }) {
    return input.toUpperCase();
  },
});

registerToolEmbeddings(tool, {
  name: [0.1, 0.2, 0.3],
  description: [0.3, 0.4, 0.5],
});
```

The toolbox does not read embeddings from tool metadata. Vectors attach to the tool instance you pass: a toolbox builds its own tool from each entry (`toolbox.getTool(name)` returns it), and a toolbox created with `embed` computes and stores vectors for every tool it registers, replacing any registered earlier. Query text is always embedded with the toolbox's `embed`, so pre-computed vectors must come from the same model.

### Registry Events

For complete eventing patterns (including observables and async iterators), see [Eventing](eventing.md).

```typescript
import type { AnyToolbox } from 'armorer';

declare const toolbox: AnyToolbox;

toolbox.addEventListener('call', (event) => {
  console.log('Calling:', event.call.name);
});

toolbox.addEventListener('complete', (event) => {
  console.log('Completed:', event.result);
});

toolbox.addEventListener('error', (event) => {
  console.error('Error:', event.result.error);
});

toolbox.addEventListener('search', (event) => {
  console.log('Search results:', event.results);
});

toolbox.addEventListener('status:update', (event) => {
  console.log(`${event.name}: ${event.status}`);
});
```

### Context Injection

Pass shared context to all registered tools:

For a complete guide to context sources and `withContext`, see [Context and withContext](context.md).

```typescript
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

const contextAware = createTool({
  name: 'context-aware',
  description: 'A tool that uses context',
  input: z.object({}),
  async execute(_params, context) {
    // Toolbox context values are merged into the tool context at execution time
    const { userId } = context as typeof context & { userId: string };
    console.log('User:', userId);
    return 'ok';
  },
});

const toolbox = createToolbox([contextAware], {
  context: {
    userId: 'user-123',
    sessionId: 'session-456',
  },
});
```

### Inspection

`toolbox.inspect()` returns a snapshot of the registry for logging, diagnostics, or UI inventory screens. It reports counts plus a list of tool inspections. Detail levels control how much schema and metadata information is included: `summary` returns only name/description/tags, `standard` (default) adds schema keys and metadata flags, and `full` adds a simplified schema shape for each tool. Inspection is side-effect free and returns copies so you can safely log or mutate the output.

```typescript
import type { AnyToolbox } from 'armorer';

declare const toolbox: AnyToolbox;

const inspection = toolbox.inspect(); // 'standard' detail level
const summary = toolbox.inspect('summary'); // Less detail
const full = toolbox.inspect('full'); // Full schema shapes

console.log(inspection.counts.total); // Number of registered tools
console.log(inspection.tools); // Array of tool inspections
```

Example shape (standard detail):

```typescript
import type { AnyToolbox } from 'armorer';

declare const toolbox: AnyToolbox;

const inspection = toolbox.inspect();

console.log(inspection.counts); // { total, withTags, withMetadata }
console.log(inspection.tools[0]);
// {
//   name: 'fetch-weather',
//   description: 'Get current weather for a location',
//   tags: ['weather', 'api', 'external'],
//   schema: { keys: ['city', 'units'] },
//   metadata: { hasCustomMetadata: true, capabilities: ['read'], effort: 'low' }
// }
```

### Serialization

```typescript
import { createToolbox, type AnyToolbox } from 'armorer';

declare const toolbox: AnyToolbox;

// Export for storage/transmission
const serialized = toolbox.toJSON();

// Rehydrate from serialized state
const restored = createToolbox(serialized);
```

`SerializedToolbox` is a `ToolConfiguration[]` that includes execute functions, so it is meant for in-process cloning. Functions are not JSON-serializable, so `JSON.stringify(toolbox.toJSON())` will drop them. If you need cross-process persistence, store your own manifest (name, input schema, metadata, module path) and rebuild configurations at startup, typically using `lazy(() => import(...))` for the execute function.

### Combining Toolboxes

Use `.extend()` for immutable composition from an existing toolbox:

```typescript
import { createToolbox, type Tool } from 'armorer';

declare const addTool: Tool, subtractTool: Tool, formatTool: Tool, parseTool: Tool;
declare const auditTool: Tool;

const base = createToolbox([addTool, subtractTool], {
  context: { workspaceId: 'ws-1' },
});

const extended = base.extend(formatTool, parseTool);
// `base` is unchanged. `extended` includes all four tools.

const adminToolbox = createToolbox([auditTool], {
  context: { role: 'admin' },
});

const merged = base.extend(adminToolbox);
// Context merge is shallow, last toolbox wins:
// { workspaceId: 'ws-1', role: 'admin' }
```

Use `combineToolboxes(...)` when merging many toolboxes at once:

```typescript
import { combineToolboxes, type AnyToolbox } from 'armorer';

declare const mathToolbox: AnyToolbox, stringToolbox: AnyToolbox, adminToolbox: AnyToolbox;

const combined = combineToolboxes(mathToolbox, stringToolbox, adminToolbox);
console.log(combined.tools()); // All tools from all inputs
```

Behavior for both `.extend(toolbox)` and `combineToolboxes(...)`:

- Tools are copied via `toJSON()` into a new toolbox
- If multiple toolboxes define the same tool name, the **last** one wins
- Contexts are shallow-merged in input order (last one wins on key collisions)
