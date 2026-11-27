import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  asideOf,
  describeHolder,
  errorCode,
  isAbsentOrPartial,
  ownerFileName,
  readOwner,
  readTicket,
  removeLock,
  statIfPresent,
  type OwnerRecord,
} from './lock-records.ts';

const root = mkdtempSync(join(tmpdir(), 'process-lease-records-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const record = (token: string): OwnerRecord => ({
  pid: 4242,
  pidStartedAt: 'Thu Jan  1 00:00:00 1970',
  command: 'a command',
  cwd: '/a/worktree',
  acquiredAt: '2026-01-01T00:00:00.000Z',
  token,
});

function lockWith(name: string, owner: OwnerRecord): string {
  const directory = join(root, name);
  mkdirSync(directory);
  writeFileSync(join(directory, ownerFileName), JSON.stringify(owner));
  return directory;
}

describe('isAbsentOrPartial', () => {
  test('reads only a missing, misplaced or half written record as absent', () => {
    expect(isAbsentOrPartial(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(true);
    expect(isAbsentOrPartial(Object.assign(new Error('x'), { code: 'ENOTDIR' }))).toBe(true);
    expect(isAbsentOrPartial(new SyntaxError('half written'))).toBe(true);
    expect(isAbsentOrPartial(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe(false);
    expect(isAbsentOrPartial(new Error('x'))).toBe(false);
    expect(isAbsentOrPartial(undefined)).toBe(false);
  });
});

describe('errorCode', () => {
  test('names the code of a system error and tolerates anything else', () => {
    expect(errorCode(Object.assign(new Error('x'), { code: 'EEXIST' }))).toBe('EEXIST');
    expect(errorCode(new Error('x'))).toBeUndefined();
    expect(errorCode(undefined)).toBeUndefined();
  });
});

describe('statIfPresent', () => {
  test('resolves to undefined for a missing path and to its status for a present one', async () => {
    expect(await statIfPresent(join(root, 'absent'))).toBeUndefined();
    const present = await statIfPresent(root);
    expect(present?.isDirectory()).toBe(true);
  });

  test('throws any failure other than absence', async () => {
    const file = join(root, 'a-file');
    writeFileSync(file, '');
    expect(await rejectionOf(statIfPresent(join(file, 'inside')))).toBeInstanceOf(Error);
  });
});

describe('readOwner and readTicket', () => {
  test('read the record a lock directory holds', async () => {
    const directory = lockWith('held', record('held'));
    expect(await readOwner(directory)).toEqual(record('held'));
    expect(await readTicket(directory, ownerFileName)).toEqual(record('held'));
  });

  test('read a missing or half written record as no owner, never as an error', async () => {
    const half = join(root, 'half');
    mkdirSync(half);
    writeFileSync(join(half, ownerFileName), '{"pid": 4');
    expect(await readOwner(half)).toBeUndefined();
    expect(await readOwner(join(root, 'no-such-lock'))).toBeUndefined();
    expect(await readTicket(half, 'no-such-ticket.json')).toBeUndefined();
  });

  test('throw a failure that is not an absence', async () => {
    const directory = join(root, 'unreadable');
    mkdirSync(directory);
    mkdirSync(join(directory, ownerFileName));
    expect(await rejectionOf(readOwner(directory))).toBeInstanceOf(Error);
  });
});

describe('describeHolder', () => {
  test('names the process, command, worktree and time, or says none has recorded itself', () => {
    expect(describeHolder(record('t'))).toBe(
      'pid 4242 running `a command` in /a/worktree since 2026-01-01T00:00:00.000Z',
    );
    expect(describeHolder(undefined)).toBe('a holder that has not recorded itself yet');
  });
});

describe('asideOf', () => {
  test('names a unique sibling of the lock for each call', () => {
    const first = asideOf('/locks/host');
    expect(first.startsWith(`/locks/host.removed-${process.pid}-`)).toBe(true);
    expect(asideOf('/locks/host')).not.toBe(first);
  });
});

describe('removeLock', () => {
  test('removes the lock whose token it names', async () => {
    const directory = lockWith('mine', record('mine'));
    await removeLock(directory, record('mine'));
    expect(existsSync(directory)).toBe(false);
  });

  test('leaves a lock another token holds where it is, unmoved', async () => {
    const directory = lockWith('theirs', record('theirs'));
    await removeLock(directory, record('mine'));
    expect(await readOwner(directory)).toEqual(record('theirs'));
  });

  test('is a no-op for a lock that is already gone, however often it is repeated', async () => {
    const directory = join(root, 'gone');
    await removeLock(directory, record('mine'));
    await removeLock(directory, record('mine'));
    expect(existsSync(directory)).toBe(false);
  });
});
