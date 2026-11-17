import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { acquireHostLock } from '../run-exclusively.ts';

export type OperationState = 'reserved' | 'settled' | 'released';
export interface BudgetOperation {
  amount: number | 'unknown';
  state: OperationState;
  actual?: number | 'unknown';
}
export interface BudgetRecord {
  version: 1;
  outcomeId: string;
  allowanceTokens?: { amount: number; provenance: string };
  spentTokens: number | 'unknown';
  operations: Record<string, BudgetOperation>;
  hardLimitEnforced: false;
}
export type Admission = 'admitted' | 'replay' | 'terminal';
export interface ReserveResult {
  record: BudgetRecord;
  admission: Admission;
}
export interface BudgetDependencies {
  replace?: (temporary: string, path: string) => Promise<void>;
}
function valid(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function own(object: object, key: string): boolean {
  return Object.hasOwn(object, key);
}
export function validateBudgetRecord(
  record: unknown,
  outcomeId: string,
): asserts record is BudgetRecord {
  const value = record as BudgetRecord;
  if (
    !value ||
    value.version !== 1 ||
    value.outcomeId !== outcomeId ||
    value.outcomeId === '' ||
    typeof value.hardLimitEnforced !== 'boolean' ||
    value.hardLimitEnforced ||
    (value.spentTokens !== 'unknown' && !valid(value.spentTokens)) ||
    !value.operations ||
    typeof value.operations !== 'object' ||
    Array.isArray(value.operations)
  )
    throw new Error('Malformed budget record.');
  if (
    value.allowanceTokens !== undefined &&
    (typeof value.allowanceTokens !== 'object' ||
      !valid(value.allowanceTokens.amount) ||
      typeof value.allowanceTokens.provenance !== 'string' ||
      value.allowanceTokens.provenance === '')
  )
    throw new Error('Malformed budget record.');
  let settledTotal = 0;
  let hasUnknownSettlement = false;
  for (const [identity, operation] of Object.entries(value.operations)) {
    if (
      identity === '' ||
      !operation ||
      (operation.amount !== 'unknown' && !valid(operation.amount)) ||
      !['reserved', 'settled', 'released'].includes(operation.state) ||
      (operation.actual !== undefined && operation.actual !== 'unknown' && !valid(operation.actual))
    )
      throw new Error('Malformed budget record.');
    if (operation.state === 'settled' && operation.actual === undefined)
      throw new Error('Malformed budget record.');
    if (operation.state !== 'settled' && operation.actual !== undefined)
      throw new Error('Malformed budget record.');
    if (operation.state === 'settled') {
      if (operation.actual === 'unknown') hasUnknownSettlement = true;
      else settledTotal += operation.actual!;
    }
  }
  if (
    (hasUnknownSettlement && value.spentTokens !== 'unknown') ||
    (!hasUnknownSettlement &&
      (value.spentTokens === 'unknown' || value.spentTokens !== settledTotal))
  )
    throw new Error('Malformed budget record.');
}
async function readExisting(path: string, outcomeId: string): Promise<BudgetRecord> {
  if (!existsSync(path)) throw new Error('Budget record does not exist.');
  const record: unknown = JSON.parse(await readFile(path, 'utf8'));
  validateBudgetRecord(record, outcomeId);
  return record;
}
async function mutate(
  path: string,
  outcomeId: string,
  change: (record: BudgetRecord) => BudgetRecord,
  dependencies: BudgetDependencies = {},
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
    await (dependencies.replace ?? rename)(temporary, path);
    return next;
  } finally {
    await lock.release();
  }
}
export async function initialize(
  path: string,
  outcomeId: string,
  allowance?: { amount: number; provenance: string },
  dependencies: BudgetDependencies = {},
): Promise<BudgetRecord> {
  if (!outcomeId || (allowance && (!valid(allowance.amount) || allowance.provenance === '')))
    throw new Error('Invalid allowance.');
  const allowanceTokens = allowance && {
    amount: allowance.amount,
    provenance: allowance.provenance,
  };
  await mkdir(dirname(path), { recursive: true });
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
    if (existsSync(path)) return await readExisting(path, outcomeId);
    const record: BudgetRecord = {
      version: 1,
      outcomeId,
      ...(allowanceTokens ? { allowanceTokens } : {}),
      spentTokens: 0,
      operations: Object.create(null),
      hardLimitEnforced: false,
    };
    const temporary = `${path}.${process.pid}.complete`;
    await writeFile(temporary, JSON.stringify(record));
    await (dependencies.replace ?? rename)(temporary, path);
    return record;
  } finally {
    await lock.release();
  }
}
export const read = readExisting;
export async function reserve(
  path: string,
  outcomeId: string,
  operation: string,
  amount: number | 'unknown',
  dependencies: BudgetDependencies = {},
): Promise<ReserveResult> {
  if (!operation || (amount !== 'unknown' && !valid(amount)))
    throw new Error('Invalid reservation amount.');
  let admission: Admission = 'admitted';
  const record = await mutate(
    path,
    outcomeId,
    (current) => {
      const prior = own(current.operations, operation) ? current.operations[operation] : undefined;
      if (prior) {
        if (prior.amount !== amount) throw new Error('Reservation amount changed.');
        admission = prior.state === 'reserved' ? 'replay' : 'terminal';
        return current;
      }
      if (current.spentTokens === 'unknown' && current.allowanceTokens)
        throw new Error('Actual usage is unresolved.');
      if (amount === 'unknown' && current.allowanceTokens)
        throw new Error('Unknown reservation cannot use an allowance.');
      const committed =
        (current.spentTokens === 'unknown' ? 0 : current.spentTokens) +
        Object.values(current.operations)
          .filter((item) => item.state === 'reserved' && item.amount !== 'unknown')
          .reduce<number>((sum, item) => sum + (item.amount as number), 0);
      if (current.allowanceTokens && committed + amount > current.allowanceTokens.amount)
        throw new Error('Allowance exceeded.');
      return {
        ...current,
        operations: { ...current.operations, [operation]: { amount, state: 'reserved' } },
      };
    },
    dependencies,
  );
  return { record, admission };
}
export async function release(
  path: string,
  outcomeId: string,
  operation: string,
  dependencies: BudgetDependencies = {},
): Promise<BudgetRecord> {
  return mutate(
    path,
    outcomeId,
    (record) => {
      const prior = own(record.operations, operation) ? record.operations[operation] : undefined;
      if (!prior || prior.state !== 'reserved') return record;
      return {
        ...record,
        operations: { ...record.operations, [operation]: { ...prior, state: 'released' } },
      };
    },
    dependencies,
  );
}
export async function settle(
  path: string,
  outcomeId: string,
  operation: string,
  actual: number | 'unknown',
  dependencies: BudgetDependencies = {},
): Promise<BudgetRecord> {
  if (actual !== 'unknown' && !valid(actual)) throw new Error('Invalid actual usage.');
  return mutate(
    path,
    outcomeId,
    (record) => {
      const prior = own(record.operations, operation) ? record.operations[operation] : undefined;
      if (!prior) throw new Error('No reservation to settle.');
      if (prior.state === 'settled') {
        if (prior.actual !== actual) throw new Error('Settlement amount changed.');
        return record;
      }
      if (prior.state === 'released') throw new Error('Released reservation cannot settle.');
      if (actual === 'unknown')
        return {
          ...record,
          spentTokens: 'unknown',
          operations: {
            ...record.operations,
            [operation]: { ...prior, state: 'settled', actual: 'unknown' },
          },
        };
      if (record.spentTokens === 'unknown') throw new Error('Actual usage is unresolved.');
      return {
        ...record,
        spentTokens: record.spentTokens + actual,
        operations: { ...record.operations, [operation]: { ...prior, state: 'settled', actual } },
      };
    },
    dependencies,
  );
}
