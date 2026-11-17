/**
 * The outcome matrix of COR-2463: how the host lock (`scripts/run-exclusively.ts`), the admission
 * lock and the place ledgers (`scripts/host-sessions.ts`) behave when a reclaimer, an installer, a
 * `release` or an append is stopped at the worst moment. One scenario per row, M1 to M8.
 *
 * Each race is driven, not hoped for: the real code runs, and a spy on `node:fs/promises` pauses
 * one of its calls (the removal of a guard, the read of a lock's owner, a rename) while the
 * scenario lets the other party act. Nothing waits on the clock; ages are written with `utimes`.
 * The host lock judges its holders with `ps`, so the scenarios start processes and run once at
 * module scope, one after another, off Bun's per-test clock.
 */

import { describe, expect, spyOn, test } from 'bun:test';
import * as fileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type { ProcessEntry } from './bun-test-pool.ts';
import {
  dispatchKinds,
  exploreInterleavings,
  type DispatchKind,
} from './host-sessions-interleavings.ts';
import { applySessionEvent, type SessionEvent, type SessionState } from './host-sessions-model.ts';
import {
  admitWorker,
  appendEvent,
  handleHookEvent,
  hostPlaces,
  readSessions,
  releasePlace,
  type Admission,
  type AdmitOptions,
  type PlaceRequest,
} from './host-sessions.ts';
import { outcomeOf, rethrow } from './module-scope-scenario.test-support.ts';
import {
  ownerFileName,
  readOwner,
  reclaimAbandoned,
  removeLock,
  tryInstall,
  type OwnerRecord,
} from './run-exclusively.ts';

/** The real file system, for the scenario's own steps while a spy is in place. */
const real = {
  mkdir: fileSystem.mkdir,
  mkdtemp: fileSystem.mkdtemp,
  readdir: fileSystem.readdir,
  readFile: fileSystem.readFile,
  rename: fileSystem.rename,
  rm: fileSystem.rm,
  rmdir: fileSystem.rmdir,
  stat: fileSystem.stat,
  utimes: fileSystem.utimes,
  writeFile: fileSystem.writeFile,
};

type Method = 'mkdir' | 'readFile' | 'rename' | 'rm' | 'rmdir' | 'stat' | 'unlink';

const spiedMethods: readonly Method[] = [
  'mkdir',
  'readFile',
  'rename',
  'rm',
  'rmdir',
  'stat',
  'unlink',
];

type Interception = {
  /** The calls it may stop; the first matching call of any of them is the one. */
  readonly methods: readonly Method[];
  readonly matches: (args: readonly unknown[]) => boolean;
  /** Runs before the real call, which waits for it. */
  readonly before?: () => Promise<void>;
  /** Runs after the real call, whether it succeeded or not, before its caller resumes. */
  readonly after?: () => Promise<void>;
};

/**
 * Spies on the file system until the returned function is called: each interception stops the
 * first call it matches, once, and `onCall` hears every call before that.
 */
function interceptFileSystem(
  interceptions: readonly Interception[],
  onCall: (method: Method, args: readonly unknown[]) => void = () => {},
): () => void {
  const pending = [...interceptions];
  const spies = spiedMethods.map((method) => {
    const original = fileSystem[method] as (...args: unknown[]) => Promise<unknown>;
    const spy = spyOn(fileSystem, method);
    spy.mockImplementation((async (...args: unknown[]) => {
      onCall(method, args);
      const index = pending.findIndex(
        (each) => each.methods.includes(method) && each.matches(args),
      );
      const hit = index === -1 ? undefined : pending.splice(index, 1)[0];
      await hit?.before?.();
      try {
        return await original(...args);
      } finally {
        await hit?.after?.();
      }
    }) as never);
    return spy;
  });
  return () => {
    for (const spy of spies) spy.mockRestore();
  };
}

function gate(): { readonly opened: Promise<void>; readonly open: () => void } {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

type Settled<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
}

async function exists(path: string): Promise<boolean> {
  return real.stat(path).then(
    () => true,
    () => false,
  );
}

/** Backdates a directory a minute, past every grace period the reclaimers allow. */
async function age(path: string): Promise<void> {
  const minuteAgo = (Date.now() - 60_000) / 1000;
  await real.utimes(path, minuteAgo, minuteAgo);
}

