import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import { initialize, read, release, reserve, settle } from './outcome-budget.ts';

let directory: string;
let path: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'outcome-budget-'));
  path = join(directory, 'budget.json');
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

test('persists idempotent reserve, settle and release without claiming a hard cap', async () => {
  await initialize(path, 'outcome', { amount: 10, provenance: 'owner' });
  await reserve(path, 'outcome', 'dispatch', 6);
  const duplicateReservation = await reserve(path, 'outcome', 'dispatch', 6);
  expect(duplicateReservation).toMatchObject({
    admission: 'replay',
    record: { operations: { dispatch: { amount: 6, state: 'reserved' } } },
  });
  expect((await rejectionOf(reserve(path, 'outcome', 'other', 5))).message).toContain(
    'Allowance exceeded',
  );
  const firstSettlement = await settle(path, 'outcome', 'dispatch', 6);
  const duplicateSettlement = await settle(path, 'outcome', 'dispatch', 6);
  const released = await release(path, 'outcome', 'dispatch');
  expect(firstSettlement.spentTokens).toBe(6);
  expect(duplicateSettlement.spentTokens).toBe(6);
  expect(await reserve(path, 'outcome', 'dispatch', 6)).toMatchObject({
    admission: 'terminal',
    record: { spentTokens: 6 },
  });
  expect((await rejectionOf(reserve(path, 'outcome', 'dispatch', 7))).message).toContain(
    'Reservation amount changed',
  );
  expect(released.hardLimitEnforced).toBe(false);
});

test('rejects invalid counts and unresolved actual usage without mutating capacity', async () => {
  await initialize(path, 'outcome', { amount: 10, provenance: 'owner' });
  expect((await rejectionOf(reserve(path, 'outcome', 'bad', -1))).message).toContain(
    'Invalid reservation',
  );
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      outcomeId: 'outcome',
      spentTokens: 'unknown',
      operations: {},
      hardLimitEnforced: false,
      allowanceTokens: { amount: 10, provenance: 'owner' },
    }),
  );
  expect((await rejectionOf(reserve(path, 'outcome', 'dispatch', 1))).message).toContain(
    'Actual usage is unresolved',
  );
});

test('does not create records by reading and rejects every malformed persisted state', async () => {
  expect((await rejectionOf(read(path, 'outcome'))).message).toContain('does not exist');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      outcomeId: 'outcome',
      spentTokens: 0,
      operations: {},
      hardLimitEnforced: true,
    }),
  );
  expect((await rejectionOf(read(path, 'outcome'))).message).toContain('Malformed');
});
