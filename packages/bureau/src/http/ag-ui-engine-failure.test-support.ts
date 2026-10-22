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
import { MemoryStorage, type Storage } from '@lostgradient/weft';
import { createToolbox, type Tool } from 'armorer';

import { createMemoryAssetStorage } from '../assets/storage';
import { createBureau } from '../create-bureau.ts';
import { runAgentInput, startRequest } from './ag-ui-fixtures.test-support.ts';
import { FrameReader } from './ag-ui-stream.test-support.ts';
import { createBureauHandler } from './create-bureau-handler.ts';

const WRITES = new Set(['put', 'delete', 'batch', 'conditionalBatch']);

/** The keys one storage write touches. */
export function keysOf(name: string, args: readonly unknown[]): string[] {
  if (name === 'put' || name === 'delete') return [String(args[0])];
  const operations = (name === 'batch' ? args[0] : args[1]) as Array<{ key: string }> | undefined;
  return (operations ?? []).map((operation) => operation.key);
}

/** A memory storage that, once told to, refuses every write whose key starts with a prefix. */
export function refusingStorage() {
  const storage = new MemoryStorage();
  let refusedPrefix: string | undefined;
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
        if (
          refusedPrefix !== undefined &&
          keysOf(name, args).some((key) => key.startsWith(refusedPrefix!))
        ) {
          refused += 1;
          throw new Error('This storage write is refused.');
        }
        return call(...args);
      };
    },
  });
  return {
    storage: proxy as unknown as Storage,
    refuseWritesUnder(prefix: string) {
      refusedPrefix = prefix;
    },
    /** Stop refusing, so a later run on the same storage writes normally. */
    lift() {
      refusedPrefix = undefined;
    },
    refused: () => refused,
  };
}

export const say = (content: string): ScriptedGenerateStep => ({
  kind: 'respond',
  response: { content, toolCalls: [] },
});

export type Opened = Awaited<ReturnType<typeof openBureau>>;

export async function openBureau(options: {
  readonly generate: GenerateFunction;
  readonly storage: Storage;
  readonly toolbox?: ReturnType<typeof createToolbox<readonly Tool[]>>;
  readonly maximumHistoryEvents?: number;
  readonly runtime?: ReturnType<typeof createManualRuntimeServices>;
}) {
  const bureau = await createBureau({
    assets: { storage: createMemoryAssetStorage() },
    id: 'engine-failure',
    agents: {
      assistant: createAgent({
        generate: options.generate,
        name: 'assistant',
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    generate: options.generate,
    ...(options.toolbox === undefined ? {} : { toolbox: options.toolbox }),
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    storage: options.storage,
    durableExecution: true,
    ...(options.maximumHistoryEvents === undefined
      ? {}
      : { durableGuardrails: { history: { maxEvents: options.maximumHistoryEvents } } }),
    sessionPersistenceRetryDelayMilliseconds: 0,
    stopWhen: stopWhen.noToolCalls(),
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
