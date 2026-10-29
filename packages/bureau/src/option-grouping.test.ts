/**
 * COR-1701 — `BureauOptions` groups the five retention windows under `retention`, renames the
 * durable options `durable` and `maintenance`, makes `agents` optional, and refuses a `memory`
 * over a `storage` that has no explicit `id`.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createGovernedMemory,
  createInMemoryMemoryRecordStorage,
  createMemoryGovernanceLedger,
  createMemoryGovernancePolicy,
  createMockEmbedder,
  type GovernedMemory,
} from '@lostgradient/memory';
import { MemoryStorage } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';

import { BureauError, createBureau } from './create-bureau';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import type { Bureau } from './types';

const runtime = createManualRuntimeServices({ identifierSeed: 'option-grouping' });

const bureaus: Bureau<Record<never, never>>[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

function governedMemory(): GovernedMemory {
  return createGovernedMemory({
    storage: createInMemoryMemoryRecordStorage({ now: () => runtime.clock.now() }),
    ledger: createMemoryGovernanceLedger(new MemoryStorage()),
    embedder: createMockEmbedder(64),
    policy: createMemoryGovernancePolicy({ revision: 'governance:option-grouping' }),
    runtime,
  });
}

describe('memory over storage needs an explicit id', () => {
  it('refuses memory over sqlite storage without an id', async () => {
    const fixture = createSqliteStorageFixture({ runtime });
    try {
      const failure = await rejectionOf(
        createBureau({ storage: fixture.configuration, memory: governedMemory() }),
      );
      expect(failure).toBeInstanceOf(BureauError);
      expect((failure as BureauError).code).toBe('BAD_REQUEST');
      expect((failure as BureauError).message).toContain('options.id');
    } finally {
      await fixture.dispose();
    }
  });

  it('resolves the same options once an id is given', async () => {
    const fixture = createSqliteStorageFixture({ runtime });
    try {
      const bureau = await createBureau({
        id: 'option-grouping-bureau',
        storage: fixture.configuration,
        memory: governedMemory(),
      });
      bureaus.push(bureau);
      expect(bureau.id).toBe('option-grouping-bureau');
    } finally {
      await fixture.dispose();
    }
  });

  it('refuses memory over in-memory storage without an id, as the handler does for any storage', async () => {
    const failure = await rejectionOf(
      createBureau({ storage: new MemoryStorage(), memory: governedMemory() }),
    );
    expect((failure as BureauError).code).toBe('BAD_REQUEST');
  });

  it('accepts memory without storage and without an id', async () => {
    const bureau = await createBureau({ memory: governedMemory() });
    bureaus.push(bureau);
    expect(bureau.internals.hasExplicitId).toBe(false);
  });
});

describe('retention.receipts', () => {
  it.each(['forever', 0, -1, 1.5, null])('refuses %p with BAD_REQUEST', async (receipts) => {
    const failure = await rejectionOf(
      createBureau({
        retention: { receipts: receipts as unknown as { olderThan: number } },
      }),
    );
    expect(failure).toBeInstanceOf(BureauError);
    expect((failure as BureauError).code).toBe('BAD_REQUEST');
    expect((failure as BureauError).message).toContain('options.retention.receipts');
  });

  it('accepts an olderThan window', async () => {
    const bureau = await createBureau({ retention: { receipts: { olderThan: 86_400_000 } } });
    bureaus.push(bureau);
    expect(bureau.id).toBeString();
  });
});

describe('retention windows are validated under their new names', () => {
  it.each([
    ['audit', { audit: { olderThan: Number.NaN } }, 'options.retention.audit.olderThan'],
    ['events', { events: { olderThan: -1 } }, 'options.retention.events.olderThan'],
    ['tasks', { tasks: { olderThan: -1 } }, 'options.retention.tasks.olderThan'],
    ['checkpoints', { checkpoints: { keepLast: 0 } }, 'options.retention.checkpoints.keepLast'],
  ] as const)('refuses a bad %s window', async (_name, retention, message) => {
    const failure = await rejectionOf(createBureau({ retention }));
    expect((failure as BureauError).code).toBe('BAD_REQUEST');
    expect((failure as BureauError).message).toContain(message);
  });
});

describe('retention itself', () => {
  it('refuses a value that is not an object of windows', async () => {
    const failure = await rejectionOf(createBureau({ retention: 'forever' as never }));
    expect((failure as BureauError).code).toBe('BAD_REQUEST');
    expect((failure as BureauError).message).toContain('options.retention');
  });
});

describe('agents is optional', () => {
  it('resolves without any options and lists no agents', async () => {
    const bureau = await createBureau({});
    bureaus.push(bureau);
    expect(bureau.agents.names()).toEqual([]);
  });
});
