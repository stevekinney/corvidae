import type { CallToolRequestOptions } from '@modelcontextprotocol/client';
import type {
  CallToolResult,
  InputRequiredResult,
  Tool as MCPTool,
  Progress,
  ServerContext,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import type { Context } from '@opentelemetry/api';
import type { z } from 'zod';

import type { JsonObject } from '../../core/serialization/json';
import { createTool } from '../../create-tool';
import type { createExecutionLifecycle } from '../../execution-lifecycle';
import type {
  Tool,
  ToolContext,
  ToolElicitationRequester,
  ToolExecuteWithOptions,
} from '../../is-tool';
import { isTool } from '../../is-tool';
import type { ToolResultLike } from '../../types';
import { parseMcpCallResult, toCallToolResult, toTextContent } from './content';
import { createMcpToolElicitationRequester } from './elicitation';
import {
  createSuspendableExecution,
  deliverInputResponse,
  type InputRoundRegistry,
  type SuspendableExecution,
} from './input-required';
import {
  createProgressForwarder,
  readRequestFacts,
  subscribeToExecutionProgress,
  type MCPClientSession,
  type MCPRequestExecutionContext,
} from './request-context';
import { resolveInboundMcpSchema, resolveOutboundMcpSchema } from './schema';

export type ToolboxLike = {
  tools: () => readonly Tool[];
  getAvailable?: () => Promise<ReadonlyArray<Tool>>;
  execute?: (
    call: { id?: string; name: string; arguments: unknown },
    options?: {
      signal?: AbortSignal;
      elicit?: ToolElicitationRequester;
      executionId?: string;
      executionContext?: Record<string, unknown>;
      traceContext?: unknown;
    },
  ) => Promise<ToolResultLike>;
  getTool?: (nameOrId: string) => Tool | undefined;
};

export type MCPToolConfiguration = {
  title?: string;
  description?: string;
  schema?: unknown;
  annotations?: ToolAnnotations;
  meta?: Record<string, unknown>;
};

export type MCPToolLike = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
};

/** Return type of an exported MCP tool handler: a result, or (2026-07-28) a request for client input. */
export type MCPToolHandlerResult = CallToolResult | InputRequiredResult;

export type MCPToolHandler = (
  args: unknown,
  context?: ServerContext,
) => Promise<MCPToolHandlerResult>;

export type MCPToolDefinition = MCPToolLike & {
  inputSchema: z.ZodType;
  handler: MCPToolHandler;
};

export type MCPToolSource = MCPTool | MCPToolLike | MCPToolDefinition;

/**
 * Everything one MCP tool call hands to the Armorer execution: the execution
 * identity, the abort signal the server owns for it, the request's protocol
 * facts (`executionContext.mcp`), its W3C trace context as an OpenTelemetry
 * `Context`, and the elicitation requester when the client can answer one.
 */
export type MCPToolExecutionRequest = {
  params: unknown;
  callId?: string;
  executionId: string;
  signal: AbortSignal;
  elicit?: ToolElicitationRequester;
  executionContext: { mcp: MCPRequestExecutionContext };
  traceContext?: Context;
};

export type ToMCPToolsOptions = {
  toolConfiguration?: (tool: Tool) => MCPToolConfiguration;
  formatResult?: (result: ToolResultLike) => CallToolResult;
  executeTool?: (tool: Tool, request: MCPToolExecutionRequest) => Promise<ToolResultLike>;
  /**
   * Session facts a 2025-era connection learned at `initialize` (client
   * capabilities, client information, negotiated version). A 2026-07-28
   * request carries its own, which take precedence. Without capabilities a
   * 2025-era request leaves `context.elicit` undefined, so tools using the
   * `if (context.elicit)` feature-detection pattern take their
   * no-elicitation path.
   */
  clientSession?: MCPClientSession;
  /**
   * Suspends executions behind `input_required` results on 2026-07-28
   * requests. `createMCP` supplies one; without it a 2026-07-28 request
   * leaves `context.elicit` undefined.
   */
  inputRounds?: InputRoundRegistry;
  /** Internal server-owned lifecycle used by createMCP. */
  executionLifecycle?: ReturnType<typeof createExecutionLifecycle>;
};

