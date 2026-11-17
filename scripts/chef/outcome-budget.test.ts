import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialize, release, reserve, settle } from './outcome-budget.ts';

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
  expect((await reserve(path, 'outcome', 'dispatch', 6)).reservations).toEqual({ dispatch: 6 });
  await expect(reserve(path, 'outcome', 'other', 5)).rejects.toThrow('Allowance exceeded');
  expect((await settle(path, 'outcome', 'dispatch', 6)).spentTokens).toBe(6);
  expect((await settle(path, 'outcome', 'dispatch', 6)).spentTokens).toBe(6);
  expect((await release(path, 'outcome', 'dispatch')).hardLimitEnforced).toBe(false);
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
      reservations: {},
      settled: [],
      hardLimitEnforced: false,
      allowanceTokens: { amount: 10, provenance: 'owner' },
    }),
  );
  await expect(reserve(path, 'outcome', 'dispatch', 1)).rejects.toThrow(
    'Actual usage is unresolved',
  );
});
