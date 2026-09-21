import type { RunEngine } from '@lostgradient/operative';
import { createCheckpointStore, createRunEngine, createRunWorkflow } from '@lostgradient/operative';
import type { ServerOwnedRuntime } from './server-owned-runtime.ts';
import { SHUTDOWN_FAILURE, serverOwnedRuntime } from './server-owned-runtime.ts';
export type DurableRuntime = RunEngine;
// Memoize construction so concurrent requests share one engine across module reloads.
const DURABLE_SLOT = Symbol.for('cinder.chat-room.server-owned.durable');
type DurableSlot = {
  token: symbol;
  runtime: ServerOwnedRuntime;
  module: number;
  promise: Promise<DurableRuntime>;
  unregisterTeardown: {
    current?: () => void;
  };
  retiring?: DurableSlot | undefined;
};
const GENERATION_COUNTER = Symbol.for('cinder.chat-room.server-owned.durable-generation');
const MODULE_GENERATION = (() => {
  const host = globalThis as typeof globalThis & {
    [GENERATION_COUNTER]?: number;
  };
  const next = (host[GENERATION_COUNTER] ?? 0) + 1;
  host[GENERATION_COUNTER] = next;
  return next;
})();
type DurableHost = typeof globalThis & {
  [DURABLE_SLOT]?: DurableSlot | undefined;
};
// A stale build must never erase a successor generation.
function releaseSlot(token: symbol): void {
  const host = globalThis as DurableHost;
  if (host[DURABLE_SLOT]?.token === token) host[DURABLE_SLOT] = undefined;
}
function generationOf(held: DurableSlot): number {
  return typeof held.module === 'number' ? held.module : Number.NEGATIVE_INFINITY;
}
export class UnrecognisedDurableSlotError extends Error {
  override readonly name = 'UnrecognisedDurableSlotError';
  constructor() {
    super(
      'A durable runtime slot left by an incompatible version is in memory. Restart the dev server.',
    );
  }
}
function isCurrentSlotShape(held: unknown): held is DurableSlot {
  if (typeof held !== 'object' || held === null) return false;
  const slot = held as Partial<DurableSlot>;
  return (
    typeof slot.token === 'symbol' && slot.promise instanceof Promise && slot.runtime !== undefined
  );
}
function currentDurablePromise(
  held: DurableSlot | undefined,
  runtime: ServerOwnedRuntime,
): Promise<DurableRuntime> | undefined {
  if (held === undefined || held.runtime !== runtime) return undefined;
  if (held.module === MODULE_GENERATION || generationOf(held) > MODULE_GENERATION) {
    return held.promise;
  }
  return undefined;
}

function staleRetirement(held: DurableSlot | undefined, runtime: ServerOwnedRuntime) {
  if (held === undefined || held.runtime !== runtime) return undefined;
  return async (): Promise<void> => {
    const stale = await held.promise.catch((cause: unknown) => {
      if (isRetirementFailure(cause)) throw cause;
      return undefined;
    });
    if (stale === undefined) return;
    await stale.engine.shutdown();
    held.unregisterTeardown?.current?.();
  };
}

function buildFreshRuntime(
  token: symbol,
  runtime: ServerOwnedRuntime,
  teardownHandle: { current?: () => void },
): Promise<DurableRuntime> {
  return build(token, runtime, teardownHandle).catch((cause: unknown) => {
    releaseSlot(token);
    throw cause;
  });
}

async function buildRetiredRuntime(input: {
  host: DurableHost;
  held: DurableSlot | undefined;
  retire: () => Promise<void>;
  runtime: ServerOwnedRuntime;
  teardownHandle: { current?: () => void };
  token: symbol;
}): Promise<DurableRuntime> {
  try {
    await input.retire();
  } catch (cause) {
    if (!isRetirementFailure(cause)) {
      process.stderr.write(
        `[server-owned] A stale durable engine could not be shut down during retirement: ${String(cause)}\n`,
      );
    }
    const failure = isRetirementFailure(cause) ? cause : new EngineRetirementError();
    const original = input.held === undefined ? undefined : (input.held.retiring ?? input.held);
    if (input.host[DURABLE_SLOT]?.token === input.token) input.host[DURABLE_SLOT] = original;
    throw failure;
  }
  if (serverOwnedRuntime() !== input.runtime) {
    releaseSlot(input.token);
    throw new RuntimeDisposedDuringBuildError();
  }
  return buildFreshRuntime(input.token, input.runtime, input.teardownHandle);
}