/** Installs a lock the way `tryInstall` does, through the real file system. */
async function installDirectly(lockDirectory: string, owner: OwnerRecord): Promise<boolean> {
  const pending = `${lockDirectory}.direct-${owner.token}`;
  await real.mkdir(pending);
  await real.writeFile(join(pending, ownerFileName), JSON.stringify(owner));
  try {
    await real.rename(pending, lockDirectory);
    return true;
  } catch {
    await real.rm(pending, { recursive: true, force: true });
    return false;
  }
}

async function holderToken(lockDirectory: string): Promise<string | undefined> {
  const owner = await readOwner(lockDirectory);
  return owner?.token;
}

/** The tokens of every lock directory that names a holder: the lock itself and any moved aside. */
async function lockHolders(lockDirectory: string): Promise<string[]> {
  const prefix = basename(lockDirectory);
  const names = await real.readdir(dirname(lockDirectory));
  const holders: string[] = [];
  for (const name of names.toSorted()) {
    if (name !== prefix && !name.startsWith(`${prefix}.removed-`)) continue;
    const owner = await readOwner(join(dirname(lockDirectory), name));
    if (owner !== undefined) holders.push(owner.token);
  }
  return holders;
}

/** Runs one scenario in its own scratch directory and returns what it threw. */
function scenario(body: (directory: string) => Promise<void>): Promise<unknown> {
  return outcomeOf(async () => {
    const directory = await real.mkdtemp(join(tmpdir(), 'corvidae-reclaim-matrix-'));
    try {
      await body(directory);
    } finally {
      await real.rm(directory, { recursive: true, force: true });
    }
  });
}

// --- The admission lock's hosts and hooks ------------------------------------------------------

const claude = '/usr/local/bin/claude --output-format stream-json';

function entry(parent: number, command: string, startedAt = `started ${parent}`): ProcessEntry {
  return { parent, processGroup: parent, startedAt, command };
}

/** Session A is pid 400 with its hook 411, session B pid 500 with its hook 511. */
function hostTable(extra: ReadonlyArray<[number, ProcessEntry]> = []): Map<number, ProcessEntry> {
  return new Map<number, ProcessEntry>([
    [300, entry(1, '/sbin/launchd')],
    [400, entry(300, claude)],
    [410, entry(400, '/bin/sh -c bun scripts/host-sessions.ts hook')],
    [411, entry(410, 'bun scripts/host-sessions.ts hook')],
    [500, entry(300, claude)],
    [510, entry(500, '/bin/sh -c bun scripts/host-sessions.ts hook')],
    [511, entry(510, 'bun scripts/host-sessions.ts hook')],
    ...extra,
  ]);
}

function request(session: 'A' | 'B', toolUseId: string): PlaceRequest {
  const pid = session === 'A' ? 400 : 500;
  return {
    sessionId: `session-${session}`,
    dispatcher: '',
    toolUseId,
    description: `Deliver COR-${toolUseId}`,
    cwd: `/worktrees/${session}`,
    holder: { pid, pidStartedAt: 'started 300' },
    waiter: { pid: pid + 11, pidStartedAt: `started ${pid + 10}` },
  };
}

/** An injected clock whose waits advance it, and which gives up after `limit` waits. */
function boundedClock(limit: number) {
  const state = { now: 1_000_000, sleeps: 0 };
  return {
    state,
    now: () => state.now,
    sleep: async (milliseconds: number) => {
      state.sleeps += 1;
      if (state.sleeps > limit) throw new Error(`gave up after ${limit} waits`);
      state.now += milliseconds;
    },
  };
}

function admission(
  directory: string,
  session: 'A' | 'B',
  toolUseId: string,
  overrides: Partial<AdmitOptions> = {},
): Promise<Admission> {
  const time = boundedClock(20);
  return admitWorker({
    directory,
    request: request(session, toolUseId),
    readProcessTable: () => hostTable(),
    now: time.now,
    sleep: time.sleep,
    cap: 100,
    waitLimitMilliseconds: Number.POSITIVE_INFINITY,
    ...overrides,
  });
}

