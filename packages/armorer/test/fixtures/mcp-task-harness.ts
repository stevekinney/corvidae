import { z } from 'zod';

import {
  MCP_PROTOCOL_VERSION,
  type MCPServer,
  type MCPTaskStore,
} from '../../src/integrations/mcp';

/** The extension identifier and the capabilities a declaring client sends. */
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
export const TASKS_CAPABILITIES = { extensions: { [TASKS_EXTENSION]: {} } };

export function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

/** An in-memory {@link MCPTaskStore} whose `conditionalBatch` calls can be held or made to fail. */
export type StoreDouble = MCPTaskStore & {
  values: Map<string, string>;
  /** Number of `conditionalBatch` calls so far. */
  batchCount: number;
  /** Holds the `nth` (1-based) `conditionalBatch` until `until` resolves. */
  hold(nth: number, until: Promise<void>): void;
  /** Makes the `nth` `conditionalBatch` reject or return `false` without applying it. */
  fault(nth: number, kind: 'reject' | 'false'): void;
};

export function createStoreDouble(): StoreDouble {
  const values = new Map<string, string>();
  const holds = new Map<number, Promise<void>>();
  const faults = new Map<number, 'reject' | 'false'>();
  const store: StoreDouble = {
    values,
    batchCount: 0,
    hold: (nth, until) => void holds.set(nth, until),
    fault: (nth, kind) => void faults.set(nth, kind),
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
    async list(prefix) {
      return [...values.keys()].filter((key) => key.startsWith(prefix));
    },
    async conditionalBatch(conditions, operations) {
      store.batchCount += 1;
      const nth = store.batchCount;
      await holds.get(nth);
      const fault = faults.get(nth);
      if (fault === 'reject') throw new Error('store unavailable');
      if (fault === 'false') return false;
      for (const condition of conditions) {
        if ((values.get(condition.key) ?? null) !== condition.expectedValue) return false;
      }
      for (const operation of operations) {
        if (operation.type === 'delete') values.delete(operation.key);
        else values.set(operation.key, operation.value);
      }
      return true;
    },
  };
  return store;
}

export type WireResponse = {
  result?: Record<string, unknown> | undefined;
  error?: { code: number; message: string } | undefined;
};

const WireResponseSchema = z.looseObject({
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.looseObject({ code: z.number(), message: z.string() }).optional(),
});

let nextId = 0;

/**
 * Posts one 2026-07-28 JSON-RPC request with the per-request envelope the SDK
 * client sends. `init.authInfo` is handed to `mcp.fetch`.
 */
export async function rpc(
  mcp: MCPServer,
  method: string,
  params: Record<string, unknown>,
  capabilities: Record<string, unknown> = TASKS_CAPABILITIES,
  init: { authInfo?: { token: string; clientId: string; scopes: string[] } } = {},
): Promise<WireResponse> {
  nextId += 1;
  const response = await mcp.fetch(
    new Request('http://armorer.test/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-method': method,
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
        // The HTTP entry routes on Mcp-Name: the tool name, or a task's id.
        ...(typeof params['name'] === 'string' ? { 'mcp-name': params['name'] } : {}),
        ...(typeof params['taskId'] === 'string' ? { 'mcp-name': params['taskId'] } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: nextId,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientInfo': { name: 'armorer-tests', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': capabilities,
          },
        },
      }),
    }),
    init.authInfo ? { authInfo: init.authInfo } : undefined,
  );
  return WireResponseSchema.parse(await response.json());
}
