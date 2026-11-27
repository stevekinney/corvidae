import {
  openPostgresTestDatabase,
  postgresTestDatabase,
  requireOpenedPostgresTestDatabase,
} from '@lostgradient/testing/postgres-server';
import { startWorker } from '@lostgradient/workerd-testing';
import { afterAll, beforeAll, describe } from 'bun:test';

import type {
  BatchOperation,
  ConditionalBatchCondition,
  ScanOptions,
  Storage,
  StorageCapabilities,
} from '@lostgradient/storage';
import {
  runBasicStorageContract,
  runConcurrentConditionalBatchConformance,
  runStorageCapabilityConformance,
} from '@lostgradient/storage/testing';

const entry = new URL('./workerd-fixture.ts', import.meta.url).pathname;
const database = await openPostgresTestDatabase();
let dispatchFetch: Awaited<ReturnType<typeof startWorker>>['dispatchFetch'];
let dispose: (() => Promise<void>) | undefined;

const expectedCapabilities = {
  persistence: 'remote',
  readAfterWrite: 'linearizable',
  scanConsistency: 'snapshot',
  atomicBatch: true,
  conditionalBatch: true,
  conditionalBatchDeadline: true,
  boundedRangeDelete: true,
} satisfies StorageCapabilities;

function hyperdriveUrl(url: string): string {
  if (postgresTestDatabase?.kind !== 'cluster') return url;
  const connection = new URL(url);
  connection.password = 'workerd-test';
  return connection.toString();
}

function encode(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}

function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

class WorkerStorage implements Storage {
  constructor(private readonly reportedCapabilities: StorageCapabilities) {}

  [Symbol.dispose](): void {}

  capabilities(): StorageCapabilities {
    return this.reportedCapabilities;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const value = await this.request<string | null>('/get', { key });
    return value === null ? null : decode(value);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    await this.request('/put', { key, value: encode(value) });
  }

  async delete(key: string): Promise<void> {
    await this.request('/delete', { key });
  }

  async *scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
    const response = await dispatchFetch('https://storage.test/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prefix, options }),
    });
    if (!response.ok || response.body === null)
      throw new Error(`Worker scan failed: ${await response.text()}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let remainder = '';
    try {
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        const lines = `${remainder}${decoder.decode(next.value, { stream: true })}`.split('\n');
        remainder = lines.pop()!;
        for (const line of lines) {
          const [key, value] = JSON.parse(line) as [string, string];
          yield [key, decode(value)];
        }
      }
      remainder += decoder.decode();
      if (remainder !== '') {
        const [key, value] = JSON.parse(remainder) as [string, string];
        yield [key, decode(value)];
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    await this.request('/batch', {
      operations: operations.map((operation) =>
        operation.type === 'put' ? { ...operation, value: encode(operation.value) } : operation,
      ),
    });
  }

  async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    return this.request('/conditional-batch', {
      conditions: conditions.map((condition) => ({
        ...condition,
        expectedValue: condition.expectedValue === null ? null : encode(condition.expectedValue),
      })),
      operations: operations.map((operation) =>
        operation.type === 'put' ? { ...operation, value: encode(operation.value) } : operation,
      ),
    });
  }

  reset(): Promise<void> {
    return this.request('/reset', {});
  }

  private async request<T>(path: string, body: unknown): Promise<T> {
    const response = await dispatchFetch(`https://storage.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Worker request ${path} failed: ${await response.text()}`);
    return response.json() as Promise<T>;
  }
}

describe.skipIf(database === null)('PostgresStorage through workerd Hyperdrive', () => {
  beforeAll(async () => {
    const worker = await startWorker({
      entry,
      hyperdrives: {
        HYPERDRIVE: hyperdriveUrl(requireOpenedPostgresTestDatabase(database).url),
      },
    });
    dispatchFetch = worker.dispatchFetch;
    dispose = worker.dispose;
  });

  afterAll(async () => {
    await dispose?.();
    await requireOpenedPostgresTestDatabase(database)[Symbol.asyncDispose]();
  });

  async function create(): Promise<Storage> {
    const response = await dispatchFetch('https://storage.test/capabilities', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const storage = new WorkerStorage((await response.json()) as StorageCapabilities);
    await storage.reset();
    return storage;
  }

  runStorageCapabilityConformance('PostgresStorage (workerd Hyperdrive)', {
    create,
    expected: expectedCapabilities,
  });
  runConcurrentConditionalBatchConformance('PostgresStorage (workerd Hyperdrive)', { create });
  runBasicStorageContract('PostgresStorage (workerd Hyperdrive)', { create });
});