/** A hook that died holding the admission lock: its pid is in no table. */
const deadHook: OwnerRecord = {
  pid: 999_997,
  pidStartedAt: 'never',
  command: 'dead hook',
  cwd: '/',
  acquiredAt: '',
  token: 'dead-hook',
};

/** A host-lock holder that is gone: this process's pid, under a start time it never had. */
function goneHolder(token: string): OwnerRecord {
  return {
    pid: process.pid,
    pidStartedAt: 'Thu Jan  1 00:00:00 1970',
    command: 'gone',
    cwd: '/',
    acquiredAt: '',
    token,
  };
}

function admitted(settled: Settled<Admission> | undefined): boolean {
  return settled?.ok === true && settled.value.admitted;
}

// --- M1: the admission lock's reclaim guard ----------------------------------------------------

/**
 * A reclaimer died holding the guard, and two hooks find it stale. B judges it stale and is about
 * to remove it; another hook removes it first, and D creates a fresh guard and starts reclaiming.
 * B's removal must not take D's guard, and nobody may reclaim beside D.
 */
const m1StaleGuardRemovedTwice = await scenario(async (root) => {
  const directory = join(root, 'places');
  await real.mkdir(directory, { recursive: true });
  const lock = join(directory, 'admission');
  const guard = `${lock}.reclaiming`;
  const ownerFile = join(lock, ownerFileName);
  expect(await installDirectly(lock, deadHook)).toBe(true);
  await real.mkdir(guard);
  await age(guard);
  const dInside = gate();
  const releaseD = gate();
  let d: Promise<Settled<Admission>> | undefined;
  let bPaused = false;
  let dReclaiming = false;
  let guardAfterBRemoval: boolean | undefined;
  let readsBesideD = 0;
  const dispose = interceptFileSystem(
    [
      {
        methods: ['rm', 'rmdir'],
        matches: ([path]) => path === guard,
        before: async () => {
          bPaused = true;
          await real.rmdir(guard);
          d = settle(admission(directory, 'A', 'D'));
          await Promise.race([dInside.opened, d]);
          bPaused = false;
        },
        after: async () => {
          guardAfterBRemoval = await exists(guard);
        },
      },
      {
        methods: ['readFile'],
        matches: ([path]) => path === ownerFile && bPaused,
        before: async () => {
          dReclaiming = true;
          dInside.open();
          await releaseD.opened;
          dReclaiming = false;
        },
      },
    ],
    (method, [path]) => {
      if (method === 'readFile' && path === ownerFile && dReclaiming) readsBesideD += 1;
    },
  );
  let b: Settled<Admission>;
  try {
    b = await settle(admission(directory, 'A', 'B'));
  } finally {
    releaseD.open();
    await d;
    dispose();
  }
  expect({
    dReclaimed: d !== undefined,
    guardAfterBRemoval,
    readsBesideD,
    bAdmittedWhileDReclaimed: admitted(b),
    dAdmitted: admitted(await d),
  }).toEqual({
    dReclaimed: true,
    guardAfterBRemoval: true,
    readsBesideD: 0,
    bAdmittedWhileDReclaimed: false,
    dAdmitted: true,
  });
});

/**
 * B holds the guard and is reclaiming when an older checkout's hook, judging the guard by its age
 * alone, removes it, and D takes a new guard. B's cleanup must leave D's guard, so a third hook E
 * cannot reclaim beside D.
 */
