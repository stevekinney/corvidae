import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  type AuthInfo,
  type CallToolResult,
  type JsonSchemaType,
  type McpRequestContext,
} from '@modelcontextprotocol/server';

import { definitionSchemaToJsonSchema } from '../core/types/definition-schema-to-json.ts';
import type {
  OperationHandlerMount,
  OperationHandlerMountContext,
  OperationHandlerMountOperation,
} from '../server/handler/operation-handler-mounts.ts';
import type { DispatchResult } from '../server/operation-catalog.ts';
import type { OperationFault } from '../server/operation-fault.ts';
import { isAuthenticated } from '../server/principal.ts';
import { VERSION } from '../version.ts';
import { DEFAULT_MCP_MAX_BODY_BYTES } from './protocol.ts';

/**
 * Options for {@link createOperationMcpMount}.
 *
 * @example
 * ```ts
 * import type { OperationMcpMountOptions } from '@lostgradient/weft';
 *
 * const options: OperationMcpMountOptions = { pathPrefix: '/mcp', maxEvents: 50 };
 * void options;
 * ```
 */
export type OperationMcpMountOptions = {
  /** The path the mount owns on the operation handler. Defaults to `/mcp`. */
  readonly pathPrefix?: string;
  /** Upper bound on a POST body, answered `413` when exceeded. */
  readonly maxBodyBytes?: number;
  /** The `serverInfo` the MCP handshake reports; each field omitted is Weft's own. */
  readonly serverInfo?: {
    readonly name?: string;
    readonly title?: string;
    readonly version?: string;
  };
  /**
   * The most elements one call to a `subscription` tool returns. The tool answers with what is
   * recorded after its `fromCursor`, up to this many, and the cursor to resume from. Defaults to 100.
   */
  readonly maxEvents?: number;
  /**
   * How long a `subscription` tool waits for the next element before it answers with what it has.
   * A replayed history arrives back to back, so the first gap this long ends the call. Defaults to
   * 250 milliseconds.
   */
  readonly idleMs?: number;
  /**
   * Resources the server serves through `resources/list` and `resources/read` (COR-910), such as an
   * MCP App's `ui://` page. Injected at mount time, so the mount knows nothing of what they hold.
   * Absent, the server advertises no `resources` capability.
   */
  readonly resources?: readonly OperationMcpResource[];
  /**
   * Metadata attached to a tool's listing as its `_meta`, keyed by operation name, such as the
   * `ui.resourceUri` that links a tool to an MCP App. An entry for an operation that is not served
   * as a tool is ignored.
   */
  readonly toolMeta?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
};

/**
 * One resource an {@link OperationMcpMountOptions.resources} option serves.
 *
 * @example
 * ```ts
 * import type { OperationMcpResource } from '@lostgradient/weft';
 *
 * const page: OperationMcpResource = {
 *   uri: 'ui://probe/page',
 *   name: 'probe-page',
 *   mimeType: 'text/html;profile=mcp-app',
 *   text: '<!doctype html><title>probe</title>',
 * };
 * void page;
 * ```
 */
export type OperationMcpResource = {
  /** The resource's URI; unique among the mount's resources. */
  readonly uri: string;
  /** The resource's name in a listing. */
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType: string;
  /** The contents. A function runs on every read, with the context of the request. */
  readonly text: string | ((context: OperationHandlerMountContext) => string | Promise<string>);
  /** Metadata for the resource's listing and its contents, such as an MCP App's `ui` declaration. */
  readonly _meta?: Readonly<Record<string, unknown>>;
  /**
   * Whether the request's caller may see the resource. A caller it refuses finds the resource
   * neither listed nor readable, as if it did not exist. Absent, every caller the mount serves may.
   */
  readonly authorize?: (context: OperationHandlerMountContext) => boolean;
};

const DEFAULT_MAX_EVENTS = 100;
const DEFAULT_IDLE_MS = 250;
/** The key under `AuthInfo.extra` that carries the mount's context to the server factory. */
const CONTEXT_KEY = 'weftOperationMount';

