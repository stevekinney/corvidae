import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  expect(duplicateReservation.operations).toEqual({ dispatch: { amount: 6, state: 'reserved' } });
  await expect(reserve(path, 'outcome', 'other', 5)).rejects.toThrow('Allowance exceeded');
  const firstSettlement = await settle(path, 'outcome', 'dispatch', 6);
  const duplicateSettlement = await settle(path, 'outcome', 'dispatch', 6);
  const released = await release(path, 'outcome', 'dispatch');
  expect(firstSettlement.spentTokens).toBe(6);
  expect(duplicateSettlement.spentTokens).toBe(6);
  await expect(reserve(path, 'outcome', 'dispatch', 6)).resolves.toMatchObject({ spentTokens: 6 });
  await expect(reserve(path, 'outcome', 'dispatch', 7)).rejects.toThrow(
    'Reservation amount changed',
  );
  expect(released.hardLimitEnforced).toBe(false);
});

test('rejects invalid counts and unresolved actual usage without mutating capacity', async () => {
  await initialize(path, 'outcome', { amount: 10, provenance: 'owner' });
  await expect(reserve(path, 'outcome', 'bad', -1)).rejects.toThrow('Invalid reservation');
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
  await expect(reserve(path, 'outcome', 'dispatch', 1)).rejects.toThrow(
    'Actual usage is unresolved',
  );
});

test('does not create records by reading and rejects every malformed persisted state', async () => {
  await expect(read(path, 'outcome')).rejects.toThrow('does not exist');
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
  await expect(read(path, 'outcome')).rejects.toThrow('Malformed');
});