const m1GuardReplacedWhileInside = await scenario(async (root) => {
  const directory = join(root, 'places');
  await real.mkdir(directory, { recursive: true });
  const lock = join(directory, 'admission');
  const guard = `${lock}.reclaiming`;
  const ownerFile = join(lock, ownerFileName);
  expect(await installDirectly(lock, deadHook)).toBe(true);
  const dInside = gate();
  const releaseD = gate();
  let d: Promise<Settled<Admission>> | undefined;
  let bPaused = false;
  let dReclaiming = false;
  let counting = false;
  let readsBesideD = 0;
  const dispose = interceptFileSystem(
    [
      {
        methods: ['readFile'],
        matches: ([path]) => path === ownerFile,
        before: async () => {
          bPaused = true;
          await real.rm(guard, { recursive: true, force: true });
          d = settle(admission(directory, 'A', 'D'));
          await Promise.race([dInside.opened, d]);
          bPaused = false;
        },
      },
      {
        methods: ['readFile'],
        matches: ([path]) => path === ownerFile && bPaused,
        before: async () => {
          dReclaiming = true;
          dInside.open();
          await releaseD.opened;
          dReclaiming = false;
        },
      },
    ],
    (method, [path]) => {
      if (method === 'readFile' && path === ownerFile && dReclaiming && counting) readsBesideD += 1;
    },
  );
  let guardAfterB: boolean | undefined;
  let e: Settled<Admission> | undefined;
  try {
    await settle(admission(directory, 'A', 'B'));
    guardAfterB = await exists(guard);
    counting = true;
    // E finds an abandoned lock again while D is still reclaiming.
    await installDirectly(lock, { ...deadHook, token: 'dead-again' });
    e = await settle(admission(directory, 'A', 'E'));
  } finally {
    releaseD.open();
    await d;
    dispose();
  }
  expect({
    dReclaimed: d !== undefined,
    guardAfterB,
    readsBesideD,
    eAdmittedWhileDReclaimed: admitted(e),
  }).toEqual({
    dReclaimed: true,
    guardAfterB: true,
    readsBesideD: 0,
    eAdmittedWhileDReclaimed: false,
  });
});

// --- M2: the host lock's reclaim guard ---------------------------------------------------------

/** M1's first interleaving against `reclaimAbandoned`, which the host lock and the test pool use. */
const m2StaleGuardRemovedTwice = await scenario(async (root) => {
  const lock = join(root, 'host-lock');
  const guard = `${lock}.reclaiming`;
  const ownerFile = join(lock, ownerFileName);
  expect(await installDirectly(lock, goneHolder('gone'))).toBe(true);
  await real.mkdir(guard);
  await age(guard);
  const dInside = gate();
  const releaseD = gate();
  let d: Promise<Settled<unknown>> | undefined;
  let bPaused = false;
  let dReclaiming = false;
  let guardAfterBRemoval: boolean | undefined;
  let readsBesideD = 0;
  const dispose = interceptFileSystem(
    [
      {
        methods: ['rm', 'rmdir'],
        matches: ([path]) => path === guard,
        before: async () => {
          bPaused = true;
          await real.rmdir(guard);
          d = settle(reclaimAbandoned(lock, 10_000));
          await Promise.race([dInside.opened, d]);
          bPaused = false;
        },
        after: async () => {
          guardAfterBRemoval = await exists(guard);
        },
      },
      {
        methods: ['readFile'],
        matches: ([path]) => path === ownerFile && bPaused,
        before: async () => {
          dReclaiming = true;
          dInside.open();
          await releaseD.opened;
          dReclaiming = false;
        },
      },
    ],
    (method, [path]) => {
      if (method === 'readFile' && path === ownerFile && dReclaiming) readsBesideD += 1;
    },
  );
  try {
    await reclaimAbandoned(lock, 10_000);
    // E finds the lock abandoned while D is still reclaiming it.
    await reclaimAbandoned(lock, 10_000);
  } finally {
    releaseD.open();
    await d;
    dispose();
  }
  expect({
    dReclaimed: d !== undefined,
    guardAfterBRemoval,
    readsBesideD,
    lockLeft: await exists(lock),
    guardLeft: await exists(guard),
  }).toEqual({
    dReclaimed: true,
    guardAfterBRemoval: true,
    readsBesideD: 0,
    lockLeft: false,
    guardLeft: false,
  });
});

/**
 * B holds the host lock's guard and is reclaiming when an older checkout's reclaimer, judging the
 * guard by its age alone, removes it if it can, and D tries to reclaim. D must not reclaim beside B.
 */