/**
 * Serve a catalog's `mcpExposable` operations as MCP tools, mounted on
 * `createOperationHandler` (COR-839). Each operation becomes a tool of its
 * own name whose input schema is the operation's; a call runs through the full
 * catalog pipeline (transport `mcp`, access policy, parsing, `authorize`,
 * output validation) as the principal the handler authenticated, so the tool
 * reaches nothing the caller could not reach on the catalog's other
 * transports.
 *
 * Both MCP protocol eras are served: the 2026-07-28 revision on the SDK's
 * modern lane and 2025-era clients on its stateless legacy lane. A unary
 * operation answers with its validated output as `structuredContent`. A
 * `subscription` operation answers with the elements recorded after its
 * `fromCursor`, up to `maxEvents`, and the cursor to resume from, so a client
 * polls it rather than holding a stream. Every catalog fault, a refused caller
 * included, is a tool error result whose structured content is the fault.
 *
 * @example
 * ```ts
 * import { createOperationHandler, createOperationMcpMount, defineOperation } from '@lostgradient/weft';
 * import { z } from 'zod';
 *
 * const echo = defineOperation({
 *   name: 'probe.echo',
 *   mcpExposable: true,
 *   summary: 'Echo a message',
 *   destructive: false,
 *   inputSchema: z.object({ message: z.string() }),
 *   outputSchema: z.object({ message: z.string() }),
 *   access: { kind: 'public' },
 *   transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
 *   unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
 *   invoke: async ({ input }) => ({ message: input.message }),
 * });
 *
 * const handler = createOperationHandler({
 *   operations: [echo],
 *   host: {},
 *   mounts: [createOperationMcpMount()],
 * });
 * void handler;
 * ```
 */
export function createOperationMcpMount(
  options: OperationMcpMountOptions = {},
): OperationHandlerMount {
  const limits = collectionLimits(options);
  const serverInfo = { name: 'weft', title: 'Weft', version: VERSION, ...options.serverInfo };
  const resources = validatedResources(options.resources ?? []);
  const toolMeta = options.toolMeta ?? {};
  const handler = createMcpHandler(
    (request) => buildServer(contextOf(request), serverInfo, limits, resources, toolMeta),
    {
      legacy: 'stateless',
      maxRequestBodySize: options.maxBodyBytes ?? DEFAULT_MCP_MAX_BODY_BYTES,
    },
  );
  return {
    pathPrefix: options.pathPrefix ?? '/mcp',
    fetch: (request, context) => handler.fetch(request, { authInfo: authInfoFor(context) }),
  };
}

function collectionLimits(options: OperationMcpMountOptions): CollectionLimits {
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  if (!Number.isInteger(maxEvents) || maxEvents < 1) {
    throw new RangeError('createOperationMcpMount: maxEvents must be a positive integer');
  }
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  if (!Number.isFinite(idleMs) || idleMs < 0) {
    throw new RangeError('createOperationMcpMount: idleMs must be a non-negative number');
  }
  return { maxEvents, idleMs };
}

function validatedResources(
  resources: readonly OperationMcpResource[],
): readonly OperationMcpResource[] {
  const seen = new Set<string>();
  for (const resource of resources) {
    if (resource.uri === '' || resource.name === '' || resource.mimeType === '') {
      throw new RangeError(
        'createOperationMcpMount: a resource needs a uri, a name, and a mimeType',
      );
    }
    if (seen.has(resource.uri)) {
      throw new RangeError(`createOperationMcpMount: resource "${resource.uri}" is declared twice`);
    }
    seen.add(resource.uri);
  }
  return [...resources];
}

function authInfoFor(context: OperationHandlerMountContext): AuthInfo {
  const { principal } = context;
  const authenticated = isAuthenticated(principal);
  return {
    token: '',
    clientId: authenticated ? (principal.subject ?? principal.method) : 'anonymous',
    scopes: authenticated ? [...principal.scopes] : [],
    extra: { [CONTEXT_KEY]: context },
  };
}

function contextOf(request: McpRequestContext): OperationHandlerMountContext {
  const context = request.authInfo?.extra?.[CONTEXT_KEY] as
    OperationHandlerMountContext | undefined;
  // The mount's own `fetch` attaches it; the SDK never builds a server for a request without it.
  if (context === undefined) throw new Error('createOperationMcpMount: request carries no context');
  return context;
}

type CollectionLimits = { readonly maxEvents: number; readonly idleMs: number };

/** Register the injected resources the request's caller may see. */
function registerResources(
  server: McpServer,
  context: OperationHandlerMountContext,
  resources: readonly OperationMcpResource[],
): void {
  for (const resource of resources) {
    if (resource.authorize !== undefined && !resource.authorize(context)) continue;
    server.registerResource(
      resource.name,
      resource.uri,
      {
        ...(resource.title === undefined ? {} : { title: resource.title }),
        ...(resource.description === undefined ? {} : { description: resource.description }),
        mimeType: resource.mimeType,
        ...(resource._meta === undefined ? {} : { _meta: { ...resource._meta } }),
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: resource.mimeType,
            text: typeof resource.text === 'string' ? resource.text : await resource.text(context),
            ...(resource._meta === undefined ? {} : { _meta: { ...resource._meta } }),
          },
        ],
      }),
    );
  }
}

