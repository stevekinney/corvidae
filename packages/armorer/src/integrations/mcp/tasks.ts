import {
  inputResponse,
  ProtocolError,
  ProtocolErrorCode,
  type InputRequests,
  type McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { ExecutionAbortSource } from '../../execution-lifecycle';
import type { SuspendableExecution } from './input-required';
import { deliverInputResponse, MCP_ELICITATION_INPUT_KEY } from './input-required';

/**
 * Server side of the MCP Tasks extension (`io.modelcontextprotocol/tasks`,
 * protocol revision 2026-07-28).
 *
 * "MCP task" always means the extension's task: a durable record a client
 * polls with `tasks/get`. It is unrelated to Armorer's own execution tasks
 * (`createExecutionTask`).
 *
 * A tool that opts in runs detached from the `tools/call` request that
 * started it. The request answers with a handle once the record has been
 * committed to the {@link MCPTaskStore}; the execution then runs in this
 * process and settles the record. Executions are in process, so one live
 * `createMCP` instance may own a store: a non-terminal record owned by a
 * different instance is an orphan, which no instance can finish, cancel, or
 * answer, and is recorded as `failed` the first time any `tasks/*` method
 * reads it.
 */

/** The extension identifier a client declares and a server advertises. */
export const MCP_TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

/** The `version` every persisted {@link MCPTaskRecord} carries. */
export const MCP_TASK_RECORD_VERSION = 1;

/** Default lifetime of an MCP task, counted from creation. */
export const DEFAULT_MCP_TASK_TTL_MS = 10 * 60 * 1000;

/** Default `pollIntervalMs` an MCP task advertises to clients. */
export const DEFAULT_MCP_TASK_POLL_INTERVAL_MS = 1_000;

/** Key prefix of every persisted MCP task record: `mcp-task:<taskId>`. */
export const MCP_TASK_KEY_PREFIX = 'mcp-task:';

/** The precondition of an {@link MCPTaskStore.conditionalBatch}. */
export type MCPTaskStoreCondition = {
  key: string;
  /** The value the key must currently hold, or `null` to require it to be absent. */
  expectedValue: string | null;
};

/** A mutation applied by {@link MCPTaskStore.conditionalBatch}. */
export type MCPTaskStoreOperation =
  | { type: 'set'; key: string; value: string }
  | { type: 'put'; key: string; value: string }
  | { type: 'delete'; key: string };

/**
 * The durable text store behind MCP tasks. It is a subset of Weft's
 * `ConditionalTextValueStore`, so `textValueStore(...)` is assignable to it
 * with no adapter. Armorer supplies no default: a host passes one to
 * `createMCP({ taskStore })`.
 */
export type MCPTaskStore = {
  /** Reads the text at `key`, or `null` when absent. */
  get(key: string): Promise<string | null>;
  /** Writes `value` at `key`. */
  set(key: string, value: string): Promise<void>;
  /** Deletes `key`; a no-op when absent. */
  delete(key: string): Promise<void>;
  /** Lists the keys under `prefix`. */
  list(prefix: string): Promise<string[]>;
  /**
   * Applies `operations` only if every condition holds, atomically, and
   * resolves `false` when one does not.
   */
  conditionalBatch(
    conditions: MCPTaskStoreCondition[],
    operations: MCPTaskStoreOperation[],
  ): Promise<boolean>;
};

/** The five statuses the Tasks extension defines. */
export type MCPTaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

/** The JSON-RPC error a `failed` MCP task carries. */
export type MCPTaskError = { code: number; message: string };

/**
 * One persisted MCP task, JSON-encoded at `mcp-task:<taskId>`. This is a
 * persisted format: `version` is 1, and a record with any other version
 * makes every `tasks/*` method answer `-32603`.
 */
export type MCPTaskRecord = {
  /** Always {@link MCP_TASK_RECORD_VERSION}. */
  version: 1;
  /** The cryptographically random identifier, which clients treat as a bearer token. */
  taskId: string;
  /** Random per `createMCP` instance; a different owner on a non-terminal record marks an orphan. */
  ownerId: string;
  /** The authenticated `clientId` that created the MCP task, or the empty string. */
  clientId: string;
  /** The tool the MCP task runs. */
  toolName: string;
  status: MCPTaskStatus;
  /** The latest `context.progress` message, when the tool reported one. */
  statusMessage?: string;
  /** ISO 8601 creation time. */
  createdAt: string;
  /** ISO 8601 time of the last write. */
  lastUpdatedAt: string;
  /** Lifetime from creation in milliseconds. */
  ttlMs: number;
  /** The poll interval advertised to clients. */
  pollIntervalMs: number;
  /** The wire `CallToolResult` of a `completed` MCP task, `resultType: "complete"` included. */
  result?: Record<string, unknown>;
  /** The JSON-RPC error of a `failed` MCP task. */
  error?: MCPTaskError;
  /** The outstanding input requests of an `input_required` MCP task. */
  inputRequests?: InputRequests;
};

/** Thrown when a persisted record's `version` is not {@link MCP_TASK_RECORD_VERSION}. */
export class MCPTaskRecordVersionError extends Error {
  constructor(
    readonly taskId: string,
    readonly version: unknown,
  ) {
    super(`MCP task "${taskId}" has unsupported record version ${String(version)}.`);
    this.name = 'MCPTaskRecordVersionError';
  }
}

/** Options for the MCP task runtime of `createMCP`. */
export type MCPTaskOptions = {
  /** Lifetime of an MCP task from creation. Defaults to ten minutes. */
  ttlMs?: number;
  /** Poll interval advertised to clients. Defaults to one second. */
  pollIntervalMs?: number;
  /** Clock for `createdAt` and `lastUpdatedAt`, in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
};

/** The flattened `CreateTaskResult` a `tools/call` answers with. */
export type MCPCreateTaskResult = {
  resultType: 'task';
  taskId: string;
  status: MCPTaskStatus;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number;
  pollIntervalMs: number;
};

/** What the runtime needs from one tool execution to drive it as an MCP task. */
export type MCPTaskExecution = {
  /** The `tools/call` request context a creation failure is reported against. */
  context: ServerContext;
  toolName: string;
  clientId: string;
  execution: SuspendableExecution;
  signal: AbortSignal;
  abort: (reason: unknown) => void;
  abortSource: () => ExecutionAbortSource | undefined;
  /** Subscribes to the execution's progress; the returned function unsubscribes. */
  subscribeProgress: (listener: (message: string) => void) => () => void;
};

type LiveMcpTask = {
  taskId: string;
  clientId: string;
  execution: SuspendableExecution;
  abort: (reason: unknown) => void;
  expired: boolean;
  abortWrite: Promise<unknown> | undefined;
};

const MAXIMUM_WRITE_ATTEMPTS = 100;
const UNKNOWN_MCP_TASK_MESSAGE = 'Unknown, expired, or inaccessible MCP task.';

const taskParameters = z.looseObject({ taskId: z.string() });
const wireResult = z.looseObject({});

function isTerminal(status: MCPTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function unknownMcpTask(): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, UNKNOWN_MCP_TASK_MESSAGE);
}

/**
 * Creates the MCP task runtime for one `createMCP` instance: the record
 * store protocol, the live executions this instance owns, and the three
 * `tasks/*` request handlers.
 */
export function createMcpTaskRuntime(options: {
  store: MCPTaskStore;
  ttlMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  onError: (error: unknown) => void;
}) {
  const { store, onError } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_MCP_TASK_TTL_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_MCP_TASK_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const ownerId = globalThis.crypto.randomUUID();
  const live = new Map<string, LiveMcpTask>();
  const background = new Set<Promise<unknown>>();

  const track = <T>(work: Promise<T>): Promise<T> => {
    background.add(work);
    const forget = () => background.delete(work);
    work.then(forget, forget);
    return work;
  };
  const report = (work: Promise<unknown>) => track(work.catch(onError));
  const timestamp = () => new Date(now()).toISOString();
  const keyOf = (taskId: string) => `${MCP_TASK_KEY_PREFIX}${taskId}`;

  const parse = (taskId: string, raw: string): MCPTaskRecord => {
    const record = JSON.parse(raw) as MCPTaskRecord;
    if (record.version !== MCP_TASK_RECORD_VERSION) {
      throw new MCPTaskRecordVersionError(taskId, record.version);
    }
    return record;
  };

  /** Replaces `raw` with `next` iff the stored value is still `raw`. */
  const compareAndSet = (taskId: string, raw: string, next: MCPTaskRecord) =>
    store.conditionalBatch(
      [{ key: keyOf(taskId), expectedValue: raw }],
      [{ type: 'set', key: keyOf(taskId), value: JSON.stringify(next) }],
    );

  /**
   * Applies `change` to the record by compare-and-set on the value last
   * read. A lost race re-reads and retries while the record is present,
   * non-terminal, and owned by this instance; otherwise it stops, so a
   * terminal write is final and a progress write cannot make it lose.
   */
  const mutate = async (
    taskId: string,
    change: (record: MCPTaskRecord) => MCPTaskRecord | undefined,
  ): Promise<MCPTaskRecord | undefined> => {
    for (let attempt = 0; attempt < MAXIMUM_WRITE_ATTEMPTS; attempt += 1) {
      const raw = await store.get(keyOf(taskId));
      if (raw === null) return undefined;
      const record = parse(taskId, raw);
      if (isTerminal(record.status) || record.ownerId !== ownerId) return undefined;
      const changed = change(record);
      if (!changed) return undefined;
      const next = { ...changed, lastUpdatedAt: timestamp() };
      if (await compareAndSet(taskId, raw, next)) return next;
    }
    throw new Error(`MCP task "${taskId}" kept losing its compare-and-set write.`);
  };

  const finish =
    (
      status: 'completed' | 'failed' | 'cancelled',
      extra: Pick<MCPTaskRecord, 'result' | 'error'> = {},
    ) =>
    (record: MCPTaskRecord): MCPTaskRecord => {
      const { inputRequests: _inputRequests, ...rest } = record;
      return { ...rest, status, ...extra };
    };

  const interrupted = (message: string): MCPTaskError => ({
    code: ProtocolErrorCode.InternalError,
    message,
  });

  /** Reads a record for a request, recording an orphan as `failed` first. */
  const read = async (taskId: string, clientId: string): Promise<MCPTaskRecord> => {
    for (let attempt = 0; attempt < MAXIMUM_WRITE_ATTEMPTS; attempt += 1) {
      const raw = await store.get(keyOf(taskId));
      if (raw === null) throw unknownMcpTask();
      const record = parse(taskId, raw);
      if (record.clientId !== clientId) throw unknownMcpTask();
      if (isTerminal(record.status) || record.ownerId === ownerId) return record;
      const failed: MCPTaskRecord = {
        ...finish('failed', {
          error: interrupted(
            'The MCP task was interrupted: the server instance running it is gone.',
          ),
        })(record),
        lastUpdatedAt: timestamp(),
      };
      if (await compareAndSet(taskId, raw, failed)) return failed;
    }
    throw new Error(`MCP task "${taskId}" kept losing its recovery write.`);
  };

  const toWire = (record: MCPTaskRecord): Record<string, unknown> => ({
    taskId: record.taskId,
    status: record.status,
    ...(record.statusMessage !== undefined ? { statusMessage: record.statusMessage } : {}),
    createdAt: record.createdAt,
    lastUpdatedAt: record.lastUpdatedAt,
    ttlMs: record.ttlMs,
    pollIntervalMs: record.pollIntervalMs,
    ...(record.status === 'completed' && record.result ? { result: record.result } : {}),
    ...(record.status === 'failed' && record.error ? { error: record.error } : {}),
    ...(record.status === 'input_required' && record.inputRequests
      ? { inputRequests: record.inputRequests }
      : {}),
  });

  /**
   * The SDK answers any error a tool callback throws with an `isError`
   * result, so a creation failure is remembered against its request context
   * and rethrown as a JSON-RPC error by {@link interceptCreationFailures}.
   */
  const creationFailures = new WeakMap<object, ProtocolError>();
  const creationFailure = (context: ServerContext, message: string): ProtocolError => {
    const failure = new ProtocolError(ProtocolErrorCode.InternalError, message);
    creationFailures.set(context, failure);
    return failure;
  };

  const clientIdOf = (context: ServerContext): string => context.http?.authInfo?.clientId ?? '';

  /** Surfaces a record-version failure as the JSON-RPC internal error it is. */
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof MCPTaskRecordVersionError) {
        throw new ProtocolError(ProtocolErrorCode.InternalError, error.message);
      }
      throw error;
    }
  };

  const runDriver = async (entry: LiveMcpTask, request: MCPTaskExecution) => {
    const { taskId, execution } = entry;
    try {
      for (;;) {
        const outcome = await execution.nextOutcome();
        if (request.signal.aborted) {
          await entry.abortWrite;
          return;
        }
        if (outcome.kind === 'complete') {
          const result: Record<string, unknown> = { ...outcome.result, resultType: 'complete' };
          await mutate(taskId, finish('completed', { result }));
          return;
        }
        const inputRequests: InputRequests = {
          [MCP_ELICITATION_INPUT_KEY]: outcome.pending.inputRequest,
        };
        await mutate(taskId, (record) => ({ ...record, status: 'input_required', inputRequests }));
      }
    } catch (error) {
      onError(error);
    } finally {
      live.delete(taskId);
    }
  };

  const abortOutcome = (entry: LiveMcpTask, request: MCPTaskExecution) => {
    if (entry.expired) return;
    const source = request.abortSource();
    entry.abortWrite = mutate(
      entry.taskId,
      source === 'caller'
        ? finish('cancelled')
        : finish('failed', {
            error: interrupted('The MCP task was aborted by a server shutdown.'),
          }),
    ).catch(onError);
  };

  return {
    /** Random per instance; marks which records this instance may finish. */
    ownerId,
    ttlMs,
    pollIntervalMs,
    /**
     * Commits a new `working` record and, only after the commit, starts
     * driving the execution. Rejects with a JSON-RPC internal error when the
     * store fails or refuses the create, in which case nothing started.
     */
    async begin(request: MCPTaskExecution): Promise<MCPCreateTaskResult> {
      const taskId = globalThis.crypto.randomUUID();
      const stamp = timestamp();
      const record: MCPTaskRecord = {
        version: MCP_TASK_RECORD_VERSION,
        taskId,
        ownerId,
        clientId: request.clientId,
        toolName: request.toolName,
        status: 'working',
        createdAt: stamp,
        lastUpdatedAt: stamp,
        ttlMs,
        pollIntervalMs,
      };
      let committed = false;
      try {
        committed = await store.conditionalBatch(
          [{ key: keyOf(taskId), expectedValue: null }],
          [{ type: 'set', key: keyOf(taskId), value: JSON.stringify(record) }],
        );
      } catch (error) {
        throw creationFailure(
          request.context,
          `Could not persist the MCP task: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!committed) {
        throw creationFailure(
          request.context,
          'Could not persist the MCP task: the store refused the create.',
        );
      }

      const entry: LiveMcpTask = {
        taskId,
        clientId: request.clientId,
        execution: request.execution,
        abort: request.abort,
        expired: false,
        abortWrite: undefined,
      };
      live.set(taskId, entry);
      const unsubscribe = request.subscribeProgress((message) => {
        report(mutate(taskId, (current) => ({ ...current, statusMessage: message })));
      });
      const timer = setTimeout(() => {
        entry.expired = true;
        request.abort(new Error('The MCP task expired.'));
        report(store.delete(keyOf(taskId)));
      }, ttlMs);
      (timer as { unref?: () => void }).unref?.();
      request.signal.addEventListener('abort', () => abortOutcome(entry, request), { once: true });
      if (request.signal.aborted) abortOutcome(entry, request);
      track(runDriver(entry, request)).finally(() => {
        clearTimeout(timer);
        unsubscribe();
      });

      return {
        resultType: 'task',
        taskId,
        status: 'working',
        createdAt: stamp,
        lastUpdatedAt: stamp,
        ttlMs,
        pollIntervalMs,
      };
    },
    /** Registers `tasks/get`, `tasks/update`, and `tasks/cancel` on a 2026-07-28 server. */
    registerHandlers(server: McpServer) {
      interceptCreationFailures(server, creationFailures);
      server.server.setRequestHandler(
        'tasks/get',
        { params: taskParameters, result: wireResult },
        ({ taskId }, context) =>
          guarded(async () => toWire(await read(taskId, clientIdOf(context)))),
      );
      server.server.setRequestHandler(
        'tasks/cancel',
        { params: taskParameters, result: wireResult },
        ({ taskId }, context) =>
          guarded(async () => {
            const record = await read(taskId, clientIdOf(context));
            const entry = live.get(taskId);
            if (isTerminal(record.status) || !entry) return {};
            await mutate(taskId, finish('cancelled'));
            entry.abort(new Error('The MCP task was cancelled.'));
            return {};
          }),
      );
      server.server.setRequestHandler(
        'tasks/update',
        {
          params: taskParameters,
          result: wireResult,
        },
        ({ taskId }, context) =>
          guarded(async () => {
            const record = await read(taskId, clientIdOf(context));
            const entry = live.get(taskId);
            if (record.status !== 'input_required' || !entry) return {};
            // The SDK lifts `inputResponses` out of the params onto the request context.
            const inputResponses = context.mcpReq.inputResponses;
            if (inputResponse(inputResponses, MCP_ELICITATION_INPUT_KEY).kind === 'missing') {
              return {};
            }
            const resumed = await mutate(taskId, (current) => {
              if (current.status !== 'input_required') return undefined;
              const { inputRequests: _inputRequests, ...rest } = current;
              return { ...rest, status: 'working' };
            });
            if (resumed) deliverInputResponse(entry.execution, inputResponses);
            return {};
          }),
      );
    },
    /** Resolves once every driver and background write this instance started has settled. */
    async whenIdle(): Promise<void> {
      while (background.size > 0) {
        await Promise.allSettled([...background]);
      }
    },
  };
}

/** The MCP task runtime `createMCP` hands to its tool handlers. */
export type McpTaskRuntime = ReturnType<typeof createMcpTaskRuntime>;

/** True when a request's client declared the Tasks extension. */
export function clientDeclaresMcpTasks(capabilities: object | undefined): boolean {
  const extensions = (capabilities as { extensions?: Record<string, unknown> } | undefined)
    ?.extensions;
  return extensions?.[MCP_TASKS_EXTENSION] !== undefined;
}

type RequestHandler = (request: unknown, context: ServerContext) => Promise<unknown>;

/**
 * Re-registers the SDK's `tools/call` handler so a creation failure recorded
 * for a request answers with its JSON-RPC error instead of the `isError`
 * result the SDK's own `catch` makes of it. The SDK exposes no hook for this,
 * so the stored handler is read through its protected accessor; construction
 * fails loudly if a later SDK drops it.
 */
function interceptCreationFailures(server: McpServer, failures: WeakMap<object, ProtocolError>) {
  const protocol = server.server as unknown as {
    _getRequestHandler?: (method: string) => RequestHandler | undefined;
  };
  const inner = protocol._getRequestHandler?.('tools/call');
  if (!inner) {
    throw new TypeError('The MCP SDK no longer exposes the tools/call handler MCP tasks wrap.');
  }
  server.server.removeRequestHandler('tools/call');
  server.server.setRequestHandler('tools/call', async (request, context) => {
    const result = await inner(request, context);
    const failure = failures.get(context);
    if (failure) throw failure;
    return result as never;
  });
}
