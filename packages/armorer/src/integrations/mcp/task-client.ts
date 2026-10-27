import type { CallToolResult } from '@modelcontextprotocol/server';

import type { Tool, ToolContext } from '../../is-tool';
import { toElicitResult, toToolElicitationRequest } from './elicitation';
import { MCP_PROTOCOL_VERSION } from './server';
import { MCP_TASKS_EXTENSION } from './tasks';
import { fromMcpTools, type FromMCPToolsOptions, type MCPToolSource } from './tools';

/**
 * Consumer side of the MCP Tasks extension.
 *
 * The SDK 2.4.0 client rejects a `resultType: "task"` answer, so this sends
 * raw 2026-07-28 JSON-RPC over an authenticated `fetch` instead.
 */

/** Thrown when a call is answered with `input_required` outside an MCP task, or an MCP task needs input the caller cannot give. */
export class MCPInputRequiredUnsupportedError extends Error {
  constructor(readonly toolName: string) {
    super(
      `MCP tool "${toolName}" asked for client input that fromMcpEndpointTools cannot answer; use fromMcpClientTools for this tool.`,
    );
    this.name = 'MCPInputRequiredUnsupportedError';
  }
}

/**
 * Thrown when a remote MCP task ends `failed` or `cancelled`, or a JSON-RPC
 * request is answered with an error (`-32602` for an unknown or expired MCP
 * task, for one).
 */
export class MCPTaskClientError extends Error {
  constructor(
    message: string,
    readonly details: { status?: string; code?: number; taskId?: string } = {},
  ) {
    super(message);
    this.name = 'MCPTaskClientError';
  }
}

/** Options for {@link fromMcpEndpointTools}. */
export type FromMcpEndpointToolsOptions = Pick<
  FromMCPToolsOptions,
  'formatResult' | 'progress' | 'serverId'
> & {
  /** The (authenticated) `fetch` every request goes through. */
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** The MCP endpoint URL. */
  url: string | URL;
  /**
   * Waits between `tasks/get` polls. Receives the interval the server
   * advertised in milliseconds. Defaults to a `setTimeout`.
   */
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** The `clientInfo` each request declares. */
  clientInfo?: { name: string; version: string };
};

type WireTask = {
  resultType?: string;
  taskId?: string;
  status?: string;
  statusMessage?: string;
  pollIntervalMs?: number;
  result?: CallToolResult;
  error?: { code: number; message: string };
  inputRequests?: Record<string, { method?: string; params?: unknown }>;
};

const DEFAULT_CLIENT_INFO = { name: 'armorer-mcp-endpoint', version: '0.0.0' };
const DEFAULT_POLL_INTERVAL_MS = 1_000;