const m2GuardReplacedWhileInside = await scenario(async (root) => {
  const lock = join(root, 'host-lock');
  const guard = `${lock}.reclaiming`;
  const ownerFile = join(lock, ownerFileName);
  expect(await installDirectly(lock, goneHolder('gone'))).toBe(true);
  const dInside = gate();
  let d: Promise<Settled<unknown>> | undefined;
  let bPaused = false;
  let dReclaimedBesideB = false;
  const dispose = interceptFileSystem([
    {
      methods: ['readFile'],
      matches: ([path]) => path === ownerFile,
      before: async () => {
        bPaused = true;
        await age(guard);
        await real.rmdir(guard).catch(() => undefined);
        d = settle(reclaimAbandoned(lock, 10_000));
        await Promise.race([dInside.opened, d]);
        bPaused = false;
      },
    },
    {
      methods: ['readFile'],
      matches: ([path]) => path === ownerFile && bPaused,
      before: async () => {
        dReclaimedBesideB = true;
        dInside.open();
      },
    },
  ]);
  try {
    await reclaimAbandoned(lock, 10_000);
  } finally {
    await d;
    dispose();
  }
  expect({
    dReclaimedBesideB,
    lockLeft: await exists(lock),
    guardLeft: await exists(guard),
  }).toEqual({ dReclaimedBesideB: false, lockLeft: false, guardLeft: false });
});

// --- M3: removing a lock that is not the one expected -------------------------------------------

const liveHolder = (token: string): OwnerRecord => ({
  pid: process.pid,
  command: token,
  cwd: '/',
  acquiredAt: '',
  token,
});

/**
 * A remover whose reading is stale (it expects X) meets the live lock Y, while installer Z keeps
 * trying. Y must stay the only holder.
 */
const m3StaleRemoverMeetsLiveLock = await scenario(async (root) => {
  const lock = join(root, 'host-lock');
  expect(await installDirectly(lock, liveHolder('Y'))).toBe(true);
  let zInstalled: boolean | undefined;
  const dispose = interceptFileSystem([
    {
      methods: ['rename'],
      matches: ([from]) => from === lock,
      after: async () => {
        zInstalled = await installDirectly(lock, liveHolder('Z'));
      },
    },
  ]);
  try {
    await removeLock(lock, liveHolder('X'));
  } finally {
    dispose();
  }
  zInstalled ??= await installDirectly(lock, liveHolder('Z'));
  expect({ zInstalled, holders: await lockHolders(lock) }).toEqual({
    zInstalled: false,
    holders: ['Y'],
  });
});

/**
 * The expected lock X is replaced by Y just before the move, and Z installs before Y can be put
 * back. The failed move back must be surfaced, naming where Y was left.
 */
const m3MoveBackFails = await scenario(async (root) => {
  const lock = join(root, 'host-lock');
  expect(await installDirectly(lock, liveHolder('X'))).toBe(true);
  const dispose = interceptFileSystem([
    {
      methods: ['rename'],
      matches: ([from]) => from === lock,
      before: async () => {
        await real.rm(lock, { recursive: true, force: true });
        expect(await installDirectly(lock, liveHolder('Y'))).toBe(true);
      },
    },
    {
      methods: ['rename'],
      matches: ([from, to]) => to === lock && String(from).startsWith(`${lock}.removed-`),
      before: async () => {
        expect(await installDirectly(lock, liveHolder('Z'))).toBe(true);
      },
    },
  ]);
  let removal: Settled<void>;
  try {
    removal = await settle(removeLock(lock, liveHolder('X')));
  } finally {
    dispose();
  }
  expect(removal.ok).toBe(false);
  const message = removal.ok ? '' : (removal.error as Error).message;
  expect(message).toContain(`${lock}.removed-`);
  expect(await lockHolders(lock)).toEqual(['Z', 'Y']);
});

// --- M4: an installer that stalls between its owner write and its rename ------------------------

const m4StalledInstaller = await scenario(async (root) => {
  const lock = join(root, 'host-lock');
  const installer = liveHolder('I');
  const pending = `${lock}.pending-${installer.token}`;
  const installerStalled = gate();
  const releaseInstaller = gate();
  let installing: Promise<Settled<boolean>> | undefined;
  let lockMoved = 0;
  const dispose = interceptFileSystem(
    [
      {
        methods: ['rename'],
        matches: ([from, to]) => from === pending && to === lock,
        before: async () => {
          await age(pending);
          installerStalled.open();
          await releaseInstaller.opened;
        },
      },
      {
        methods: ['readFile'],
        matches: ([path]) => path === join(lock, ownerFileName),
        after: async () => {
          releaseInstaller.open();
          await installing;
        },
      },
    ],
    (method, [from]) => {
      if (method === 'rename' && from === lock) lockMoved += 1;
    },
  );
  try {
    installing = settle(tryInstall(lock, installer));
    await installerStalled.opened;
    await reclaimAbandoned(lock, 10_000);
  } finally {
    releaseInstaller.open();
    await installing;
    dispose();
  }
  const installed = await installing;
  expect({
    installed: installed?.ok ? installed.value : undefined,
    lockMoved,
    holder: await holderToken(lock),
  }).toEqual({ installed: true, lockMoved: 0, holder: 'I' });
});