function buildServer(
  context: OperationHandlerMountContext,
  serverInfo: { readonly name: string; readonly title?: string; readonly version: string },
  limits: CollectionLimits,
  resources: readonly OperationMcpResource[],
  toolMeta: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): McpServer {
  const server = new McpServer(serverInfo, {
    capabilities: resources.length === 0 ? { tools: {} } : { tools: {}, resources: {} },
  });
  registerResources(server, context, resources);
  for (const operation of context.operations) {
    if (!operation.mcpExposable || operation.mcpTool !== undefined) continue;
    server.registerTool(
      operation.name,
      {
        title: operation.summary,
        description: operation.description ?? operation.summary,
        inputSchema: fromJsonSchema(toolInputSchema(operation) as JsonSchemaType),
        annotations: {
          readOnlyHint: !operation.destructive && operation.kind === 'subscription',
          destructiveHint: operation.destructive,
        },
        ...(toolMeta[operation.name] === undefined
          ? {}
          : { _meta: { ...toolMeta[operation.name] } }),
      },
      async (input, handlerContext) =>
        operation.kind === 'subscription'
          ? collectSubscription(
              context,
              operation.name,
              input,
              limits,
              handlerContext.mcpReq.signal,
            )
          : toolResult(await context.dispatch(operation.name, input, { transport: 'mcp' })),
    );
  }
  return server;
}

/** The operation's input schema, closed or open as its JSON-RPC unknown-key policy says. */
function toolInputSchema(operation: OperationHandlerMountOperation): Record<string, unknown> {
  const schema = definitionSchemaToJsonSchema(operation.inputSchema);
  const { $schema: _unused, ...rest } = schema;
  return { ...rest, additionalProperties: operation.unknownKeyPolicy.jsonRpc !== 'reject' };
}

function toolResult(result: DispatchResult<unknown>): CallToolResult {
  if (!result.ok) return faultResult(result.fault);
  return {
    content: [{ type: 'text', text: JSON.stringify(result.value) }],
    ...(isRecord(result.value) ? { structuredContent: result.value } : {}),
  };
}

/**
 * A fault is the tool's error result, carrying the catalog's fault (`code`, `message`, `data`) as
 * structured content the model reads and can act on. A refused caller is one too: the SDK answers
 * any `tools/call` handler failure as an error result, so a refusal is the `Unauthorized` or
 * `Forbidden` fault, as every other catalog transport names it.
 */
function faultResult(fault: OperationFault): CallToolResult {
  const payload = {
    code: fault.code,
    message: fault.message,
    ...('data' in fault ? { data: fault.data } : {}),
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

/**
 * Run a `subscription` operation and collect what it has already recorded: elements until none
 * arrives for `idleMs`, at most `maxEvents`, then close it. The client resumes from `nextCursor`.
 */
async function collectSubscription(
  context: OperationHandlerMountContext,
  operationName: string,
  input: unknown,
  limits: CollectionLimits,
  signal: AbortSignal,
): Promise<CallToolResult> {
  const started = await context.subscribe(operationName, input, { transport: 'mcp' });
  if (!started.ok) return faultResult(started.fault);
  const { envelope, iterable, close } = started.value;
  const events: unknown[] = [];
  let ended = false;
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    while (events.length < limits.maxEvents && !signal.aborted) {
      const next = await nextOrIdle(iterator, limits.idleMs);
      if (next === 'idle') break;
      if (next.done === true) {
        ended = true;
        break;
      }
      events.push(next.value);
    }
  } finally {
    await close();
  }
  const last = events.at(-1);
  const nextCursor = isRecord(last) && typeof last['cursor'] === 'string' ? last['cursor'] : null;
  const value = { envelope, events, nextCursor, ended };
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

async function nextOrIdle(
  iterator: AsyncIterator<unknown>,
  idleMs: number,
): Promise<IteratorResult<unknown> | 'idle'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<'idle'>((resolve) => {
    timer = setTimeout(() => resolve('idle'), idleMs);
  });
  try {
    return await Promise.race([iterator.next(), idle]);
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toolMetaOf(
  toolMeta: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  name: string,
): { _meta?: Record<string, unknown> } {
  const meta = toolMeta[name];
  return meta === undefined ? {} : { _meta: { ...meta } };
}
