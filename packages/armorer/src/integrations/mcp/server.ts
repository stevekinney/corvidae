import {
  createMcpHandler,
  McpServer,
  type CreateMcpHandlerOptions,
  type Implementation,
  type McpHttpHandler,
  type McpRequestContext,
  type ServerOptions,
} from '@modelcontextprotocol/server';
import type { ServeStdioOptions, StdioServerHandle } from '@modelcontextprotocol/server/stdio';

import { createExecutionLifecycle, type ExecutionCleanupReport } from '../../execution-lifecycle';
import type { Tool } from '../../is-tool';
import { createInputRoundRegistry, type InputRoundRegistryOptions } from './input-required';
import {
  createMcpTaskRuntime,
  MCP_TASKS_EXTENSION,
  type MCPTaskOptions,
  type MCPTaskStore,
} from './tasks';
import {
  buildMcpToolDefinition,
  resolveToolConfiguration,
  type MCPToolDefinition,
  type ToMCPToolsOptions,
  type ToolboxLike,
} from './tools';

/** The MCP protocol revision `createMCP` serves first. */
export const MCP_PROTOCOL_VERSION = '2026-07-28';
/** The 2025-era revision `createMCP` also serves, statelessly. */
export const MCP_LEGACY_PROTOCOL_VERSION = '2025-11-25';

/**
 * Registers resources or prompts on each server instance `createMCP` builds.
 * Instances are built per request (HTTP) or per connection (stdio), so a
 * registrar runs many times and must only register; keep state outside it.
 * The second argument says which era the instance serves.
 */
export type MCPResourceRegistrar = (server: McpServer, context: McpRequestContext) => void;
export type MCPPromptRegistrar = (server: McpServer, context: McpRequestContext) => void;

export type CreateMCPOptions = Omit<ServerOptions, 'requestState'> & {
  serverInfo?: Implementation;
  toolConfiguration?: ToMCPToolsOptions['toolConfiguration'];
  formatResult?: ToMCPToolsOptions['formatResult'];
  resources?: MCPResourceRegistrar | MCPResourceRegistrar[];
  prompts?: MCPPromptRegistrar | MCPPromptRegistrar[];
  /** Lifetime of a 2026-07-28 input round a client has not answered yet. */
  inputRounds?: InputRoundRegistryOptions;
  /**
   * The durable store behind MCP tasks. Required when any tool opts in with
   * `taskBacked`; there is no in-memory default. One live `createMCP`
   * instance may own a store.
   */
  taskStore?: MCPTaskStore;
  /** Lifetime, poll interval, and clock of MCP tasks. */
  tasks?: MCPTaskOptions;
  /** Options for the HTTP entry, except `legacy`, which is always `'stateless'`. */
  http?: Omit<CreateMcpHandlerOptions, 'legacy'>;
};

/**
 * An MCP endpoint for a toolbox. It serves protocol revision 2026-07-28 and,
 * through the SDK's stateless legacy lane, 2025-11-25 clients — from one
 * server factory, so every era sees the same tools, resources, and prompts.
 */
export type MCPServer = {
  /**
   * Builds one SDK server instance. The HTTP and stdio entries call it per
   * request or connection; call it yourself to connect a transport of your
   * own (`await mcp.createServer().connect(transport)`), which serves the
   * 2025-era protocol. Instances built here are closed by {@link MCPServer.close}.
   */
  createServer: (context?: McpRequestContext) => McpServer;
  /** The web-standard HTTP entry (`createMcpHandler`) serving both eras. */
  handler: McpHttpHandler;
  /** Serves one HTTP request; `handler.fetch`. */
  fetch: McpHttpHandler['fetch'];
  /** Serves stdio (or a supplied stdio-shaped transport), pinning each connection's era. */
  serveStdio: (options?: ServeStdioOptions) => Promise<StdioServerHandle>;
  /** Inspects and controls request-scoped executions owned by this server. */
  executionLifecycle: ReturnType<typeof createExecutionLifecycle>;
  /** Closes admission, aborts and settles executions, and returns cleanup evidence. */
  shutdown: () => Promise<ExecutionCleanupReport>;
  /** Shuts down executions, then closes the HTTP entry, stdio entries, and directly built instances. */
  close: () => Promise<void>;
};