/**
 * Removing an ownerless lock, or looking at it, fails for a reason other than a race (a
 * permission). The reclaim throws it rather than reading it as a lock still held, which the waiter
 * would wait on for ever, and leaves the lock and no guard.
 */
async function reclaimFailing(root: string, method: Method): Promise<unknown> {
  const lock = join(root, `host-lock-${method}`);
  await real.mkdir(lock);
  await age(lock);
  const denied = Object.assign(new Error(`${method} denied`), { code: 'EPERM' });
  const dispose = interceptFileSystem([
    {
      methods: [method],
      matches: ([path]) => path === lock,
      before: () => Promise.reject(denied),
    },
  ]);
  let reclaim: Settled<boolean>;
  try {
    reclaim = await settle(reclaimAbandoned(lock, 0));
  } finally {
    dispose();
  }
  expect({ lockLeft: await exists(lock), guardLeft: await exists(`${lock}.reclaiming`) }).toEqual({
    lockLeft: true,
    guardLeft: false,
  });
  return reclaim.ok ? reclaim.value : errorCodeOf(reclaim.error);
}

function errorCodeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

const m4UnexpectedFailureThrown = await scenario(async (root) => {
  expect({
    rmdir: await reclaimFailing(root, 'rmdir'),
    stat: await reclaimFailing(root, 'stat'),
  }).toEqual({ rmdir: 'EPERM', stat: 'EPERM' });
});

// --- M5: a `release` killed holding the admission lock, its pid reused ---------------------------

const m5ReleaseKilledPidReused = await scenario(async (root) => {
  const directory = join(root, 'places');
  await real.mkdir(directory, { recursive: true });
  const lock = join(directory, 'admission');
  const releaseRan = hostTable([
    [600, entry(300, 'bun scripts/host-sessions.ts release', 'Mon Nov 16 10:00:00 2026')],
  ]);
  const pidReused = hostTable([[600, entry(300, 'vim', 'Mon Nov 16 11:00:00 2026')]]);
  let recorded: OwnerRecord | undefined;
  const dispose = interceptFileSystem([
    {
      methods: ['rename'],
      matches: ([, to]) => to === lock,
      after: async () => {
        recorded = JSON.parse(
          await real.readFile(join(lock, ownerFileName), 'utf8'),
        ) as OwnerRecord;
      },
    },
  ]);
  try {
    const time = boundedClock(20);
    await settle(
      releasePlace(directory, 'nothing-held', {
        readProcessTable: () => releaseRan,
        now: time.now,
        sleep: time.sleep,
        pid: 600,
      }),
    );
  } finally {
    dispose();
  }
  // The release was killed holding the lock, and its pid now runs something else.
  expect(recorded !== undefined && (await installDirectly(lock, recorded))).toBe(true);
  const time = boundedClock(5);
  const next = await settle(
    admission(directory, 'A', 'next', {
      readProcessTable: () => pidReused,
      now: time.now,
      sleep: time.sleep,
    }),
  );
  expect({
    recordedStartTime: recorded?.pidStartedAt,
    admitted: admitted(next),
    waits: time.state.sleeps,
  }).toEqual({ recordedStartTime: 'Mon Nov 16 10:00:00 2026', admitted: true, waits: 0 });
});

// --- M6: an owner record from an older checkout, without a start time ---------------------------

