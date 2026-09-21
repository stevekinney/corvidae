import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { DirectIdempotencyExecuteOptions } from '../../src/idempotency/with-idempotency';

export const requestContext = {
  runId: 'run-a',
  agentId: 'agent-a',
  authority: {
    tenantId: 'tenant-a',
    principalId: 'principal-a',
    ownerId: 'owner-a',
    capabilities: ['tools:execute'],
    authorizationRevision: 'authorization:1',
  },
} as const;

export function greetingSchema(): StandardSchemaV1<unknown, { name: string }> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        const name =
          typeof value === 'object' && value !== null ? Reflect.get(value, 'name') : undefined;
        if (typeof name !== 'string' || !name.trim())
          return { issues: [{ message: 'expected { name: non-empty string }' }] };
        return { value: { name: name.trim() } };
      },
    },
  };
}

export function acceptsAnySchema(): StandardSchemaV1<unknown, unknown> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        return { value };
      },
    },
  };
}

export function createTestStore() {
  const map = new Map<string, string>();
  return {
    get: async (key: string) => map.get(key) ?? null,
    set: async (key: string, value: string) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
    list: async (prefix: string) =>
      [...map.keys()].filter((key) => key.startsWith(prefix)).toSorted(),
  };
}

export async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
  const maximumAttempts = 1_000;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`waitUntil timed out after ${maximumAttempts} microtask ticks: ${description}`);
}

export function errorProperty(error: unknown, property: string): unknown {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null)
    return undefined;
  return Reflect.get(error, property);
}

export function createManualDeadlineTiming(initialNow = 0): {
  clearCount: () => number;
  fireTimeout: () => void;
  firstTimeoutScheduled: Promise<void>;
  scheduledDelays: () => readonly number[];
  setNow: (nextNow: number) => void;
  options: DirectIdempotencyExecuteOptions;
} {
  let now = initialNow;
  let nextTimerHandle = 1;
  const timerHandlers = new Map<number, () => void>();
  const delays: number[] = [];
  const clearedHandles: unknown[] = [];
  let resolveFirstTimeoutScheduled!: () => void;
  const firstTimeoutScheduled = new Promise<void>((resolve) => {
    resolveFirstTimeoutScheduled = resolve;
  });
  const scheduleTimeoutFunctionKey = 'setTimeoutFunction';
  const clearTimeoutFunctionKey = 'clearTimeoutFunction';
  return {
    clearCount: () => clearedHandles.length,
    fireTimeout: () => {
      const [handle, timerHandler] = timerHandlers.entries().next().value ?? [];
      if (typeof handle === 'number') timerHandlers.delete(handle);
      if (!timerHandler) throw new Error('Manual timeout was not scheduled');
      timerHandler();
    },
    firstTimeoutScheduled,
    scheduledDelays: () => delays,
    setNow: (nextNow) => {
      now = nextNow;
    },
    options: {
      now: () => now,
      [scheduleTimeoutFunctionKey]: (handler, milliseconds) => {
        const handle = nextTimerHandle++;
        timerHandlers.set(handle, handler);
        delays.push(milliseconds ?? 0);
        resolveFirstTimeoutScheduled();
        return handle;
      },
      [clearTimeoutFunctionKey]: (handle: unknown) => {
        clearedHandles.push(handle);
        if (typeof handle === 'number') timerHandlers.delete(handle);
      },
    },
  };
}

export { createManualRuntimeServices };
