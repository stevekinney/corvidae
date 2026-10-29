/**
 * What the AG-UI engine-failure tests share: a storage that refuses the writes under a key prefix
 * once told to, a scripted `say` step, and a Bureau served through the AG-UI mount over a given
 * storage.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createAgent,
  type GenerateFunction,
  type ScriptedGenerateStep,
  stopWhen,
} from '@lostgradient/operative';
import { MemoryStorage, type Storage } from '@lostgradient/storage';
import { createToolbox, type Tool } from 'armorer';

import { createMemoryAssetStorage } from '../assets/storage';
import { createBureau } from '../create-bureau.ts';
import { runAgentInput, startRequest } from './ag-ui-fixtures.test-support.ts';
import { FrameReader } from './ag-ui-stream.test-support.ts';
import { createBureauHandler } from './create-bureau-handler.ts';
import type { AgentDefinitions } from '../agent-catalog';

const WRITES = new Set(['put', 'delete', 'batch', 'conditionalBatch']);

/** The keys one storage write touches. */
export function keysOf(name: string, args: readonly unknown[]): string[] {
  if (name === 'put' || name === 'delete') return [String(args[0])];
  const operations = (name === 'batch' ? args[0] : args[1]) as Array<{ key: string }> | undefined;
  return (operations ?? []).map((operation) => operation.key);
}

/** What a refused write throws unless a test names its own text. */
export const REFUSED_STORAGE_MESSAGE = 'This storage write is refused.';

/**
 * A memory storage that, once told to, refuses every write whose key starts with a prefix, or
 * every write whose keys satisfy a predicate. A refused write throws `message`, which a test
 * gives a distinctive text so it can check that the text never reaches a client.
 */
export function refusingStorage(options: { readonly message?: string } = {}) {
  const storage = new MemoryStorage();
  let refuses: ((keys: readonly string[]) => boolean) | undefined;
  let landFirst = false;
  let refused = 0;
  const proxy = new Proxy(storage, {
    get(target, property, receiver) {
      const member: unknown = Reflect.get(target, property, receiver);
      if (typeof member !== 'function') return member;
      const name = String(property);
      const call = (...args: unknown[]) =>
        (member as (...rest: unknown[]) => unknown).apply(target, args);
      if (!WRITES.has(name)) return call.bind(null);
      return async (...args: unknown[]) => {
        if (refuses?.(keysOf(name, args)) === true) {
          refused += 1;
          if (landFirst) {
            // The first matching write is applied and then reported as failed, as a storage whose
            // acknowledgement was lost does; every later one is refused outright.
            landFirst = false;
            await call(...args);
          }
          throw new Error(options.message ?? REFUSED_STORAGE_MESSAGE);
        }
        return call(...args);
      };
    },
  });
  return {
    storage: proxy as unknown as Storage,
    /** Refuse every write whose key starts with `prefix`. */
    refuseWritesUnder(prefix: string) {
      refuses = (keys) => keys.some((key) => key.startsWith(prefix));
    },
    /**
     * Refuse every write that touches a key `matches` accepts. With `landFirst`, the first such
     * write is applied before it is reported as failed.
     */
    refuseWritesMatching(
      matches: (key: string) => boolean,
      refusal: { readonly landFirst?: boolean } = {},
    ) {
      refuses = (keys) => keys.some(matches);
      landFirst = refusal.landFirst ?? false;
    },
    /** Stop refusing, so a later run on the same storage writes normally. */
    lift() {
      refuses = undefined;
    },
    /** How many writes were refused so far, those that landed before failing included. */
    refused: () => refused,
  };
}

/** A scripted model step that replies with `content` and calls no tool. */
export const say = (content: string): ScriptedGenerateStep => ({
  kind: 'respond',
  response: { content, toolCalls: [] },
});

/** A Bureau opened by {@link openBureau}, with the handler that serves its AG-UI mount. */
export type Opened = Awaited<ReturnType<typeof openBureau>>;

/**
 * Open a durable Bureau over `storage`, with one agent, `assistant`, running `generate`, and serve
 * it through the AG-UI mount without authentication.
 */
export async function openBureau(options: {
  readonly generate: GenerateFunction;
  readonly storage: Storage;
  readonly toolbox?: ReturnType<typeof createToolbox<readonly Tool[]>>;
  readonly maximumHistoryEvents?: number;
  readonly runtime?: ReturnType<typeof createManualRuntimeServices>;
}) {
  const bureau = await createBureau<AgentDefinitions>({
    assets: { storage: createMemoryAssetStorage() },
    id: 'engine-failure',
    agents: {
      assistant: createAgent({
        generate: options.generate,
        name: 'assistant',
        stopWhen: stopWhen.noToolCalls(),
      }),
      default: createAgent({ generate: options.generate, stopWhen: stopWhen.noToolCalls() }),
    },
    ...(options.toolbox === undefined ? {} : { toolbox: options.toolbox }),
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    storage: options.storage,
    durable: true,
    ...(options.maximumHistoryEvents === undefined
      ? {}
      : { durableGuardrails: { history: { maxEvents: options.maximumHistoryEvents } } }),
    onDiagnostic: () => undefined,
  });
  const handler = createBureauHandler(bureau, {
    unauthenticatedAccess: 'allow',
    publish: ['assistant'],
    agUi: {},
  });
  return { bureau, handler };
}

/** Start the thread's first run and return its stream. */
export async function startStream({ handler }: Opened) {
  return new FrameReader(
    await handler(startRequest(runAgentInput({ threadId: 'thread-1', runId: 'client-run-1' }))),
  );
}
