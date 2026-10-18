/**
 * Shared fixtures for the management-plane tests: callers with and without
 * operator scopes, request builders for the handler's JSON-RPC and
 * Server-Sent-Events routes, and Bureaus whose runs a test can hold open.
 */
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { type GenerateFunction, stopWhen } from '@lostgradient/operative';
import {
  type AuthConfig,
  type AuthorizationScope,
  principalFromApiKey,
  type StorageConfiguration,
} from '@lostgradient/weft';
import { createTool, createToolbox, type Toolbox } from 'armorer';
import { z } from 'zod';

import { createBureau } from '../../create-bureau.ts';
import { createSqliteStorageFixture } from '../../test/storage-fixtures';
import type { Bureau } from '../../types.ts';
import { BUREAU_SCOPES } from '../bureau-scopes.ts';
import { createBureauHandler } from '../create-bureau-handler.ts';

export type Handler = (request: Request) => Promise<Response>;

/** Every caller the management tests present, by key. */
const credentials: Record<string, { subject: string; scopes: readonly AuthorizationScope[] }> = {
  'alice-key': { subject: 'alice', scopes: [] },
  'bob-key': { subject: 'bob', scopes: [] },
  'tasks-reader-key': { subject: 'tasks-reader', scopes: ['bureau.tasks:read'] },
  'tasks-writer-key': { subject: 'tasks-writer', scopes: ['bureau.tasks:write'] },
  'contexts-writer-key': { subject: 'contexts-writer', scopes: ['bureau.contexts:write'] },
  'operator-key': { subject: 'operator', scopes: [...BUREAU_SCOPES] },
};

/** The owner string a caller owns resources as. */
export const OWNER = {
  alice: 'api-key:alice',
  bob: 'api-key:bob',
} as const;

export const authentication: AuthConfig = {
  auditSink: () => undefined,
  resolveApiKeyPrincipal: async (key) => {
    const credential = credentials[key];
    return credential === undefined
      ? null
      : principalFromApiKey({ subject: credential.subject, scopes: [...credential.scopes] });
  },
};

export function as(key: string): Record<string, string> {
  return { 'X-API-Key': key };
}

export type RpcBody = {
  result?: Record<string, unknown>;
  error?: {
    code: number;
    message?: string;
    data?: Record<string, unknown> & { httpStatus?: number };
  };
};

/** One JSON-RPC call as `key`, answered with its body. */
export async function rpc(
  handler: Handler,
  method: string,
  params: unknown,
  key: string,
): Promise<RpcBody> {
  const response = await handler(
    new Request('http://localhost/jsonrpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...as(key) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  return (await response.json()) as RpcBody;
}

/** A subscription request over the generic Server-Sent-Events route. */
export function subscribeRequest(
  name: string,
  query: Record<string, string>,
  key: string,
  lastEventId?: string,
): Request {
  return new Request(
    `http://localhost/v1/subscriptions/${name}?${new URLSearchParams(query).toString()}`,
    {
      headers: {
        Accept: 'text/event-stream',
        ...as(key),
        ...(lastEventId === undefined ? {} : { 'Last-Event-ID': lastEventId }),
      },
    },
  );
}

export type SseFrame = { id?: string; event?: string; data?: unknown };

/**
 * Reads frames from a Server-Sent-Events response until the stream ends, `stop`
 * says it has enough, or `timeoutMs` passes (which fails the read rather than
 * hanging the test). The reader is cancelled either way.
 */
export async function readFrames(
  response: Response,
  options: { stop?: (frames: readonly SseFrame[]) => boolean; timeoutMs?: number } = {},
): Promise<SseFrame[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = '';
  const deadline = Date.now() + (options.timeoutMs ?? 2_000);
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error(`The stream did not finish in time: ${JSON.stringify(frames)}`);
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error(`The stream stalled: ${JSON.stringify(frames)}`)),
            remaining,
          );
        }),
      ]);
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary === -1) break;
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame: SseFrame = {};
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) frame.id = line.slice(4);
          else if (line.startsWith('event: ')) frame.event = line.slice(7);
          else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
        }
        if (frame.event !== undefined && frame.event !== 'ping') frames.push(frame);
      }
      if (options.stop?.(frames) === true) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return frames;
}

/** A generate function that parks the run until its signal aborts, then fails the step. */
export const parkingUntilAborted: GenerateFunction = ({ signal }) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

/** A generate function that finishes at once with `content`. */
export function answering(content = 'Done.'): GenerateFunction {
  return async () => ({ content, toolCalls: [] });
}

export type OpenedBureau = {
  readonly bureau: Bureau;
  readonly handler: Handler;
  dispose(): Promise<void>;
};

/** A Bureau over memory storage with a handler in front of it. */
export async function openBureau(
  options: {
    id?: string;
    generate?: GenerateFunction;
    toolbox?: Toolbox;
    humanInput?: boolean;
    storage?: StorageConfiguration;
    publish?: readonly string[];
    agents?: Parameters<typeof createBureau>[0]['agents'];
    durableHistory?: boolean;
  } = {},
): Promise<OpenedBureau> {
  const fixture =
    options.durableHistory === true
      ? createSqliteStorageFixture({ runtime: createDefaultRuntimeServices() })
      : undefined;
  const bureau = await createBureau({
    id: options.id ?? 'management-bureau',
    agents: options.agents ?? {},
    generate: options.generate ?? parkingUntilAborted,
    toolbox: options.toolbox ?? (createToolbox([]) as unknown as Toolbox),
    storage: options.storage ?? fixture?.configuration ?? { type: 'memory' },
    durableExecution: true,
    ...(options.humanInput === true ? { humanInput: true } : {}),
    stopWhen:
      options.humanInput === true
        ? stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls())
        : stopWhen.noToolCalls(),
  });
  const handler = createBureauHandler(bureau, {
    authentication,
    ...(options.publish === undefined ? {} : { publish: options.publish }),
  });
  return {
    bureau,
    handler,
    dispose: async () => {
      await bureau.dispose();
      await fixture?.dispose();
    },
  };
}

/** A tool that needs approval before it runs, and records what it was run with. */
export function approvalToolbox(charges: number[]): Toolbox {
  return createToolbox(
    [
      createTool({
        name: 'charge-card',
        version: '1.0.0',
        description: 'Charge a payment card',
        input: z.object({ cents: z.number() }),
        async execute({ cents }) {
          charges.push(cents);
          return { charged: cents };
        },
      }),
    ],
    {
      approvalSecret: 'tasks-respond-secret',
      policy: {
        beforeExecute() {
          return {
            allow: false,
            status: 'needs_approval',
            reason: 'Operator approval required',
            action: { message: 'Approve charge' },
          };
        },
      },
    },
  ) as unknown as Toolbox;
}

export const chargesOnce: GenerateFunction = async () => ({
  content: '',
  toolCalls: [{ id: 'charge-1', name: 'charge-card', arguments: { cents: 4242 } }],
});
