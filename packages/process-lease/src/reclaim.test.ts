import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ownerFileName, type OwnerRecord } from './lock-records.ts';
import {
  reclaimAbandonedAs,
  reclaimGuardFor,
  takeReclaimGuard,
  tokenlessGuardStaleMs,
  type LivenessJudge,
} from './reclaim.ts';

const root = mkdtempSync(join(tmpdir(), 'process-lease-reclaim-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const record = (token: string, overrides: Partial<OwnerRecord> = {}): OwnerRecord => ({
  pid: process.pid,
  command: 'a command',
  cwd: '/a/worktree',
  acquiredAt: '2026-01-01T00:00:00.000Z',
  token,
  ...overrides,
});

/** The judge a test controls: the tokens it names are alive, nothing else is. */
const aliveTokens =
  (...tokens: string[]): LivenessJudge =>
  () =>
  (candidate) =>
    tokens.includes(candidate.token);

function lockWith(name: string, owner: OwnerRecord): string {
  const directory = join(root, name);
  mkdirSync(directory);
  writeFileSync(join(directory, ownerFileName), JSON.stringify(owner));
  return directory;
}

describe('reclaimGuardFor', () => {
  test('names a sibling directory of the lock', () => {
    expect(reclaimGuardFor('/locks/host')).toBe('/locks/host.reclaiming');
  });
});

describe('takeReclaimGuard', () => {
  test('lets one reclaimer in at a time and lets the next in once it leaves', async () => {
    const lock = join(root, 'guarded');
    const judge = aliveTokens('first', 'second');
    const leaveFirst = await takeReclaimGuard(lock, record('first'), judge);
    expect(leaveFirst).toBeDefined();
    expect(existsSync(reclaimGuardFor(lock))).toBe(true);
    expect(await takeReclaimGuard(lock, record('second'), judge)).toBeUndefined();
    await leaveFirst?.();
    expect(existsSync(reclaimGuardFor(lock))).toBe(false);
    const leaveSecond = await takeReclaimGuard(lock, record('second'), judge);
    expect(leaveSecond).toBeDefined();
    await leaveSecond?.();
  });

  test('clears a guard whose every reclaimer is gone, and takes it on the next try', async () => {
    const lock = join(root, 'abandoned-guard');
    const leaveGone = await takeReclaimGuard(lock, record('gone'), aliveTokens('gone'));
    expect(leaveGone).toBeDefined();
    expect(await takeReclaimGuard(lock, record('next'), aliveTokens())).toBeUndefined();
    const leaveNext = await takeReclaimGuard(lock, record('next'), aliveTokens('next'));
    expect(leaveNext).toBeDefined();
    await leaveNext?.();
  });

  test('judges a guard without a token by its age', async () => {
    const lock = join(root, 'tokenless-guard');
    const guard = reclaimGuardFor(lock);
    mkdirSync(guard);
    expect(await takeReclaimGuard(lock, record('young'), aliveTokens())).toBeUndefined();
    expect(existsSync(guard)).toBe(true);
    const old = new Date(Date.now() - tokenlessGuardStaleMs - 1_000);
    utimesSync(guard, old, old);
    expect(await takeReclaimGuard(lock, record('old'), aliveTokens())).toBeUndefined();
    expect(existsSync(guard)).toBe(false);
  });
});

describe('reclaimAbandonedAs', () => {
  const reclaimer = (token: string, judge: LivenessJudge) => ({
    judge,
    claimant: record(token),
  });

  test('removes a lock whose owner is gone', async () => {
    const directory = lockWith('dead-owner', record('dead-owner'));
    expect(await reclaimAbandonedAs(directory, 10_000, reclaimer('r1', aliveTokens()))).toBe(true);
    expect(existsSync(directory)).toBe(false);
  });

  test('keeps a lock whose owner still runs', async () => {
    const directory = lockWith('live-owner', record('live-owner'));
    expect(
      await reclaimAbandonedAs(directory, 10_000, reclaimer('r2', aliveTokens('live-owner'))),
    ).toBe(false);
    expect(existsSync(directory)).toBe(true);
  });

  test('is done for a lock that is already gone', async () => {
    expect(
      await reclaimAbandonedAs(join(root, 'never-held'), 10_000, reclaimer('r3', aliveTokens())),
    ).toBe(true);
  });

  test('keeps an ownerless directory until its grace has passed, then removes it', async () => {
    const directory = join(root, 'ownerless');
    mkdirSync(directory);
    expect(await reclaimAbandonedAs(directory, 60_000, reclaimer('r4', aliveTokens()))).toBe(false);
    expect(existsSync(directory)).toBe(true);
    expect(await reclaimAbandonedAs(directory, 0, reclaimer('r5', aliveTokens()))).toBe(true);
    expect(existsSync(directory)).toBe(false);
  });

  test('backs off while another reclaimer is inside the guard', async () => {
    const directory = lockWith('contended', record('contended'));
    const leave = await takeReclaimGuard(directory, record('inside'), aliveTokens('inside'));
    expect(
      await reclaimAbandonedAs(directory, 10_000, reclaimer('r6', aliveTokens('inside'))),
    ).toBe(false);
    expect(existsSync(directory)).toBe(true);
    await leave?.();
  });
});
