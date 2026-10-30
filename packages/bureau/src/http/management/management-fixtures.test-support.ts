/**
 * Shared fixtures for the management-plane tests: callers with and without
 * operator scopes, request builders for the handler's JSON-RPC and
 * Server-Sent-Events routes, and Bureaus whose runs a test can hold open.
 */
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { type GenerateFunction, stopWhen, createAgent } from '@lostgradient/operative';
import { type AuthConfig, type AuthorizationScope, principalFromApiKey } from '@lostgradient/weft';
import { type Storage, MemoryStorage } from '@lostgradient/storage';
import { HANG_GUARD_MILLISECONDS, afterAwakeTime } from '@lostgradient/testing/hang-guard';
import { createTool, createToolbox, type Toolbox } from 'armorer';
import { z } from 'zod';

import { type AssetStorage, createMemoryAssetStorage } from '../../assets/storage';
import type { AssetPolicyInput, AssetPorts } from '../../assets/types';
import { createBureau } from '../../create-bureau.ts';
import { createSqliteStorageFixture } from '../../test/storage-fixtures';
import type { Bureau, BureauHumanInputOption } from '../../types.ts';
import { BUREAU_SCOPES } from '../bureau-scopes.ts';
import { createBureauHandler } from '../create-bureau-handler.ts';
import type { AgentDefinitions } from '../../agent-catalog';

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
  'agents-reader-key': { subject: 'agents-reader', scopes: ['bureau.agents:read'] },
  'agents-writer-key': { subject: 'agents-writer', scopes: ['bureau.agents:write'] },
  'workflows-reader-key': { subject: 'workflows-reader', scopes: ['bureau.workflows:read'] },
  'workflows-writer-key': { subject: 'workflows-writer', scopes: ['bureau.workflows:write'] },
  'schedules-reader-key': { subject: 'schedules-reader', scopes: ['bureau.schedules:read'] },
  'schedules-writer-key': { subject: 'schedules-writer', scopes: ['bureau.schedules:write'] },
  'goals-reader-key': { subject: 'goals-reader', scopes: ['bureau.goals:read'] },
  'goals-writer-key': { subject: 'goals-writer', scopes: ['bureau.goals:write'] },
  'audit-reader-key': { subject: 'audit-reader', scopes: ['bureau.audit:read'] },
  'decisions-writer-key': { subject: 'decisions-writer', scopes: ['bureau.decisions:write'] },
  'diagnostics-reader-key': {
    subject: 'diagnostics-reader',
    scopes: ['bureau.diagnostics:read'],
  },
  'deployments-reader-key': {
    subject: 'deployments-reader',
    scopes: ['bureau.deployments:read'],
  },
  'deployments-writer-key': {
    subject: 'deployments-writer',
    scopes: ['bureau.deployments:write'],
  },
  // COR-1939: an owner who may create hooks (a hook observes the whole Bureau's events), and the two
  // operator scopes.
  'alice-observer-key': { subject: 'alice', scopes: ['bureau.events:observe-all'] },
  'bob-observer-key': { subject: 'bob', scopes: ['bureau.events:observe-all'] },
  'hooks-reader-key': { subject: 'hooks-reader', scopes: ['bureau.hooks:read'] },
  'hooks-writer-key': { subject: 'hooks-writer', scopes: ['bureau.hooks:write'] },
  'settings-reader-key': { subject: 'settings-reader', scopes: ['bureau.settings:read'] },
  'settings-writer-key': {
    subject: 'settings-writer',
    scopes: ['bureau.settings:read', 'bureau.settings:write'],
  },
  'alice-assets-key': {
    subject: 'alice',
    scopes: ['bureau.assets:read', 'bureau.assets:write'],
  },
  'bob-assets-key': { subject: 'bob', scopes: ['bureau.assets:read', 'bureau.assets:write'] },
  'assets-reader-key': { subject: 'assets-reader', scopes: ['bureau.assets:read'] },
  'assets-writer-key': { subject: 'assets-writer', scopes: ['bureau.assets:write'] },
  'operator-key': { subject: 'operator', scopes: [...BUREAU_SCOPES] },
  // The credential a host hands A2A clients (COR-1904): the asset scopes a file part needs, and no
  // operator scope, so it sees only what opts into A2A.
  'a2a-key': { subject: 'a2a', scopes: ['bureau.assets:read', 'bureau.assets:write'] },
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
 * Reads frames from a Server-Sent-Events response until the stream ends or `stop` says it has
 * enough. Frames are also pushed into `into` as they arrive. The reader is cancelled either way. The read has no deadline of its own beyond the
 * awake-time hang guard, which fails it rather than hanging the test: how long a stream takes to
 * deliver its frames depends on how busy the host is, so a shorter limit would fail healthy runs.
 */