export async function durableRuntime(): Promise<DurableRuntime> {
  const host = globalThis as DurableHost;
  const runtime = serverOwnedRuntime();
  const held = host[DURABLE_SLOT];
  if (held !== undefined && !isCurrentSlotShape(held)) throw new UnrecognisedDurableSlotError();
  const current = currentDurablePromise(held, runtime);
  if (current !== undefined) return current;
  const retire = staleRetirement(held, runtime);
  const token = Symbol('server-owned-durable-build');
  const teardownHandle: { current?: () => void } = {};
  const promise =
    retire === undefined
      ? buildFreshRuntime(token, runtime, teardownHandle)
      : buildRetiredRuntime({ host, held, retire, runtime, teardownHandle, token });
  host[DURABLE_SLOT] = {
    token,
    runtime,
    module: MODULE_GENERATION,
    promise,
    unregisterTeardown: teardownHandle,
    ...(retire === undefined ? {} : { retiring: held?.retiring ?? held }),
  };
  return promise;
}
// Identify a live refusing engine across reloads, separately from failed construction.
const RETIREMENT_FAILURE = Symbol.for('cinder.chat-room.server-owned.retirement-failure');
function isRetirementFailure(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && RETIREMENT_FAILURE in cause;
}
export class EngineRetirementError extends Error {
  override readonly name = 'EngineRetirementError';
  readonly [RETIREMENT_FAILURE] = true;
  constructor() {
    super(
      'A stale durable engine could not be shut down, so its replacement was not built. The previous engine is still running.',
    );
  }
}
export class RuntimeDisposedDuringBuildError extends Error {
  readonly [SHUTDOWN_FAILURE] = true;
  override readonly name = 'RuntimeDisposedDuringBuildError';
  constructor() {
    super('The server-owned runtime was disposed while its durable engine was being built.');
  }
}
async function build(
  token: symbol,
  runtime: ServerOwnedRuntime,
  teardownHandle: {
    current?: () => void;
  },
): Promise<DurableRuntime> {
  const checkpoints = createCheckpointStore(runtime.store);
  const runWorkflow = createRunWorkflow(checkpoints);
  const race: {
    disposed: boolean;
  } = { disposed: false };
  let construction: Promise<DurableRuntime> | undefined;
  // Register before awaiting construction: disposal must await and own the engine shutdown.
  const unregisterTeardown: () => void = runtime.onDispose(async () => {
    race.disposed = true;
    try {
      const built = await construction?.catch(() => undefined);
      await built?.engine.shutdown();
    } finally {
      releaseSlot(token);
    }
  });
  teardownHandle.current = unregisterTeardown;
  let built: DurableRuntime;
  try {
    construction = createRunEngine({
      storage: runtime.storage,
      runWorkflow,
      checkpointStore: checkpoints,
      // Request-scoped providers and HTTP writers cannot be reconstructed after restart.
      resolveWorkflowServices: () => ({
        status: 'unavailable',
        reason: 'The chat-room lab binds each run to one HTTP response, which cannot be rebuilt.',
      }),
    });
    built = await construction;
  } catch (cause) {
    unregisterTeardown();
    throw cause;
  }
  // The teardown owns shutdown when construction loses the disposal race.
  if (race.disposed) {
    releaseSlot(token);
    throw new RuntimeDisposedDuringBuildError();
  }
  return built;
}
export function forgetDurableRuntime(): void {
  (globalThis as DurableHost)[DURABLE_SLOT] = undefined;
}
