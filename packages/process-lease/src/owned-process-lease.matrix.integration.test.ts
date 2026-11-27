/**
 * The ownership matrix of an owned-process lease (COR-2757): every state a lease directory can be
 * in, crossed with every action that can find it. A cell names what the action does, whether the
 * lock is still there afterwards, and whether an unrelated live process was left alone.
 *
 * - `acquire`: checkout startup takes the scoped lease. It takes it over nothing, or over a dead
 *   own-identity owner it verifies; it waits behind a live own owner; it refuses all the rest.
 * - `retire`: reclaim, which removes the lock only for a verified dead own-identity owner.
 * - `cleanup`: teardown after a killed supervisor (`supervisor.ts cleanup`), which also leaves a
 *   live own owner alone.
 * - `cleanup again`: repeated cleanup, which is a no-op once the lock is gone and the same refusal
 *   while it is not.
 *
 * Each cell runs at module scope, under the hang guard, so none is on Bun's per-test clock.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { acquireOwnedProcessLease, retireOwnedProcessLease } from './owned-process-lease.ts';
import { processStartTime } from './process-identity.ts';

type State =
  | 'no record'
  | 'own live record'
  | 'own dead record'
  | 'own dead record, verified gate group'
  | 'own dead record, unrelated live group'
  | 'own dead record, reused group'
  | 'own record, reused pid'
  | 'foreign live owner'
  | 'foreign dead owner, unrelated live group'
  | 'non-canonical worktree spelling';

type Action = 'acquire' | 'retire' | 'cleanup' | 'cleanup again';

type Outcome = {
  /** `acquired`, `waited` (behind a live owner), `resolved`, or `refused`. */
  readonly result: 'acquired' | 'waited' | 'resolved' | 'refused';
  readonly lockPresent: boolean;
  /** Whether the unrelated or reused process the record names is still running. */
  readonly bystanderAlive: boolean | undefined;
  /** Whether the verified gate group the record names is gone. */
  readonly groupGone: boolean | undefined;
};