const m6OwnerWithoutStartTime = await scenario(async (root) => {
  const directory = join(root, 'places');
  await real.mkdir(directory, { recursive: true });
  const admissionLock = join(directory, 'admission');
  const olderHook: OwnerRecord = {
    pid: 511,
    command: 'older hook',
    cwd: '/',
    acquiredAt: '',
    token: 'older-hook',
  };
  expect(await installDirectly(admissionLock, olderHook)).toBe(true);
  const time = boundedClock(3);
  const waited = await settle(
    admission(directory, 'A', 'waits', { now: time.now, sleep: time.sleep }),
  );
  const hostLock = join(root, 'host-lock');
  const olderWrapper: OwnerRecord = { ...liveHolder('older-wrapper') };
  expect(await installDirectly(hostLock, olderWrapper)).toBe(true);
  await reclaimAbandoned(hostLock, 0);
  expect({
    hookAdmitted: admitted(waited),
    hookLock: await holderToken(admissionLock),
    hostLock: await holderToken(hostLock),
  }).toEqual({ hookAdmitted: false, hookLock: 'older-hook', hostLock: 'older-wrapper' });
});

// --- M7: an append racing the removal of its session's ledger -----------------------------------

async function sessionIds(directory: string): Promise<string[]> {
  const ledgers = await readSessions(directory);
  return ledgers.map((ledger) => ledger.sessionId);
}

async function ledgersWithoutHolder(directory: string): Promise<string[]> {
  const sessions = join(directory, 'sessions');
  const names = await real.readdir(sessions).catch(() => [] as string[]);
  const missing: string[] = [];
  for (const name of names.toSorted()) {
    if (!(await exists(join(sessions, name, 'holder.json')))) missing.push(name);
  }
  return missing;
}

/** B's hook read B's ledger, the next admission removed it (B's process is gone), then B's append lands. */
const m7AppendAfterRemoval = await scenario(async (root) => {
  const directory = join(root, 'places');
  expect(admitted(await settle(admission(directory, 'B', 'b1')))).toBe(true);
  const sessionBGone = hostTable().set(500, entry(300, 'vim', 'later'));
  expect(
    admitted(
      await settle(admission(directory, 'A', 'a1', { readProcessTable: () => sessionBGone })),
    ),
  ).toBe(true);
  expect(await sessionIds(directory)).toEqual(['session-A']);
  await settle(appendEvent(directory, 'session-B', { kind: 'start', agentId: 'agent-b', at: 0 }));
  expect(
    admitted(
      await settle(admission(directory, 'A', 'a2', { readProcessTable: () => sessionBGone })),
    ),
  ).toBe(true);
  expect({
    withoutHolder: await ledgersWithoutHolder(directory),
    sessions: await sessionIds(directory),
  }).toEqual({ withoutHolder: [], sessions: ['session-A'] });
});

/** A ledger an older checkout's append recreated without its holder file is reclaimed by the next admission. */
const m7LedgerWithoutHolder = await scenario(async (root) => {
  const directory = join(root, 'places');
  const events = join(directory, 'sessions', 'session-C', 'events');
  await real.mkdir(events, { recursive: true });
  const start = { kind: 'start', agentId: 'agent-c', at: 0, sessionId: 'session-C' };
  await real.writeFile(join(events, '000000000001.json'), JSON.stringify(start));
  expect(admitted(await settle(admission(directory, 'A', 'a1')))).toBe(true);
  expect({
    withoutHolder: await ledgersWithoutHolder(directory),
    sessions: await sessionIds(directory),
  }).toEqual({ withoutHolder: [], sessions: ['session-A'] });
});

/**
 * An admission's survey read session C's ledger without a holder and is about to remove it, when
 * C's `SubagentStart` records C's live process and the agent's start in that ledger. The removal
 * must not take the start with it: C's running agent keeps its places.
 */