const DEFAULT_SERVER_INFO: Implementation = {
  name: 'toolbox',
  version: '0.0.0',
};

const LEGACY_CONTEXT: McpRequestContext = { era: 'legacy' };

/**
 * Creates an MCP endpoint from a toolbox.
 *
 * Every available toolbox tool is exposed as an MCP `tools/call` handler.
 * Execution admission, cancellation, progress, and elicitation are owned by
 * the endpoint, not by any one per-request server instance.
 */
export async function createMCP(
  toolbox: ToolboxLike,
  options: CreateMCPOptions = {},
): Promise<MCPServer> {
  const {
    serverInfo,
    toolConfiguration,
    formatResult,
    resources,
    prompts,
    inputRounds: inputRoundOptions,
    taskStore,
    tasks: taskOptions,
    http,
    ...serverOptions
  } = options;

  const availableTools =
    typeof toolbox.getAvailable === 'function' ? await toolbox.getAvailable() : toolbox.tools();
  const toolEntries = new Map<
    string,
    { tool: Tool; configuration: ReturnType<typeof resolveToolConfiguration> }
  >();
  for (const tool of availableTools) {
    toolEntries.set(tool.name, {
      tool,
      configuration: resolveToolConfiguration(tool, toolConfiguration),
    });
  }
  const taskBackedTools = [...toolEntries.values()].filter(
    ({ configuration }) => configuration.taskBacked === true,
  );
  if (taskBackedTools.length > 0 && !taskStore) {
    throw new TypeError(
      `createMCP() requires a taskStore because ${taskBackedTools
        .map(({ tool }) => `"${tool.name}"`)
        .join(', ')} opt${taskBackedTools.length === 1 ? 's' : ''} into MCP tasks.`,
    );
  }
  const executionLifecycle = createExecutionLifecycle('mcp-server');
  // A settle-write failure has no request to answer; it goes to the `onerror` of the
  // most recently built SDK server instance, or to the console when none is set.
  let latestServer: McpServer | undefined;
  const reportTaskError = (error: unknown) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (latestServer?.server.onerror) latestServer.server.onerror(failure);
    else console.error(failure);
  };
  const mcpTasks =
    taskStore && taskBackedTools.length > 0
      ? createMcpTaskRuntime({
          store: taskStore,
          ...taskOptions,
          onError: reportTaskError,
        })
      : undefined;
  const inputRounds = createInputRoundRegistry(inputRoundOptions);
  const executeTool = createToolboxExecutor(toolbox);

  const buildServer = (context: McpRequestContext): McpServer => {
    const advertiseTasks = mcpTasks !== undefined && context.era === 'modern';
    const server = new McpServer(serverInfo ?? DEFAULT_SERVER_INFO, {
      ...serverOptions,
      ...(advertiseTasks
        ? {
            capabilities: {
              ...serverOptions.capabilities,
              extensions: {
                ...serverOptions.capabilities?.extensions,
                [MCP_TASKS_EXTENSION]:
                  serverOptions.capabilities?.extensions?.[MCP_TASKS_EXTENSION] ?? {},
              },
            },
          }
        : {}),
      requestState: { verify: inputRounds.verify },
    });
    latestServer = server;
    const toolOptions: ToMCPToolsOptions = {
      ...(toolConfiguration !== undefined ? { toolConfiguration } : {}),
      ...(formatResult !== undefined ? { formatResult } : {}),
      ...(executeTool !== undefined ? { executeTool } : {}),
      clientSession: {
        clientCapabilities: () => server.server.getClientCapabilities(),
        clientInfo: () => server.server.getClientVersion(),
        protocolVersion: () => server.server.getNegotiatedProtocolVersion(),
      },
      inputRounds,
      ...(mcpTasks ? { mcpTasks } : {}),
      executionLifecycle,
    };
    for (const { tool, configuration } of toolEntries.values()) {
      const definition = buildMcpToolDefinition(tool, configuration, toolOptions);
      server.registerTool(
        tool.name,
        toRegisteredToolConfiguration(definition),
        // A task handle is the Tasks extension's alternative `tools/call` result; the
        // SDK types callbacks as `CallToolResult` only.
        definition.handler as never,
      );
    }
    if (advertiseTasks) mcpTasks.registerHandlers(server);
    applyRegistrars(server, context, resources);
    applyRegistrars(server, context, prompts);
    return server;
  };

  const handler = createMcpHandler(buildServer, { ...http, legacy: 'stateless' });
  const directInstances = new Set<McpServer>();
  const stdioHandles = new Set<StdioServerHandle>();

  let shutdownPromise: Promise<ExecutionCleanupReport> | undefined;
  let closePromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      inputRounds.clear(new Error('MCP server shut down'));
      const report = await executionLifecycle.shutdown({
        policy: 'abort',
        reason: 'MCP server shut down',
      });
      await mcpTasks?.whenIdle();
      return report;
    })();
    return shutdownPromise;
  };

  return {
    createServer(context = LEGACY_CONTEXT) {
      const server = buildServer(context);
      directInstances.add(server);
      return server;
    },
    handler,
    fetch: handler.fetch,
    async serveStdio(stdioOptions) {
      const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
      const stdioHandle = serveStdio(buildServer, stdioOptions);
      stdioHandles.add(stdioHandle);
      return stdioHandle;
    },
    executionLifecycle,
    shutdown,
    close() {
      closePromise ??= (async () => {
        await shutdown();
        await handler.close();
        await Promise.all([...stdioHandles].map((stdioHandle) => stdioHandle.close()));
        await Promise.all([...directInstances].map((server) => server.close()));
      })();
      return closePromise;
    },
  };
}