const defaultDelay = (milliseconds: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

/**
 * Lists the tools of an MCP endpoint over raw 2026-07-28 JSON-RPC and
 * returns executable Armorer tools whose calls declare the Tasks extension.
 * A `complete` answer passes through. A task handle is polled with
 * `tasks/get`, through `delay`, until it resolves to the final result, so
 * polling is hidden from the caller. An MCP task that needs input is
 * answered through the calling tool's `context.elicit`. Aborting the call's
 * signal sends `tasks/cancel`. A synchronous `input_required` answer throws
 * {@link MCPInputRequiredUnsupportedError}.
 */
export async function fromMcpEndpointTools(options: FromMcpEndpointToolsOptions): Promise<Tool[]> {
  const delay = options.delay ?? defaultDelay;
  let nextId = 0;

  const send = async (
    method: string,
    params: Record<string, unknown>,
    capabilities: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    nextId += 1;
    const name = typeof params['name'] === 'string' ? params['name'] : params['taskId'];
    const response = await options.fetch(String(options.url), {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-method': method,
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
        ...(typeof name === 'string' ? { 'mcp-name': name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: nextId,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientInfo': options.clientInfo ?? DEFAULT_CLIENT_INFO,
            'io.modelcontextprotocol/clientCapabilities': capabilities,
          },
        },
      }),
      ...(signal ? { signal } : {}),
    });
    const message = await readJsonRpcResponse(response);
    if (message.error) {
      throw new MCPTaskClientError(
        `MCP ${method} failed with JSON-RPC error ${message.error.code}: ${message.error.message}`,
        { code: message.error.code },
      );
    }
    return message.result ?? {};
  };

  const mcpTools: MCPToolSource[] = [];
  let cursor: string | undefined;
  do {
    const page = await send('tools/list', cursor === undefined ? {} : { cursor }, {});
    mcpTools.push(...((page['tools'] ?? []) as MCPToolSource[]));
    cursor = typeof page['nextCursor'] === 'string' ? page['nextCursor'] : undefined;
  } while (cursor !== undefined);

  return fromMcpTools(mcpTools, {
    ...(options.formatResult ? { formatResult: options.formatResult } : {}),
    ...(options.progress !== undefined ? { progress: options.progress } : {}),
    ...(options.serverId !== undefined ? { serverId: options.serverId } : {}),
    callTool: (request, callOptions) =>
      callEndpointTool(request, callOptions?.context, callOptions?.signal),
  });

  async function callEndpointTool(
    request: { name: string; arguments?: Record<string, unknown> },
    context: ToolContext | undefined,
    signal: AbortSignal | undefined,
  ): Promise<CallToolResult> {
    const capabilities = {
      extensions: { [MCP_TASKS_EXTENSION]: {} },
      ...(context?.elicit ? { elicitation: {} } : {}),
    };
    const answer = (await send('tools/call', request, capabilities, signal)) as WireTask &
      CallToolResult;
    if (answer.resultType === 'input_required') {
      throw new MCPInputRequiredUnsupportedError(request.name);
    }
    if (answer.resultType !== 'task' || !answer.taskId) return answer;

    const taskId = answer.taskId;
    try {
      return await pollMcpTask(request.name, answer, capabilities, context, signal);
    } catch (error) {
      if (signal?.aborted) {
        await send('tasks/cancel', { taskId }, capabilities).catch(() => undefined);
      }
      throw error;
    }
  }

  async function pollMcpTask(
    toolName: string,
    handle: WireTask,
    capabilities: Record<string, unknown>,
    context: ToolContext | undefined,
    signal: AbortSignal | undefined,
  ): Promise<CallToolResult> {
    const taskId = handle.taskId!;
    let task = handle;
    let lastMessage: string | undefined;
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      if (task.statusMessage !== undefined && task.statusMessage !== lastMessage) {
        lastMessage = task.statusMessage;
        context?.progress({ message: lastMessage });
      }
      if (task.status === 'completed') return task.result ?? { content: [] };
      if (task.status === 'failed' || task.status === 'cancelled') {
        throw new MCPTaskClientError(
          `MCP task ${taskId} for "${toolName}" ended ${task.status}${
            task.error ? ` (JSON-RPC error ${task.error.code}: ${task.error.message})` : ''
          }.`,
          {
            status: task.status,
            taskId,
            ...(task.error ? { code: task.error.code } : {}),
          },
        );
      }
      if (task.status === 'input_required') {
        await answerInput(toolName, taskId, task, capabilities, context, signal);
      }
      await Promise.race([
        delay(task.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, signal),
        abortion(signal),
      ]);
      task = await send('tasks/get', { taskId }, capabilities, signal);
    }
  }

  async function answerInput(
    toolName: string,
    taskId: string,
    task: WireTask,
    capabilities: Record<string, unknown>,
    context: ToolContext | undefined,
    signal: AbortSignal | undefined,
  ) {
    const entry = Object.entries(task.inputRequests ?? {}).find(
      ([, candidate]) => candidate.method === 'elicitation/create',
    );
    const [key, requested] = entry ?? [];
    if (!context?.elicit || key === undefined || requested === undefined) {
      throw new MCPInputRequiredUnsupportedError(toolName);
    }
    // Raced against the call's signal so an abort cancels the MCP task instead of waiting for a user.
    const result = await Promise.race([
      context.elicit(
        toToolElicitationRequest(
          requested.params as Parameters<typeof toToolElicitationRequest>[0],
        ),
      ),
      abortion(signal),
    ]);
    await send(
      'tasks/update',
      { taskId, inputResponses: { [key]: toElicitResult(result) } },
      capabilities,
      signal,
    );
  }
}

/** Rejects when `signal` aborts; never resolves otherwise. */
function abortion(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    const fail = () => reject(signal.reason ?? new Error('aborted'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

type JsonRpcResponse = {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

async function readJsonRpcResponse(response: Response): Promise<JsonRpcResponse> {
  const text = await response.text();
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const events = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5)) as JsonRpcResponse & { id?: unknown });
    const final = events.findLast((event) => event.result !== undefined || event.error);
    if (!final) throw new MCPTaskClientError('MCP endpoint answered with no JSON-RPC response.');
    return final;
  }
  try {
    return JSON.parse(text) as JsonRpcResponse;
  } catch {
    throw new MCPTaskClientError(
      `MCP endpoint answered HTTP ${response.status} without a JSON-RPC response.`,
    );
  }
}