export async function readFrames(
  response: Response,
  options: {
    stop?: (frames: readonly SseFrame[]) => boolean;
    /** An array the frames are pushed into as they arrive, so a test can wait for one. */
    into?: SseFrame[];
  } = {},
): Promise<SseFrame[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = options.into ?? [];
  let buffer = '';
  let hung = false;
  // Cancelling the reader ends a pending `read()` with `done`, so a stalled stream falls out below.
  const cancelGuard = afterAwakeTime(HANG_GUARD_MILLISECONDS, () => {
    hung = true;
    void reader.cancel().catch(() => undefined);
  });
  try {
    for (;;) {
      const next = await reader.read();
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
    if (hung) throw new Error(`The stream stalled: ${JSON.stringify(frames)}`);
  } finally {
    cancelGuard();
    await reader.cancel().catch(() => undefined);
  }
  return frames;
}

/**
 * Every block of a Server-Sent-Events response, in wire order, heartbeat and replay-complete
 * `ping` blocks included (unlike `readFrames`, which drops them). Reads until `stop` says it has
 * enough or the stream ends; the reader is cancelled either way.
 */
export async function readWireBlocks(
  response: Response,
  stop: (blocks: readonly WireBlock[]) => boolean = () => false,
): Promise<WireBlock[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const blocks: WireBlock[] = [];
  let buffer = '';
  try {
    while (!stop(blocks)) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      for (
        let boundary = buffer.indexOf('\n\n');
        boundary !== -1;
        boundary = buffer.indexOf('\n\n')
      ) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = block.match(/^event: (.*)$/m)?.[1];
        const data = block.match(/^data: (.*)$/m)?.[1];
        if (event !== undefined && data !== undefined) {
          blocks.push({ event, data: JSON.parse(data) as WireBlock['data'] });
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return blocks;
}

/** One block of a Server-Sent-Events response: its event name and parsed data. */
export type WireBlock = {
  event: string;
  data: Record<string, unknown> & { replayComplete?: unknown };
};

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
    humanInput?: BureauHumanInputOption;
    /** Stop a run at a tool call that needs approval, as a real host does. */
    stopAtApproval?: boolean;
    storage?: Storage;
    a2aAgents?: readonly string[];
    agents?: Parameters<typeof createBureau>[0]['agents'];
    durableHistory?: boolean;
    /** The validators durable goals may name. */
    validators?: Parameters<typeof createBureau>[0]['validators'];
    /** The managed-asset policy; every Bureau here has an asset service, as the handler requires. */
    assetPolicy?: AssetPolicyInput;
    /** The asset service's storage, for a test that reads what it holds. */
    assetStorage?: AssetStorage;
    /** The asset service's injected ports: a metadata extractor or a safety gate a test scripts. */
    assetPorts?: AssetPorts;
    /** Further `createBureau` options, such as a manual `runtime` and a `retention.tasks`. */
    bureauOptions?: Partial<Parameters<typeof createBureau>[0]>;
    /**
     * Also serve a request without a credential as the local caller (`unauthenticatedAccess:
     * 'allow'` beside the authentication, COR-1904).
     */
    localAccess?: boolean;
    /** Passed to `createBureauHandler` beside the authentication. */
    handlerOptions?: Omit<
      Parameters<typeof createBureauHandler>[1],
      'authentication' | 'unauthenticatedAccess' | 'a2aAgents'
    >;
  } = {},
): Promise<OpenedBureau> {
  const fixture =
    options.durableHistory === true
      ? createSqliteStorageFixture({ runtime: createDefaultRuntimeServices() })
      : undefined;
  // A Bureau or handler that refuses its options still leaves nothing open behind it.
  const refused = async (error: unknown, bureau?: { dispose(): Promise<void> }): Promise<never> => {
    await bureau?.dispose();
    await fixture?.dispose();
    throw error;
  };
  const bureau = await createBureau<AgentDefinitions>({
    id: options.id ?? 'management-bureau',
    agents: {
      ...options.agents,
      default: createAgent({
        generate: options.generate ?? parkingUntilAborted,
        toolbox: options.toolbox ?? (createToolbox([]) as unknown as Toolbox),
        stopWhen:
          options.humanInput !== undefined && options.humanInput !== false
            ? stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls())
            : options.stopAtApproval === true
              ? stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls())
              : stopWhen.noToolCalls(),
      }),
    },
    storage: options.storage ?? fixture?.storage ?? new MemoryStorage(),
    durable: true,
    assets: {
      storage: options.assetStorage ?? createMemoryAssetStorage(),
      ...(options.assetPolicy === undefined ? {} : { policy: options.assetPolicy }),
      ...(options.assetPorts === undefined ? {} : { ports: options.assetPorts }),
    },
    ...(options.validators === undefined ? {} : { validators: options.validators }),
    ...(options.humanInput === undefined || options.humanInput === false
      ? {}
      : { humanInput: options.humanInput }),
    ...options.bureauOptions,
  }).catch((error: unknown) => refused(error));
  let handler: ReturnType<typeof createBureauHandler>;
  try {
    handler = createBureauHandler(bureau, {
      authentication,
      ...(options.localAccess === true ? { unauthenticatedAccess: 'allow' as const } : {}),
      ...(options.a2aAgents === undefined ? {} : { a2aAgents: options.a2aAgents }),
      ...options.handlerOptions,
    });
  } catch (error) {
    return refused(error, bureau);
  }
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
