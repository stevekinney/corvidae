import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { acquireHostLock } from '../run-exclusively.ts';

export interface BudgetRecord {
  version: 1;
  outcomeId: string;
  allowanceTokens?: { amount: number; provenance: string };
  spentTokens: number | 'unknown';
  reservations: Record<string, number>;
  settled: string[];
  hardLimitEnforced: false;
}

function valid(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

async function read(path: string, outcomeId: string): Promise<BudgetRecord> {
  try {
    const record = JSON.parse(await readFile(path, 'utf8')) as BudgetRecord;
    if (
      record.version !== 1 ||
      record.outcomeId !== outcomeId ||
      !valid(record.spentTokens === 'unknown' ? 0 : record.spentTokens)
    )
      throw new Error('Malformed budget record.');
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return {
        version: 1,
        outcomeId,
        spentTokens: 0,
        reservations: {},
        settled: [],
        hardLimitEnforced: false,
      };
    throw error;
  }
}

async function mutate(
  path: string,
  outcomeId: string,
  change: (record: BudgetRecord) => BudgetRecord,
): Promise<BudgetRecord> {
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
    const next = change(await read(path, outcomeId));
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
  if (allowance && (!valid(allowance.amount) || allowance.provenance === ''))
    throw new Error('Invalid allowance.');
  return mutate(path, outcomeId, (record) =>
    record.allowanceTokens === undefined && allowance !== undefined
      ? { ...record, allowanceTokens: allowance }
      : record,
  );
}

export async function reserve(
  path: string,
  outcomeId: string,
  operation: string,
  amount: number,
): Promise<BudgetRecord> {
  if (!valid(amount)) throw new Error('Invalid reservation amount.');
  return mutate(path, outcomeId, (record) => {
    const prior = record.reservations[operation];
    if (prior !== undefined) {
      if (prior !== amount) throw new Error('Reservation amount changed.');
      return record;
    }
    if (record.spentTokens === 'unknown' && record.allowanceTokens !== undefined)
      throw new Error('Actual usage is unresolved.');
    const committed =
      (record.spentTokens === 'unknown' ? 0 : record.spentTokens) +
      Object.values(record.reservations).reduce((sum, value) => sum + value, 0);
    if (record.allowanceTokens && committed + amount > record.allowanceTokens.amount)
      throw new Error('Allowance exceeded.');
    return { ...record, reservations: { ...record.reservations, [operation]: amount } };
  });
}

export async function release(
  path: string,
  outcomeId: string,
  operation: string,
): Promise<BudgetRecord> {
  return mutate(path, outcomeId, (record) => {
    const { [operation]: _removed, ...reservations } = record.reservations;
    return { ...record, reservations };
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
    if (record.settled.includes(operation)) return record;
    if (record.reservations[operation] === undefined) throw new Error('No reservation to settle.');
    const { [operation]: _removed, ...reservations } = record.reservations;
    if (record.spentTokens === 'unknown') throw new Error('Actual usage is unresolved.');
    return {
      ...record,
      spentTokens: record.spentTokens + actual,
      reservations,
      settled: [...record.settled, operation],
    };
  });
}