export type FromMCPToolsOptions = {
  callTool?: (
    request: { name: string; arguments?: Record<string, unknown> },
    options?: Pick<CallToolRequestOptions, 'signal' | 'onprogress'>,
  ) => Promise<CallToolResult>;
  formatResult?: (result: CallToolResult, tool: MCPToolSource) => unknown;
  /**
   * Forward the remote tool's MCP progress notifications as Armorer progress
   * events (`context.progress`). When `false`, no progress is requested, so
   * the server sends none. Defaults to `true`.
   */
  progress?: boolean;
};

export function toMcpTools(
  input: ToolboxLike | Tool | readonly Tool[],
  options: ToMCPToolsOptions = {},
): MCPToolDefinition[] {
  const tools = normalizeToolInput(input);
  return tools.map((tool) => toMcpToolDefinition(tool, options));
}

/**
 * Converts MCP tool definitions into executable Armorer tools (client
 * direction). Each call goes through `callTool` with the tool's abort signal
 * and, unless `progress: false`, an `onprogress` callback whose updates
 * surface as Armorer progress events.
 */
export function fromMcpTools(
  tools: readonly MCPToolSource[],
  options: FromMCPToolsOptions = {},
): Tool[] {
  return tools.map((mcpTool) => {
    const schema = resolveInboundMcpSchema(mcpTool.name, mcpTool.inputSchema);
    const metadata = metadataFromMcpTool(mcpTool);
    const createOptions = {
      name: mcpTool.name,
      description: mcpTool.description ?? mcpTool.title ?? mcpTool.name,
      input: schema,
      ...(metadata === undefined ? {} : { metadata }),
      async execute(params: unknown, context?: ToolContext) {
        const callResult = await executeMcpTool(mcpTool, params, options, context);
        return options.formatResult
          ? options.formatResult(callResult, mcpTool)
          : parseMcpCallResult(callResult);
      },
    };
    return createTool(createOptions);
  });
}

/**
 * Resolves a tool's MCP configuration by merging metadata-derived
 * configuration (`tool.metadata.mcp`) with the caller-supplied
 * `toolConfiguration()` callback.
 */
export function resolveToolConfiguration(
  tool: Tool,
  toolConfiguration: ToMCPToolsOptions['toolConfiguration'],
): MCPToolConfiguration {
  return {
    ...toolConfigurationFromMetadata(tool),
    ...toolConfiguration?.(tool),
  };
}

type ResolvedMcpToolShape = {
  title?: string;
  description: string;
  inputSchema: z.ZodType;
  annotations?: ToolAnnotations;
  meta?: Record<string, unknown>;
};

function resolveMcpToolShape(
  tool: Tool,
  configuration: MCPToolConfiguration,
): ResolvedMcpToolShape {
  const meta = configuration.meta ?? tool.metadata;
  const readOnlyHint = tool.metadata?.readOnly === true;
  const annotations = readOnlyHint
    ? {
        ...configuration.annotations,
        ...(configuration.annotations?.readOnlyHint === undefined ? { readOnlyHint: true } : {}),
      }
    : configuration.annotations;

  const shape: ResolvedMcpToolShape = {
    description: configuration.description ?? tool.description,
    inputSchema: resolveOutboundMcpSchema(configuration.schema) ?? tool.input,
  };
  if (configuration.title !== undefined) shape.title = configuration.title;
  if (annotations !== undefined) shape.annotations = annotations;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) shape.meta = meta;
  return shape;
}

function toMcpToolDefinition(tool: Tool, options: ToMCPToolsOptions): MCPToolDefinition {
  return buildMcpToolDefinition(
    tool,
    resolveToolConfiguration(tool, options.toolConfiguration),
    options,
  );
}

export function buildMcpToolDefinition(
  tool: Tool,
  configuration: MCPToolConfiguration,
  options: ToMCPToolsOptions,
): MCPToolDefinition {
  const shape = resolveMcpToolShape(tool, configuration);
  const mcpTool: MCPToolDefinition = {
    name: tool.name,
    description: shape.description,
    inputSchema: shape.inputSchema,
    handler: (args, context) => handleToolCall(tool, args ?? {}, context, options),
  };
  if (shape.title !== undefined) mcpTool.title = shape.title;
  if (shape.annotations !== undefined) mcpTool.annotations = shape.annotations;
  if (shape.meta !== undefined) mcpTool._meta = shape.meta;
  return mcpTool;
}

