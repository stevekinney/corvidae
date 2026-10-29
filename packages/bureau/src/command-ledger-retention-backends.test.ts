/**
 * COR-424 — the command ledger's expiry writes over both persistent backends.
 * A claim that replaces an expired binding deletes that binding's conflict
 * records in the same compare-and-swap, and a prune deletes an expired
 * binding with its conflict records. Time is the injected runtime clock.
 */
import { createManualRuntimeServices, type RuntimeServices } from '@lostgradient/lifecycle';
import { resolveStorage } from '@lostgradient/weft';
import { textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import {
  type CommandLedger,
  type CommandLedgerIdentity,
  createCommandLedger,
  RUN_CREATION_OPERATION_VERSION,
} from './command-ledger';
import {
  type BureauStorageFixture,
  createLmdbStorageFixture,
  createSqliteStorageFixture,
} from './test/storage-fixtures';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';

const ORIGIN = '2026-10-13T00:00:00.000Z';
const ORIGIN_MS = Date.parse(ORIGIN);
const DAY_MS = 86_400_000;
const CONFLICT_PREFIX = 'command-ledger:v1:conflict:';

const IDENTITY: CommandLedgerIdentity = {
  callerId: 'alice',
  target: 'bureau',
  requestId: 'request-1',
  operationVersion: RUN_CREATION_OPERATION_VERSION,
};

type FixtureFactory = (runtime: RuntimeServices) => BureauStorageFixture;

const BACKENDS: readonly (readonly [string, FixtureFactory])[] = [
  ['sqlite', (runtime) => createSqliteStorageFixture({ runtime })],
  ['lmdb', (runtime) => createLmdbStorageFixture({ runtime })],
];

interface Scenario {
  readonly ledger: CommandLedger<{ readonly runId: string }, { readonly status: string }>;
  readonly conflictKeys: () => Promise<readonly string[]>;
  readonly setTime: (epochMilliseconds: number) => void;
}

async function withLedger(
  factory: FixtureFactory,
  body: (scenario: Scenario) => Promise<void>,
): Promise<void> {
  const runtime = createManualRuntimeServices({ origin: ORIGIN });
  const fixture = factory(runtime);
  const storage = await resolveStorage(
    fixture.storage as Parameters<typeof resolveStorage>[0],
  );
  try {
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    await body({
      ledger: createCommandLedger({
        kv,
        clock: runtime.clock,
        nextConflictId: () => runtime.identifiers.next('ledger-conflict'),
      }),
      conflictKeys: () => kv.list(CONFLICT_PREFIX),
      setTime: (epochMilliseconds) => runtime.setTime(epochMilliseconds),
    });
  } finally {
    storage[Symbol.dispose]();
    await fixture.dispose();
  }
}

/** Completes a binding for `IDENTITY` and records one conflicting attempt against it. */
async function bindingWithConflict({ ledger, conflictKeys }: Scenario): Promise<void> {
  const claimed = await ledger.claim(IDENTITY, 'digest-a', { runId: 'run-1' });
  if (claimed.outcome !== 'claimed') throw new Error('expected a fresh claim');
  await ledger.complete(claimed.entry, { status: 'completed' });
  await rejectionOf(ledger.claim(IDENTITY, 'digest-b', { runId: 'run-2' }));
  expect(await conflictKeys()).toHaveLength(1);
}

describe.each(BACKENDS)('command-ledger expiry over %s', (_backend, factory) => {
  it("deletes the expired binding's conflict records with the claim that replaces it", async () => {
    await withLedger(factory, async (scenario) => {
      await bindingWithConflict(scenario);

      scenario.setTime(ORIGIN_MS + DAY_MS);
      const fresh = await scenario.ledger.claim(IDENTITY, 'digest-b', { runId: 'run-3' });

      expect(fresh.outcome).toBe('claimed');
      expect(await scenario.ledger.read(IDENTITY)).toEqual(fresh.entry);
      expect(await scenario.conflictKeys()).toEqual([]);
    });
  });

  it('prunes an expired binding with its conflict records', async () => {
    await withLedger(factory, async (scenario) => {
      await bindingWithConflict(scenario);

      scenario.setTime(ORIGIN_MS + DAY_MS - 1);
      expect(await scenario.ledger.prune()).toEqual({ entries: 0, conflicts: 0 });
      scenario.setTime(ORIGIN_MS + DAY_MS);
      expect(await scenario.ledger.prune()).toEqual({ entries: 1, conflicts: 1 });

      expect(await scenario.ledger.locate(IDENTITY)).toEqual({ state: 'not-found' });
      expect(await scenario.conflictKeys()).toEqual([]);
    });
  });
});