/**
 * Routes calls through the toolbox when it still owns the registered tool,
 * so toolbox policy, approval, and events apply; otherwise runs the tool
 * directly.
 */
function createToolboxExecutor(toolbox: ToolboxLike): ToMCPToolsOptions['executeTool'] {
  if (typeof toolbox.execute !== 'function' || typeof toolbox.getTool !== 'function') {
    return undefined;
  }
  const execute = toolbox.execute.bind(toolbox);
  const getTool = toolbox.getTool.bind(toolbox);
  return (tool, request) => {
    const shared = {
      signal: request.signal,
      executionId: request.executionId,
      executionContext: request.executionContext,
      ...(request.elicit ? { elicit: request.elicit } : {}),
      ...(request.traceContext !== undefined ? { traceContext: request.traceContext } : {}),
    };
    if (getTool(tool.id) === tool) {
      return execute(
        {
          ...(request.callId !== undefined ? { id: request.callId } : {}),
          name: tool.id,
          arguments: request.params ?? {},
        },
        shared,
      );
    }
    return tool.executeWith({
      params: request.params ?? {},
      ...(request.callId !== undefined ? { callId: request.callId } : {}),
      ...shared,
    });
  };
}

function toRegisteredToolConfiguration(tool: MCPToolDefinition) {
  return {
    inputSchema: tool.inputSchema,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
    ...(tool._meta !== undefined ? { _meta: tool._meta } : {}),
  };
}

function applyRegistrars(
  server: McpServer,
  context: McpRequestContext,
  registrars: MCPResourceRegistrar | MCPResourceRegistrar[] | undefined,
) {
  if (!registrars) return;
  for (const registrar of Array.isArray(registrars) ? registrars : [registrars]) {
    registrar(server, context);
  }
}