const scratch = mkdtempSync(join(tmpdir(), 'owned-process-matrix-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const sleeperSource = 'setInterval(() => {}, 1000)';

function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** A process that has exited, with the start time it had, so a record can name a dead owner. */
async function deadIdentity(): Promise<{ pid: number; pidStartedAt: string }> {
  const child = spawnWithHangGuard([process.execPath, '-e', sleeperSource], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  await waitUntil(() => processStartTime(child.pid) !== undefined, { message: 'owner identity' });
  const pidStartedAt = processStartTime(child.pid) as string;
  child.kill('SIGKILL');
  await child.exited;
  return { pid: child.pid, pidStartedAt };
}

type Cell = {
  readonly lockDirectory: string;
  readonly worktree: string;
  readonly bystander: { readonly pid: number } | undefined;
  readonly group: number | undefined;
  readonly cleanup: () => Promise<void>;
};

async function prepare(state: State, index: number): Promise<Cell> {
  const base = join(scratch, String(index));
  const worktree = join(base, 'worktree');
  const other = join(base, 'other');
  const target = join(base, 'target');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(other);
  mkdirSync(target);
  const canonical = realpathSync(worktree);
  const lockDirectory = join(worktree, 'lock');
  const children: { kill: (signal?: NodeJS.Signals) => void; exited: Promise<unknown> }[] = [];
  const sleeper = () => {
    const child = spawnWithHangGuard([process.execPath, '-e', sleeperSource], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    children.push(child);
    return child;
  };
  const write = (record: object) => {
    mkdirSync(lockDirectory);
    writeFileSync(join(lockDirectory, 'owner.json'), JSON.stringify(record));
  };
  const base_ = (cwd: string) => ({
    command: 'matrix owner',
    cwd,
    acquiredAt: new Date().toISOString(),
    token: crypto.randomUUID(),
  });
  let bystander: { pid: number } | undefined;
  let group: number | undefined;
  let release: (() => Promise<void>) | undefined;
  if (state === 'own live record') {
    const lease = await acquireOwnedProcessLease(lockDirectory, worktree, 'matrix owner');
    release = () => lease.release();
  } else if (state === 'own dead record') {
    write({ ...base_(canonical), ...(await deadIdentity()) });
  } else if (state === 'own dead record, verified gate group') {
    const token = crypto.randomUUID();
    const gate = spawnWithHangGuard(
      [process.execPath, join(import.meta.dir, 'owned-process-gate.ts'), `--owned-token=${token}`],
      { cwd: worktree, detached: true, stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' },
    );
    const pid = gate.pid;
    children.push(gate);
    gate.stdin.write(JSON.stringify({ command: [process.execPath, '-e', sleeperSource] }));
    await gate.stdin.end();
    await waitUntil(() => processStartTime(pid) !== undefined, { message: 'gate identity' });
    group = pid;
    write({
      ...base_(canonical),
      token,
      ...(await deadIdentity()),
      processGroup: pid,
      processGroupStartedAt: processStartTime(pid),
    });
  } else if (state === 'own dead record, unrelated live group') {
    bystander = sleeper();
    await waitUntil(() => processStartTime(bystander!.pid) !== undefined, { message: 'sleeper' });
    write({
      ...base_(canonical),
      ...(await deadIdentity()),
      processGroup: bystander.pid,
      processGroupStartedAt: processStartTime(bystander.pid),
    });
  } else if (state === 'own dead record, reused group') {
    bystander = sleeper();
    await waitUntil(() => processStartTime(bystander!.pid) !== undefined, { message: 'sleeper' });
    write({
      ...base_(canonical),
      ...(await deadIdentity()),
      processGroup: bystander.pid,
      processGroupStartedAt: 'an earlier incarnation of this pid',
    });
  } else if (state === 'own record, reused pid') {
    bystander = sleeper();
    await waitUntil(() => processStartTime(bystander!.pid) !== undefined, { message: 'sleeper' });
    write({
      ...base_(canonical),
      pid: bystander.pid,
      pidStartedAt: 'an earlier incarnation of this pid',
    });
  } else if (state === 'foreign live owner') {
    bystander = sleeper();
    await waitUntil(() => processStartTime(bystander!.pid) !== undefined, { message: 'sleeper' });
    write({
      ...base_(realpathSync(other)),
      pid: bystander.pid,
      pidStartedAt: processStartTime(bystander.pid),
    });
  } else if (state === 'foreign dead owner, unrelated live group') {
    bystander = sleeper();
    await waitUntil(() => processStartTime(bystander!.pid) !== undefined, { message: 'sleeper' });
    write({
      ...base_(realpathSync(other)),
      ...(await deadIdentity()),
      processGroup: bystander.pid,
      processGroupStartedAt: processStartTime(bystander.pid),
    });
  } else if (state === 'non-canonical worktree spelling') {
    const alias = join(base, 'alias');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(target, alias);
    bystander = sleeper();
    await waitUntil(() => processStartTime(bystander!.pid) !== undefined, { message: 'sleeper' });
    write({
      ...base_(alias),
      ...(await deadIdentity()),
      processGroup: bystander.pid,
      processGroupStartedAt: processStartTime(bystander.pid),
    });
  }
  return {
    lockDirectory,
    worktree,
    bystander,
    group,
    cleanup: async () => {
      await release?.().catch(() => undefined);
      for (const child of children) child.kill('SIGKILL');
      if (group !== undefined && groupAlive(group)) process.kill(-group, 'SIGKILL');
      await Promise.all(children.map((child) => child.exited));
    },
  };
}

/** Takes the lease; a second collision means the call is waiting behind a live owner. */
async function acquire(cell: Cell): Promise<Outcome['result']> {
  class Waited extends Error {}
  let collisions = 0;
  try {
    const lease = await acquireOwnedProcessLease(
      cell.lockDirectory,
      cell.worktree,
      'matrix acquire',
      undefined,
      () => {
        collisions += 1;
        if (collisions >= 2) throw new Waited();
      },
    );
    // Observed while held, then released so the next cell starts clean.
    const present = existsSync(cell.lockDirectory);
    await lease.release();
    return present ? 'acquired' : 'refused';
  } catch (error) {
    return error instanceof Waited ? 'waited' : 'refused';
  }
}

async function retire(cell: Cell, leaveLiveOwner: boolean): Promise<Outcome['result']> {
  return retireOwnedProcessLease(
    cell.lockDirectory,
    cell.worktree,
    undefined,
    undefined,
    leaveLiveOwner,
  ).then(
    () => 'resolved' as const,
    () => 'refused' as const,
  );
}

async function run(state: State, action: Action, index: number): Promise<Outcome> {
  const cell = await prepare(state, index);
  try {
    let result: Outcome['result'];
    let lockPresent: boolean;
    if (action === 'acquire') {
      // `acquire` releases what it takes, so the lock it held is judged by the result alone.
      result = await acquire(cell);
      lockPresent = result === 'acquired' ? true : existsSync(cell.lockDirectory);
    } else {
      if (action === 'cleanup again') await retire(cell, true);
      result = await retire(cell, action !== 'retire');
      lockPresent = existsSync(cell.lockDirectory);
    }
    // The bystander is never signalled; a verified gate group is retired by a successful cleanup.
    const bystanderAlive =
      cell.bystander === undefined ? undefined : processStartTime(cell.bystander.pid) !== undefined;
    const groupGone = cell.group === undefined ? undefined : !groupAlive(cell.group);
    return { result, lockPresent, bystanderAlive, groupGone };
  } finally {
    await cell.cleanup();
  }
}

const refused = (lockPresent = true): Outcome => ({
  result: 'refused',
  lockPresent,
  bystanderAlive: undefined,
  groupGone: undefined,
});

/**
 * The expected outcome of each cell. A bystander is an unrelated live process that the record
 * names, by pid or by group; no cell may end one.
 */
const expected: Record<State, Record<Action, Outcome>> = {
  'no record': {
    acquire: {
      result: 'acquired',
      lockPresent: true,
      bystanderAlive: undefined,
      groupGone: undefined,
    },
    retire: {
      result: 'resolved',
      lockPresent: false,
      bystanderAlive: undefined,
      groupGone: undefined,
    },
    cleanup: {
      result: 'resolved',
      lockPresent: false,
      bystanderAlive: undefined,
      groupGone: undefined,
    },
    'cleanup again': {
      result: 'resolved',
      lockPresent: false,
      bystanderAlive: undefined,
      groupGone: undefined,
    },
  },
  'own live record': {
    acquire: {
      result: 'waited',
      lockPresent: true,
      bystanderAlive: undefined,
      groupGone: undefined,
    },
    retire: refused(),
    cleanup: {
      result: 'resolved',
      lockPresent: true,
      bystanderAlive: undefined,
      groupGone: undefined,
    },
    'cleanup again': {
      result: 'resolved',
      lockPresent: true,
      bystanderAlive: undefined,
      groupGone: undefined,
    },
  },
  'own dead record': {
    acquire: {
      result: 'acquired',
      lockPresent: true,
      bystanderAlive: undefined,
      groupGone: undefined,
    },
    retire: {
      result: 'resolved',
      lockPresent: false,
      bystanderAlive: undefined,
      groupGone: undefined,
    },
    cleanup: {
      result: 'resolved',
      lockPresent: false,
      bystanderAlive: undefined,
      groupGone: undefined,
    },
    'cleanup again': {
      result: 'resolved',
      lockPresent: false,
      bystanderAlive: undefined,
      groupGone: undefined,
    },
  },
  'own dead record, verified gate group': {
    acquire: { result: 'acquired', lockPresent: true, bystanderAlive: undefined, groupGone: true },
    retire: { result: 'resolved', lockPresent: false, bystanderAlive: undefined, groupGone: true },
    cleanup: { result: 'resolved', lockPresent: false, bystanderAlive: undefined, groupGone: true },
    'cleanup again': {
      result: 'resolved',
      lockPresent: false,
      bystanderAlive: undefined,
      groupGone: true,
    },
  },
  'own dead record, unrelated live group': guarded(),
  'own dead record, reused group': guarded(),
  'own record, reused pid': guarded(),
  'foreign live owner': guarded(),
  'foreign dead owner, unrelated live group': guarded(),
  'non-canonical worktree spelling': guarded(),
};

/** Every action refuses, leaves the record in place, and leaves the bystander running. */
function guarded(): Record<Action, Outcome> {
  const cell: Outcome = {
    result: 'refused',
    lockPresent: true,
    bystanderAlive: true,
    groupGone: undefined,
  };
  return { acquire: cell, retire: cell, cleanup: cell, 'cleanup again': cell };
}

const actions: readonly Action[] = ['acquire', 'retire', 'cleanup', 'cleanup again'];
const observed = new Map<string, Outcome>();
let cellIndex = 0;
for (const state of Object.keys(expected) as State[]) {
  for (const action of actions) {
    observed.set(`${state} / ${action}`, await run(state, action, cellIndex));
    cellIndex += 1;
  }
}

describe('owned process lease outcome matrix', () => {
  for (const state of Object.keys(expected) as State[]) {
    for (const action of actions) {
      test(`${state}: ${action}`, () => {
        expect(observed.get(`${state} / ${action}`)).toEqual(expected[state][action]);
      });
    }
  }
});
