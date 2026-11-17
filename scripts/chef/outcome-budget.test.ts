import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialize, validateBudgetRecord } from './outcome-budget.ts';

const validRecord = {
  version: 1,
  outcomeId: 'outcome',
  spentTokens: 0,
  operations: {},
  hardLimitEnforced: false,
} as const;

test('accepts a versioned record with an explicit non-enforced hard-limit state', () => {
  expect(() => validateBudgetRecord(validRecord, 'outcome')).not.toThrow();
  expect(() =>
    validateBudgetRecord(
      {
        ...validRecord,
        spentTokens: 'unknown',
        operations: { dispatch: { amount: 4, actual: 'unknown', state: 'settled' } },
      },
      'outcome',
    ),
  ).not.toThrow();
});

test('initialization snapshots a validated allowance before its first await', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'budget-allowance-'));
  const allowance = { amount: 4, provenance: 'user' };
  try {
    const initialized = initialize(join(directory, 'record.json'), 'outcome', allowance);
    allowance.amount = -1;
    allowance.provenance = '';
    expect(await initialized).toMatchObject({ allowanceTokens: { amount: 4, provenance: 'user' } });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects malformed durable fields before any persistent operation can use them', () => {
  for (const record of [
    { ...validRecord, hardLimitEnforced: true },
    { ...validRecord, spentTokens: -1 },
    { ...validRecord, outcomeId: '' },
    { ...validRecord, operations: { inherited: { amount: Number.NaN, state: 'reserved' } } },
    {
      ...validRecord,
      allowanceTokens: { amount: 10, provenance: 'user' },
      operations: { dispatch: { amount: 10, actual: 10, state: 'settled' } },
    },
    {
      ...validRecord,
      spentTokens: 0,
      operations: { dispatch: { amount: 'unknown', actual: 'unknown', state: 'settled' } },
    },
  ])
    expect(() => validateBudgetRecord(record, 'outcome')).toThrow('Malformed budget record.');
});
