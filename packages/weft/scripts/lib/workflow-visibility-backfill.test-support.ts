import {
  type BatchOperation,
  type ConditionalBatchCondition,
  type ScanOptions,
  type Storage,
  MemoryStorage,
} from '@lostgradient/storage';
import { encode } from '../../src/core/codec.ts';
import { KEYS } from '../../src/storage/keys.ts';

type MinimalWorkflowState = {
  id: string;
  type: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  steps: unknown[];
  attributes: Record<string, unknown>;
  tags: string[];
  eventCount: number;
  waiters: Record<string, unknown>;
  blockedSteps: Record<string, unknown>;
  pendingChildren: Record<string, unknown>;
  childWorkflows: Record<string, unknown>;
  pendingUpdates: Record<string, unknown>;
  updates: Record<string, unknown>;
  operationLeases: Record<string, unknown>;
  pendingSignals: unknown[];
  tenant?: { id: string };
  executionDeadline?: number;
};

export function makeWorkflowState(overrides: Partial<MinimalWorkflowState>): MinimalWorkflowState {
  return {
    id: 'wf-1',
    type: 'order-fulfillment',
    status: 'running',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_500,
    steps: [],
    attributes: {},
    tags: [],
    eventCount: 0,
    waiters: {},
    blockedSteps: {},
    pendingChildren: {},
    childWorkflows: {},
    pendingUpdates: {},
    updates: {},
    operationLeases: {},
    pendingSignals: [],
    ...overrides,
  };
}

export async function seedWorkflow(
  storage: MemoryStorage,
  state: MinimalWorkflowState,
): Promise<void> {
  await storage.put(KEYS.workflow(state.id), encode(state));
}

export async function collectKeys(storage: Storage, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const [key] of storage.scan(prefix)) keys.push(key);
  return keys;
}

/**
 * MemoryStorage wrapper that simulates a runtime write to a target
 * workflow the first time its conditional batch is attempted. The
 * `expectedValue` no longer matches, so the conditional batch fails —
 * exactly the racing-runtime case the conditional pre-image guards.
 */
function publishesWatermark(operations: BatchOperation[]): boolean {
  return operations.some(
    (operation) =>
      operation.type === 'put' && operation.key === KEYS.workflowVisibilityMetaVersion(),
  );
}

export class RacingStorage implements Storage {
  readonly #inner: MemoryStorage;
  readonly #raceTargets: Set<string>;
  readonly #raced: Set<string> = new Set();

  conditionalBatch: NonNullable<Storage['conditionalBatch']>;

  constructor(
    inner: MemoryStorage,
    raceTargets: Set<string>,
    private readonly beforeWatermark?: () => Promise<void>,
  ) {
    this.#inner = inner;
    this.#raceTargets = raceTargets;
    this.conditionalBatch = async (
      conditions: ConditionalBatchCondition[],
      operations: BatchOperation[],
    ): Promise<boolean> => {
      // Simulate the racing engine write by mutating the watched workflow
      // before evaluating the conditional batch — exactly the order that
      // would produce an updatedAt mismatch in production.
      for (const condition of conditions) {
        const target = condition.key.startsWith('wf:') ? condition.key.slice(3) : '';
        if (this.#raceTargets.has(target) && !this.#raced.has(target)) {
          this.#raced.add(target);
          await this.#inner.put(
            condition.key,
            encode(makeWorkflowState({ id: target, updatedAt: Date.now() })),
          );
        }
      }
      if (publishesWatermark(operations)) {
        await this.beforeWatermark?.();
      }
      return this.#inner.conditionalBatch(conditions, operations);
    };
  }

  capabilities() {
    return this.#inner.capabilities();
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.#inner.get(key);
  }
  async put(key: string, value: Uint8Array): Promise<void> {
    return this.#inner.put(key, value);
  }
  async delete(key: string): Promise<void> {
    return this.#inner.delete(key);
  }
  scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
    return this.#inner.scan(prefix, options);
  }
  async batch(operations: BatchOperation[]): Promise<void> {
    return this.#inner.batch(operations);
  }
  [Symbol.dispose](): void {
    this.#inner[Symbol.dispose]();
  }
}

/**
 * Bare-minimum Storage implementation that omits `conditionalBatch`,
 * used to assert the backfill refuses to run on backends without
 * conditional writes.
 */
export class NoConditionalBatchStorage implements Storage {
  capabilities() {
    return {
      persistence: 'ephemeral' as const,
      readAfterWrite: 'linearizable' as const,
      scanConsistency: 'snapshot' as const,
      atomicBatch: true,
      conditionalBatch: false,
      boundedRangeDelete: false,
    };
  }
  async get(): Promise<Uint8Array | null> {
    return null;
  }
  async put(): Promise<void> {
    return undefined;
  }
  async delete(): Promise<void> {
    return undefined;
  }
  async *scan(): AsyncIterable<[string, Uint8Array]> {
    // empty
  }
  async batch(): Promise<void> {
    return undefined;
  }
  [Symbol.dispose](): void {
    // nothing to dispose
  }
}