/**
 * Serves one `tools/call` round.
 *
 * A 2026-07-28 retry carrying `requestState` resumes the execution it names;
 * anything else starts a new execution. A 2025-era request asks for input
 * through push-style `elicitation/create` within the same round; a
 * 2026-07-28 request suspends the execution behind `input_required`.
 */
async function handleToolCall(
  tool: Tool,
  params: unknown,
  context: ServerContext | undefined,
  options: ToMCPToolsOptions,
): Promise<MCPToolHandlerResult> {
  const facts = readRequestFacts(context, options.clientSession);
  const inputRounds = facts.context.era === 'modern' ? options.inputRounds : undefined;
  const state = inputRounds && context ? context.mcpReq.requestState() : undefined;
  if (inputRounds && context && state !== undefined) {
    return resumeToolCall(tool, state, context, facts, inputRounds);
  }

  const canElicit = context !== undefined && clientCanElicit(facts.context, options.clientSession);
  const control = beginExecution(tool, context, options);
  const forwarder = createProgressForwarder();
  const unsubscribe = subscribeToExecutionProgress(tool, control.id, (update) =>
    forwarder.forward(update),
  );

  let suspendable: SuspendableExecution | undefined;
  let elicit: ToolElicitationRequester | undefined;
  if (canElicit && facts.context.era === 'legacy') {
    elicit = createMcpToolElicitationRequester(context);
  } else if (canElicit && inputRounds) {
    elicit = (request) => suspendable!.requestInput(request);
  }

  const run = async (): Promise<CallToolResult> => {
    try {
      const result = await executeArmorerTool(tool, options, {
        params,
        ...(facts.context.requestId ? { callId: facts.context.requestId } : {}),
        executionId: control.id,
        signal: control.signal,
        ...(elicit ? { elicit } : {}),
        executionContext: { mcp: facts.context },
        ...(facts.traceContext !== undefined ? { traceContext: facts.traceContext } : {}),
      });
      const callResult = options.formatResult
        ? options.formatResult(result)
        : toCallToolResult(result);
      control.settle(callResult);
      return callResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorResult: CallToolResult = { content: toTextContent(message), isError: true };
      control.settle(errorResult);
      return errorResult;
    } finally {
      unsubscribe();
      inputRounds?.forget(control.id);
    }
  };

  if (!(context && elicit && inputRounds && facts.context.era === 'modern')) {
    return runRound(context, facts, forwarder, control.abort, run);
  }
  suspendable = createSuspendableExecution({
    id: control.id,
    toolName: tool.name,
    signal: control.signal,
    abort: control.abort,
    completion: run,
  });
  roundForwarders.set(suspendable, forwarder);
  return runSuspendableRound(suspendable, context, facts, inputRounds);
}

/** Each suspended execution keeps one progress forwarder across its rounds. */
const roundForwarders = new WeakMap<
  SuspendableExecution,
  ReturnType<typeof createProgressForwarder>
>();

async function resumeToolCall(
  tool: Tool,
  state: unknown,
  context: ServerContext,
  facts: ReturnType<typeof readRequestFacts>,
  inputRounds: InputRoundRegistry,
): Promise<MCPToolHandlerResult> {
  const execution = inputRounds.claim(tool.name, state);
  if (!execution) {
    return {
      isError: true,
      content: toTextContent(
        'This MCP input round is no longer pending: it expired, was already answered, or was issued by another server process. The tool was not run again.',
      ),
    };
  }
  if (!deliverInputResponse(execution, context.mcpReq.inputResponses)) {
    return inputRounds.suspend(execution, context);
  }
  return runSuspendableRound(execution, context, facts, inputRounds);
}