const m7StartBesideTheSurvey = await scenario(async (root) => {
  const directory = join(root, 'places');
  const ledger = join(directory, 'sessions', 'session-C');
  await real.mkdir(join(ledger, 'events'), { recursive: true });
  const stale = { kind: 'start', agentId: 'agent-old', at: 0, sessionId: 'session-C' };
  await real.writeFile(join(ledger, 'events', '000000000001.json'), JSON.stringify(stale));
  const startWaits = gate();
  const admissionDone = gate();
  let starting: Promise<Settled<unknown>> | undefined;
  const dispose = interceptFileSystem([
    {
      methods: ['rename'],
      matches: ([from]) => from === ledger,
      before: async () => {
        starting = settle(
          handleHookEvent(
            {
              hook_event_name: 'SubagentStart',
              session_id: 'session-C',
              agent_id: 'agent-new',
              agent_type: 'chef-worker',
              cwd: '/worktrees/C',
            },
            {
              directory,
              hookPid: 511,
              environment: {},
              readProcessTable: () => hostTable(),
              now: () => 1_000_000,
              sleep: async () => {
                startWaits.open();
                await admissionDone.opened;
              },
            },
          ),
        );
        await Promise.race([starting, startWaits.opened]);
      },
    },
  ]);
  let surveyed: Settled<Admission>;
  try {
    surveyed = await settle(admission(directory, 'A', 'a1'));
  } finally {
    admissionDone.open();
    await starting;
    dispose();
  }
  const ledgers = await readSessions(directory);
  const sessionC = ledgers.filter((each) => each.sessionId === 'session-C');
  const started = await starting;
  expect({
    admitted: admitted(surveyed),
    startRecorded: started?.ok,
    holder: sessionC[0]?.holder?.pid,
    places: hostPlaces(sessionC),
  }).toEqual({ admitted: true, startRecorded: true, holder: 500, places: 2 });
});

// --- M8: the interleaving exploration covers expiry and release ---------------------------------

function without(kind: SessionEvent['kind']) {
  return (state: SessionState, event: SessionEvent): SessionState =>
    event.kind === kind ? state : applySessionEvent(state, event);
}

function explore(
  reclaimKind: DispatchKind,
  apply?: (state: SessionState, event: SessionEvent) => SessionState,
): string[] {
  const failures: string[] = [];
  for (const other of dispatchKinds) {
    for (const kinds of [
      [reclaimKind, other],
      [other, reclaimKind],
    ] as DispatchKind[][]) {
      failures.push(...exploreInterleavings(kinds, false, apply).failures);
    }
  }
  return failures;
}

const m8ExplorationCoversExpiryAndRelease = await scenario(async () => {
  expect({
    expiry: explore('expired'),
    release: explore('released'),
    withoutExpiryFails: explore('expired', without('expire')).length > 0,
    withoutReleaseFails: explore('released', without('release')).length > 0,
  }).toEqual({ expiry: [], release: [], withoutExpiryFails: true, withoutReleaseFails: true });
});

describe('the COR-2463 outcome matrix', () => {
  test('M1: a hook that removes a stale admission guard never removes the fresh guard another hook made, and no second hook reclaims beside it', () =>
    rethrow(m1StaleGuardRemovedTwice));

  test('M1: a hook whose admission guard was replaced while it reclaimed leaves the replacement, so no third hook reclaims beside it', () =>
    rethrow(m1GuardReplacedWhileInside));

  test('M2: the host lock guard, removed twice as stale, keeps the fresh guard and one reclaimer', () =>
    rethrow(m2StaleGuardRemovedTwice));

  test('M2: a reclaimer of the host lock cannot be joined by a second one after an older reclaimer clears its guard', () =>
    rethrow(m2GuardReplacedWhileInside));

  test('M3: removing a lock that is not the one expected never moves it, so it stays the only holder', () =>
    rethrow(m3StaleRemoverMeetsLiveLock));

  test('M3: a lock moved aside that cannot be put back is reported, not swallowed', () =>
    rethrow(m3MoveBackFails));

  test('M4: a lock whose installer is live is never moved, however long the install stalled', () =>
    rethrow(m4StalledInstaller));

  test('M4: a failure to look at or remove an ownerless lock, other than a race, is thrown, never waited on', () =>
    rethrow(m4UnexpectedFailureThrown));

  test('M5: a release killed holding the admission lock records its start time, so a reused pid does not hold the lock', () =>
    rethrow(m5ReleaseKilledPidReused));

  test('M6: an owner record without a start time is judged by its pid, and a live one is not reclaimed', () =>
    rethrow(m6OwnerWithoutStartTime));

  test('M7: an append after its ledger was removed leaves no ledger without its holder', () =>
    rethrow(m7AppendAfterRemoval));

  test('M7: the next admission reclaims a ledger left without its holder', () =>
    rethrow(m7LedgerWithoutHolder));

  test('M7: a start recorded while the survey removes its ledger as holderless keeps its places', () =>
    rethrow(m7StartBesideTheSurvey));

  test('M8: the exploration covers expiry and release, and fails without either step', () =>
    rethrow(m8ExplorationCoversExpiryAndRelease));
});
