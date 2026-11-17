import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { acquireHostLock } from '../run-exclusively.ts';

export type OperationState = 'reserved' | 'settled' | 'released';
export interface BudgetOperation {
  amount: number;
  state: OperationState;
  actual?: number;
}
export interface BudgetRecord {
  version: 1;
  outcomeId: string;
  allowanceTokens?: { amount: number; provenance: string };
  spentTokens: number | 'unknown';
  operations: Record<string, BudgetOperation>;
  hardLimitEnforced: false;
}
function valid(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function own(object: object, key: string): boolean {
  return Object.hasOwn(object, key);
}
function validate(record: unknown, outcomeId: string): asserts record is BudgetRecord {
  const value = record as BudgetRecord;
  if (
    !value ||
    value.version !== 1 ||
    value.outcomeId !== outcomeId ||
    value.outcomeId === '' ||
    value.hardLimitEnforced !== false ||
    (value.spentTokens !== 'unknown' && !valid(value.spentTokens)) ||
    !value.operations ||
    typeof value.operations !== 'object'
  )
    throw new Error('Malformed budget record.');
  if (
    value.allowanceTokens &&
    (!valid(value.allowanceTokens.amount) || value.allowanceTokens.provenance === '')
  )
    throw new Error('Malformed budget record.');
  for (const operation of Object.values(value.operations))
    if (
      !operation ||
      !valid(operation.amount) ||
      !['reserved', 'settled', 'released'].includes(operation.state) ||
      (operation.actual !== undefined && !valid(operation.actual))
    )
      throw new Error('Malformed budget record.');
}
async function readExisting(path: string, outcomeId: string): Promise<BudgetRecord> {
  if (!existsSync(path)) throw new Error('Budget record does not exist.');
  const record: unknown = JSON.parse(await readFile(path, 'utf8'));
  validate(record, outcomeId);
  return record;
}
async function mutate(
  path: string,
  outcomeId: string,
  change: (record: BudgetRecord) => BudgetRecord,
): Promise<BudgetRecord> {
  const lock = await acquireHostLock({
    lockDirectory: `${path}.lock`,
    holder: {
      pid: process.pid,
      command: 'outcome-budget',
      cwd: process.cwd(),
      acquiredAt: new Date().toISOString(),
    },
  });
  try {
    const next = change(await readExisting(path, outcomeId));
    const temporary = `${path}.${process.pid}.complete`;
    await writeFile(temporary, JSON.stringify(next));
    await rename(temporary, path);
    return next;
  } finally {
    await lock.release();
  }
}
export async function initialize(
  path: string,
  outcomeId: string,
  allowance?: { amount: number; provenance: string },
): Promise<BudgetRecord> {
  if (!outcomeId || (allowance && (!valid(allowance.amount) || allowance.provenance === '')))
    throw new Error('Invalid allowance.');
  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path)) return readExisting(path, outcomeId);
  const record: BudgetRecord = {
    version: 1,
    outcomeId,
    ...(allowance ? { allowanceTokens: allowance } : {}),
    spentTokens: 0,
    operations: Object.create(null),
    hardLimitEnforced: false,
  };
  await writeFile(path, JSON.stringify(record));
  return record;
}
export const read = readExisting;
export async function reserve(
  path: string,
  outcomeId: string,
  operation: string,
  amount: number,
): Promise<BudgetRecord> {
  if (!operation || !valid(amount)) throw new Error('Invalid reservation amount.');
  return mutate(path, outcomeId, (record) => {
    const prior = own(record.operations, operation) ? record.operations[operation] : undefined;
    if (prior) {
      if (prior.amount !== amount) throw new Error('Reservation amount changed.');
      return record;
    }
    if (record.spentTokens === 'unknown' && record.allowanceTokens)
      throw new Error('Actual usage is unresolved.');
    const committed =
      (record.spentTokens === 'unknown' ? 0 : record.spentTokens) +
      Object.values(record.operations)
        .filter((item) => item.state === 'reserved')
        .reduce((sum, item) => sum + item.amount, 0);
    if (record.allowanceTokens && committed + amount > record.allowanceTokens.amount)
      throw new Error('Allowance exceeded.');
    return {
      ...record,
      operations: { ...record.operations, [operation]: { amount, state: 'reserved' } },
    };
  });
}
export async function release(
  path: string,
  outcomeId: string,
  operation: string,
): Promise<BudgetRecord> {
  return mutate(path, outcomeId, (record) => {
    const prior = record.operations[operation];
    if (!prior || prior.state !== 'reserved') return record;
    return {
      ...record,
      operations: { ...record.operations, [operation]: { ...prior, state: 'released' } },
    };
  });
}
export async function settle(
  path: string,
  outcomeId: string,
  operation: string,
  actual: number,
): Promise<BudgetRecord> {
  if (!valid(actual)) throw new Error('Invalid actual usage.');
  return mutate(path, outcomeId, (record) => {
    const prior = record.operations[operation];
    if (!prior) throw new Error('No reservation to settle.');
    if (prior.state === 'settled') {
      if (prior.actual !== actual) throw new Error('Settlement amount changed.');
      return record;
    }
    if (prior.state === 'released') throw new Error('Released reservation cannot settle.');
    if (record.spentTokens === 'unknown') throw new Error('Actual usage is unresolved.');
    return {
      ...record,
      spentTokens: record.spentTokens + actual,
      operations: { ...record.operations, [operation]: { ...prior, state: 'settled', actual } },
    };
  });
}