async function runSuspendableRound(
  execution: SuspendableExecution,
  context: ServerContext,
  facts: ReturnType<typeof readRequestFacts>,
  inputRounds: InputRoundRegistry,
): Promise<MCPToolHandlerResult> {
  const forwarder = roundForwarders.get(execution);
  const outcome = await runRound(
    context,
    facts,
    forwarder,
    (reason) => execution.expire(toError(reason)),
    () => execution.nextOutcome(),
  );
  if (outcome.kind === 'complete') return outcome.result;
  execution.round += 1;
  return inputRounds.suspend(execution, context);
}

/**
 * Runs one request round: points progress at this round's token and aborts
 * the execution if this round's request is cancelled while it is in flight.
 * After the round answers, the SDK aborts the request's signal as the
 * per-request instance closes, so the link is removed first.
 */
async function runRound<T>(
  context: ServerContext | undefined,
  facts: ReturnType<typeof readRequestFacts>,
  forwarder: ReturnType<typeof createProgressForwarder> | undefined,
  abort: (reason: unknown) => void,
  work: () => Promise<T>,
): Promise<T> {
  const requestSignal = context?.mcpReq.signal;
  const onAbort = () => abort(requestSignal?.reason);
  if (requestSignal?.aborted) onAbort();
  else requestSignal?.addEventListener('abort', onAbort, { once: true });
  forwarder?.setSink(
    context && facts.progressToken !== undefined
      ? { token: facts.progressToken, notify: context.mcpReq.notify }
      : undefined,
  );
  try {
    return await work();
  } finally {
    requestSignal?.removeEventListener('abort', onAbort);
    forwarder?.setSink(undefined);
  }
}

type ExecutionControl = {
  id: string;
  signal: AbortSignal;
  abort: (reason: unknown) => void;
  settle: (result: CallToolResult) => void;
};

function beginExecution(
  tool: Tool,
  context: ServerContext | undefined,
  options: ToMCPToolsOptions,
): ExecutionControl {
  const callId = context?.mcpReq.id !== undefined ? String(context.mcpReq.id) : `mcp-${tool.name}`;
  const handle = options.executionLifecycle?.begin({ toolName: tool.name, callId });
  if (handle) {
    handle.activate();
    return {
      id: handle.id,
      signal: handle.signal,
      abort: (reason) => handle.abort('caller', reason),
      settle: (result) => handle.settle(result),
    };
  }
  const controller = new AbortController();
  return {
    id: globalThis.crypto.randomUUID(),
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    settle: () => undefined,
  };
}

async function executeArmorerTool(
  tool: Tool,
  options: ToMCPToolsOptions,
  request: MCPToolExecutionRequest,
): Promise<ToolResultLike> {
  if (options.executeTool) {
    return options.executeTool(tool, request);
  }
  const executeOptions: ToolExecuteWithOptions = {
    params: request.params,
    executionId: request.executionId,
    signal: request.signal,
    executionContext: request.executionContext,
  };
  if (request.callId !== undefined) executeOptions.callId = request.callId;
  if (request.elicit) executeOptions.elicit = request.elicit;
  if (request.traceContext !== undefined) executeOptions.traceContext = request.traceContext;
  return tool.executeWith(executeOptions);
}

function normalizeToolInput(input: ToolboxLike | Tool | readonly Tool[]): Tool[] {
  if (isToolboxLike(input)) {
    return [...input.tools()];
  }
  if (Array.isArray(input)) {
    return input.map((tool) => {
      if (!isTool(tool) && !isToolLike(tool)) {
        throw new TypeError('Invalid tool input: expected Tool');
      }
      return tool;
    });
  }
  if (isTool(input) || isToolLike(input)) {
    return [input];
  }
  throw new TypeError('Invalid input: expected tool, tool array, or Toolbox');
}

function isToolboxLike(value: unknown): value is ToolboxLike {
  if (!value || typeof value !== 'object') return false;
  return typeof (value as { tools?: unknown }).tools === 'function';
}

function isToolLike(value: unknown): value is Tool {
  return (
    isRecord(value) &&
    typeof value['name'] === 'string' &&
    typeof value['description'] === 'string' &&
    'input' in value &&
    typeof value['executeWith'] === 'function'
  );
}

