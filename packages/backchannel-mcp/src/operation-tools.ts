import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  type AuthInfo,
  type CallToolResult,
  type JsonSchemaType,
  type McpRequestContext,
} from '@modelcontextprotocol/server';

import type {
  OperationFault,
  OperationHandlerMount,
  OperationHandlerMountContext,
  OperationHandlerMountOperation,
} from '@lostgradient/backchannel';
import {
  faultWireAdvice,
  isAuthenticated,
  zodToJsonSchema,
  type DispatchResult,
} from '@lostgradient/backchannel/internals';

/**
 * Options for {@link createOperationMcpMount}.
 *
 * @example
 * ```ts
 * import type { OperationMcpMountOptions } from '@lostgradient/backchannel-mcp';
 *
 * const options: OperationMcpMountOptions = { serverInfo: { name: 'probe', version: '1.0.0' }, pathPrefix: '/mcp', maxEvents: 50 };
 * void options;
 * ```
 */
export type OperationMcpMountOptions = {
  /** Return a Bearer challenge when the caller can grant a missing tool scope. */
  readonly scopeChallenge?: (
    operation: OperationHandlerMountOperation,
    context: OperationHandlerMountContext,
  ) => Promise<{ challenge?: string } | undefined>;
  /** Declare that this mount accepts OAuth credentials for its catalog policies. */
  readonly oauth?: boolean;
  /** The path the mount owns on the operation handler. Defaults to `/mcp`. */
  readonly pathPrefix?: string;
  /** Upper bound on a POST body, answered `413` when exceeded. */
  readonly maxBodyBytes?: number;
  /** The server identity the MCP handshake reports. */
  readonly serverInfo: {
    /** The server's machine-readable name. */
    readonly name: string;
    /** The display name, when supplied. */
    readonly title?: string;
    /** The API version reported on the wire. */
    readonly version: string;
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
  /**
   * Metadata attached as `_meta` to every tool that has no `toolMeta` entry, such as the
   * `ui.visibility` that keeps a tool from MCP App pages. An entry replaces it whole; the two are
   * never merged. Absent, such a tool's listing carries no `_meta`.
   */
  readonly defaultToolMeta?: Readonly<Record<string, unknown>>;
};

/**
 * One resource an {@link OperationMcpMountOptions.resources} option serves.
 *
 * @example
 * ```ts
 * import type { OperationMcpResource } from '@lostgradient/backchannel-mcp';
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
  /** The resource's display title. */
  readonly title?: string;
  /** A short description shown to clients. */
  readonly description?: string;
  /** The media type of the resource contents. */
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

const DEFAULT_MCP_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_MAX_EVENTS = 100;
const DEFAULT_IDLE_MS = 250;
const MAX_TOOL_RESULT_BYTES = 256 * 1024;
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
 * import { createOperationHandler, defineOperation } from '@lostgradient/backchannel';
 * import { createOperationMcpMount } from '@lostgradient/backchannel-mcp';
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
 *   mounts: [createOperationMcpMount({ serverInfo: { name: 'probe', version: '1.0.0' } })],
 * });
 * void handler;
 * ```
 */
export function createOperationMcpMount(options: OperationMcpMountOptions): OperationHandlerMount {
  const limits = collectionLimits(options);
  const { name, title, version } = options.serverInfo;
  const serverInfo = { name, ...(title === undefined ? {} : { title }), version };
  const resources = validatedResources(options.resources ?? []);
  const toolMeta = options.toolMeta ?? {};
  const metaOf = (operationName: string) =>
    toolMetaOf(toolMeta, options.defaultToolMeta, operationName);
  const handler = createMcpHandler(
    (request) =>
      buildServer(
        contextOf(request),
        serverInfo,
        limits,
        resources,
        metaOf,
        options.oauth === true,
        options.scopeChallenge,
      ),
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
  metaOf: (name: string) => { _meta?: Record<string, unknown> },
  oauth: boolean,
  scopeChallenge: OperationMcpMountOptions['scopeChallenge'],
): McpServer {
  const server = new McpServer(serverInfo, {
    capabilities: resources.length === 0 ? { tools: {} } : { tools: {}, resources: {} },
  });
  registerResources(server, context, resources);
  for (const operation of context.operations) {
    if (!isMcpTool(operation)) continue;
    const outputSchema =
      operation.kind === 'subscription'
        ? undefined
        : objectOutputSchema(zodToJsonSchema(operation.outputSchema, 'output'));
    if (
      operation.kind === 'stream' ||
      (operation.kind !== 'subscription' && outputSchema === undefined)
    )
      continue;
    server.registerTool(
      operation.name,
      {
        title: operation.summary,
        description: operation.description ?? operation.summary,
        inputSchema: fromJsonSchema(toolInputSchema(operation) as JsonSchemaType),
        ...(outputSchema === undefined
          ? {}
          : { outputSchema: fromJsonSchema(outputSchema as JsonSchemaType) }),
        annotations: {
          readOnlyHint:
            !operation.destructive &&
            (operation.kind === 'subscription' || operation.behavior?.kind === 'read'),
          destructiveHint: operation.destructive,
        },
        ...toolMetadata(metaOf(operation.name)._meta, operation, oauth),
      },
      async (input, handlerContext) => {
        const refusal = await scopeChallenge?.(operation, context);
        if (refusal !== undefined) {
          return {
            ...faultResult({
              code: 'Forbidden',
              message: 'Insufficient scope',
              data: { reason: 'insufficient scope' },
            }),
            ...(refusal.challenge === undefined
              ? {}
              : { _meta: { 'mcp/www_authenticate': [refusal.challenge] } }),
          };
        }
        return operation.kind === 'subscription'
          ? collectSubscription(
              context,
              operation.name,
              input,
              limits,
              handlerContext.mcpReq.signal,
            )
          : handlerContext.mcpReq.signal.aborted
            ? faultResult({
                code: 'Unprocessable',
                message: 'call cancelled',
                data: { reason: 'cancelled' },
              })
            : toolResult(
                await context.dispatch(operation.name, input, {
                  transport: 'mcp',
                  signal: handlerContext.mcpReq.signal,
                }),
              );
      },
    );
  }
  return server;
}

export function isMcpTool(operation: OperationHandlerMountOperation): boolean {
  if (!operation.mcpExposable || operation.mcpTool !== undefined || operation.kind === 'stream')
    return false;
  return (
    operation.kind === 'subscription' ||
    objectOutputSchema(zodToJsonSchema(operation.outputSchema, 'output')) !== undefined
  );
}

function objectOutputSchema(schema: Record<string, unknown>): Record<string, unknown> | undefined {
  if (schema['type'] === 'object') return schema;
  if (schema['type'] !== undefined) return undefined;
  const arms = schema['oneOf'] ?? schema['anyOf'];
  if (
    !Array.isArray(arms) ||
    arms.length === 0 ||
    !arms.every((arm: unknown) => isRecord(arm) && objectOutputSchema(arm) !== undefined)
  )
    return undefined;
  return { ...schema, type: 'object' };
}

function toolMetadata(
  meta: Record<string, unknown> | undefined,
  operation: OperationHandlerMountOperation,
  oauth: boolean,
): { _meta?: Record<string, unknown> } {
  const schemes =
    oauth && operation.parameterizedAccess === undefined
      ? securitySchemes(operation.access)
      : undefined;
  if (meta === undefined && schemes === undefined) return {};
  return { _meta: { ...meta, ...(schemes === undefined ? {} : { securitySchemes: schemes }) } };
}

function securitySchemes(
  access: OperationHandlerMountOperation['access'],
): Array<Record<string, unknown>> | undefined {
  const requirement = (
    value: Extract<OperationHandlerMountOperation['access'], { kind: 'scoped' }>['scopes'],
  ) =>
    value.kind === 'allOf'
      ? [{ type: 'oauth2', scopes: [...value.scopes] }]
      : value.scopes.map((scope) => ({ type: 'oauth2', scopes: [scope] }));
  switch (access.kind) {
    case 'public':
      return [{ type: 'noauth' }];
    case 'authenticated':
      return [{ type: 'oauth2', scopes: [] }];
    case 'scoped':
      return requirement(access.scopes);
    case 'scopedAlternatives':
      return access.alternatives.flatMap(requirement);
    case 'optionalAuth':
      return undefined;
  }
}

/** The operation's input schema, closed or open as its JSON-RPC unknown-key policy says. */
function toolInputSchema(operation: OperationHandlerMountOperation): Record<string, unknown> {
  const schema = zodToJsonSchema(operation.inputSchema);
  const { $schema: _unused, ...rest } = schema;
  return { ...rest, additionalProperties: operation.unknownKeyPolicy.jsonRpc !== 'reject' };
}

function toolResult(result: DispatchResult<unknown>): CallToolResult {
  if (!result.ok) return faultResult(result.fault);
  if (!isRecord(result.value))
    return faultResult({
      code: 'Unprocessable',
      message: 'unsupported tool result',
      data: { reason: 'not an object' },
    });
  let serialized: string;
  try {
    serialized = JSON.stringify(result.value);
  } catch {
    return faultResult({
      code: 'Unprocessable',
      message: 'unsupported tool result',
      data: { reason: 'not JSON serializable' },
    });
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_TOOL_RESULT_BYTES)
    return faultResult({
      code: 'Unprocessable',
      message: 'tool result exceeds 262144 bytes',
      data: { reason: 'result too large' },
    });
  return {
    content: [{ type: 'text', text: serialized }],
    structuredContent: result.value,
  };
}

/**
 * A fault is the tool's error result, carrying the catalog's fault (`code`, `message`, `data`) as
 * structured content the model reads and can act on, with the same `retryable` (always) and
 * `remediation` (when set) the REST and JSON-RPC envelopes carry. A refused caller is one too: the
 * SDK answers any `tools/call` handler failure as an error result, so a refusal is the
 * `Unauthorized` or `Forbidden` fault, as every other catalog transport names it.
 */
function faultResult(fault: OperationFault): CallToolResult {
  const { retryable, remediation } = faultWireAdvice(fault);
  const payload = {
    code: fault.code,
    message: fault.message,
    ...('data' in fault ? { data: fault.data } : {}),
    retryable,
    ...(remediation === undefined ? {} : { remediation }),
  };
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return { content: [{ type: 'text', text: 'Fault could not be serialized' }], isError: true };
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_TOOL_RESULT_BYTES) {
    return {
      content: [{ type: 'text', text: 'Fault exceeds the tool result limit' }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: serialized }],
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
  const started = await context.subscribe(operationName, input, { transport: 'mcp', signal });
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
  return toolResult({ ok: true, value });
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
  defaultToolMeta: Readonly<Record<string, unknown>> | undefined,
  name: string,
): { _meta?: Record<string, unknown> } {
  const meta = Object.hasOwn(toolMeta, name) ? toolMeta[name] : defaultToolMeta;
  return meta === undefined ? {} : { _meta: { ...meta } };
}
