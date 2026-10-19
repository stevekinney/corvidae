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
  type Storage,
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
  'tasks-operator-key': {
    subject: 'tasks-operator',
    scopes: ['bureau.tasks:read', 'bureau.tasks:write'],
  },
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
    /** Stop a run at a tool call that needs approval, as a real host does. */
    stopAtApproval?: boolean;
    storage?: StorageConfiguration | Storage;
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
        : options.stopAtApproval === true
          ? stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls())
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

/**
 * A storage wrapper that holds the first call matching `matches` until `release()`, so a
 * test can start a second operation while the first is in the middle of its steps. Nothing
 * is held until `arm()`.
 */
export function createStorageGate(matches: (verb: string, args: readonly unknown[]) => boolean) {
  let armed = false;
  let held = false;
  const reached = Promise.withResolvers<void>();
  const open = Promise.withResolvers<void>();
  return {
    arm(): void {
      armed = true;
    },
    /** Resolves once a matching call is being held. */
    reached: reached.promise,
    release(): void {
      open.resolve();
    },
    wrap(raw: Storage): Storage {
      return new Proxy(raw, {
        get(target, property) {
          const member = Reflect.get(target, property, target) as unknown;
          if (typeof member !== 'function') return member;
          if (typeof property !== 'string') return member.bind(target);
          return (...args: unknown[]) => {
            const call = () => (member as (...a: unknown[]) => unknown).apply(target, args);
            if (!armed || held || !matches(property, args)) return call();
            held = true;
            reached.resolve();
            return open.promise.then(call);
          };
        },
      });
    },
  };
}

/**
 * A storage wrapper that lets the first call matching `matches` complete, then runs `hook`
 * before handing back its result, so a test can change the world between a read and whatever
 * the reader does with it. Nothing happens until `arm()`, and the hook runs once.
 */
export function createStorageInterleaver(
  matches: (verb: string, args: readonly unknown[]) => boolean,
  hook: () => Promise<void>,
) {
  let armed = false;
  return {
    arm(): void {
      armed = true;
    },
    wrap(raw: Storage): Storage {
      return new Proxy(raw, {
        get(target, property) {
          const member = Reflect.get(target, property, target) as unknown;
          if (typeof member !== 'function') return member;
          if (typeof property !== 'string') return member.bind(target);
          return (...args: unknown[]) => {
            const call = () => (member as (...a: unknown[]) => unknown).apply(target, args);
            if (!armed || !matches(property, args)) return call();
            armed = false;
            return Promise.resolve(call()).then(async (result) => {
              await hook();
              return result;
            });
          };
        },
      });
    },
  };
}