function hasMcpToolHandler(tool: MCPToolSource): tool is MCPToolDefinition {
  return typeof (tool as MCPToolDefinition).handler === 'function';
}

async function executeMcpTool(
  tool: MCPToolSource,
  params: unknown,
  options: FromMCPToolsOptions,
  context: ToolContext | undefined,
): Promise<CallToolResult> {
  if (hasMcpToolHandler(tool)) {
    const result = await tool.handler(params ?? {});
    if (!('content' in result) && !('structuredContent' in result)) {
      throw new Error(`MCP tool "${tool.name}" requested client input outside an MCP request.`);
    }
    return result as CallToolResult;
  }
  if (!options.callTool) {
    throw new Error(`fromMcpTools() requires callTool() for "${tool.name}".`);
  }
  const signal = context?.signal;
  const onprogress =
    options.progress === false || !context
      ? undefined
      : (update: Progress) => context.progress(toArmorerProgress(update));
  return options.callTool(
    { name: tool.name, arguments: isRecord(params) ? params : {} },
    { ...(signal ? { signal } : {}), ...(onprogress ? { onprogress } : {}) },
  );
}

/** Maps an MCP progress notification onto an Armorer progress update. */
function toArmorerProgress(update: Progress): {
  percent?: number;
  message?: string;
  checkpoint: Progress;
} {
  const percent =
    typeof update.total === 'number' && update.total > 0
      ? (update.progress / update.total) * 100
      : undefined;
  return {
    ...(percent !== undefined ? { percent } : {}),
    ...(update.message !== undefined ? { message: update.message } : {}),
    checkpoint: update,
  };
}

function metadataFromMcpTool(tool: MCPToolSource): Tool['metadata'] {
  const metadata: NonNullable<Tool['metadata']> = {};
  if (tool.annotations?.readOnlyHint === true) {
    metadata['readOnly'] = true;
  }
  const mcp: { title?: string; description?: string; meta?: JsonObject } = {};
  if (tool.title !== undefined) mcp['title'] = tool.title;
  if (tool.description !== undefined) mcp['description'] = tool.description;
  // The whole `_meta` record (MCP Apps' `_meta.ui` included) rides along unchanged under
  // `metadata.mcp.meta`, which `toMcpTools` and `createMCP` already emit as `_meta`.
  // `_meta` arrives as JSON on the wire; tool metadata is JSON by contract.
  if (tool._meta !== undefined) mcp['meta'] = tool._meta as JsonObject;
  if (Object.keys(mcp).length) {
    metadata['mcp'] = mcp;
  }
  return Object.keys(metadata).length ? metadata : undefined;
}

export function toolConfigurationFromMetadata(tool: Tool): MCPToolConfiguration | undefined {
  const metadata = tool.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }
  const mcp = (metadata as Record<string, unknown>)['mcp'];
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) {
    return undefined;
  }
  const configuration = mcp as Partial<MCPToolConfiguration>;
  const resolved: MCPToolConfiguration = {};
  if (configuration.title !== undefined) resolved.title = configuration.title;
  if (configuration.description !== undefined) resolved.description = configuration.description;
  if (configuration.schema !== undefined) resolved.schema = configuration.schema;
  let annotations = configuration.annotations ? { ...configuration.annotations } : undefined;
  if (metadata.readOnly === true) {
    if (!annotations) {
      annotations = { readOnlyHint: true };
    } else if (annotations.readOnlyHint === undefined) {
      annotations.readOnlyHint = true;
    }
  }
  if (annotations) resolved.annotations = annotations;
  if (configuration.meta !== undefined) resolved.meta = configuration.meta;
  return resolved;
}

/**
 * Whether the request's client can answer elicitation. Declared capabilities
 * decide when they are known; a `toMcpTools` caller that supplies no session
 * on a 2025-era request keeps the historical default of exposing `elicit`.
 */
function clientCanElicit(
  context: MCPRequestExecutionContext,
  session: MCPClientSession | undefined,
): boolean {
  if (context.clientCapabilities !== undefined) {
    return context.clientCapabilities.elicitation !== undefined;
  }
  return context.era === 'legacy' && session?.clientCapabilities === undefined;
}

function toError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === 'string' ? reason : 'aborted');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
