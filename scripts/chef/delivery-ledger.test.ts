import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ledgerPath, readLedgerHeads, recordDelivery } from './delivery-ledger.ts';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const MERGE_COMMIT = 'c'.repeat(40);

function checkout(): string {
  const scratch = join(process.cwd(), 'tmp', 'chef');
  mkdirSync(scratch, { recursive: true });
  return mkdtempSync(join(scratch, 'p05-ledger-14ef-'));
}

function entry(overrides: Partial<Parameters<typeof recordDelivery>[1]> = {}) {
  return {
    branch: 'steve/ledger',
    head: HEAD,
    mergeCommit: MERGE_COMMIT,
    operationId: 'operation-1',
    time: new Date('2026-11-18T00:00:00.000Z'),
    ...overrides,
  };
}

test('records one line for identical retries and preserves both distinct operations', () => {
  const path = checkout();
  try {
    recordDelivery(path, entry());
    recordDelivery(path, entry({ time: new Date('2026-11-18T00:01:00.000Z') }));
    recordDelivery(path, entry({ operationId: 'operation-2' }));
    expect(readFileSync(ledgerPath(path), 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test('refuses a changed delivery identity for an operation without changing ledger bytes', () => {
  const path = checkout();
  try {
    recordDelivery(path, entry());
    const before = readFileSync(ledgerPath(path), 'utf8');
    for (const changedIdentity of [
      { branch: 'steve/other' },
      { pr: 1 },
      { head: OTHER_HEAD },
      { mergeCommit: null },
    ]) {
      expect(() => recordDelivery(path, entry(changedIdentity))).toThrow('already records');
      expect(readFileSync(ledgerPath(path), 'utf8')).toBe(before);
    }
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test('refuses empty and delimiter-bearing operation identities without writing', () => {
  const path = checkout();
  try {
    for (const operationId of ['', 'line\nbreak', 'tab\tbreak'])
      expect(() => recordDelivery(path, entry({ operationId }))).toThrow('operation identity');
    expect(() => readFileSync(ledgerPath(path), 'utf8')).toThrow();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test('reads heads from existing four-column rows and new operation rows', () => {
  const path = checkout();
  try {
    mkdirSync(dirname(ledgerPath(path)), { recursive: true });
    writeFileSync(ledgerPath(path), `2026-11-17T00:00:00.000Z\tbranch:legacy\t${HEAD}\t-\n`);
    recordDelivery(path, entry({ head: OTHER_HEAD, operationId: 'operation-2' }));
    expect(readLedgerHeads(path)).toEqual(new Set([HEAD, OTHER_HEAD]));
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});
