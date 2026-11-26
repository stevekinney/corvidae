import { afterAll, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnPipedWithHangGuard, spawnWithHangGuard } from '../testing/testing/src/hang-guard.ts';
import { waitUntil } from '../testing/testing/src/wait-until.ts';
import { acquireOwnedProcessLease, retireOwnedProcessLease } from './owned-process-lease.ts';
import { processStartTime } from './run-exclusively.ts';

const root = mkdtempSync(join(tmpdir(), 'owned-process-lease-'));
const collisionPath = join(root, 'collision-lock');
const collisionOwner = await acquireOwnedProcessLease(collisionPath, root, 'collision owner');
let collisionObserved = false;
const collisionWaiter = await acquireOwnedProcessLease(
  collisionPath,
  root,
  'collision waiter',
  undefined,
  async () => {
    collisionObserved = true;
    await collisionOwner.release();
  },
);
await collisionWaiter.release();

/**
 * The identity a real lease publishes for an owner that has since died: the process's own pid and
 * start time as `ps` reports them, and the canonical (symlink-free) worktree. The synthetic owners
 * below carry it, so a fixture is judged by the runtime's canonical-path ownership check the way a
 * lease that a real process left behind would be.
 */
async function deadOwnerRecord(worktree: string, command: string) {
  const owner = spawnWithHangGuard([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  await waitUntil(() => processStartTime(owner.pid) !== undefined, {
    message: 'dead owner identity',
  });
  const pidStartedAt = processStartTime(owner.pid);
  owner.kill('SIGKILL');
  await owner.exited;
  return {
    pid: owner.pid,
    pidStartedAt,
    cwd: realpathSync(worktree),
    command,
    acquiredAt: new Date().toISOString(),
    token: crypto.randomUUID(),
  };
}

/** Two waiters contend while a retirement holds the reclaim guard, then both lease in turn. */
async function concurrentReclaim(worktree: string, name: string) {
  const reclaimPath = join(worktree, name);
  mkdirSync(reclaimPath);
  writeFileSync(
    join(reclaimPath, 'owner.json'),
    JSON.stringify(await deadOwnerRecord(worktree, 'dead owner')),
  );
  let releaseGuard!: () => void;
  let guardHeld!: () => void;
  const guardReady = new Promise<void>((resolve) => {
    guardHeld = resolve;
  });
  const guardWait = new Promise<void>((resolve) => {
    releaseGuard = resolve;
  });
  const retirement = retireOwnedProcessLease(reclaimPath, worktree, undefined, async () => {
    guardHeld();
    await guardWait;
  });
  await guardReady;
  let collisions = 0;
  let busyGuards = 0;
  const waiter = () =>
    acquireOwnedProcessLease(
      reclaimPath,
      worktree,
      'waiter',
      undefined,
      () => {
        collisions += 1;
      },
      () => {
        busyGuards += 1;
      },
    );
  const firstWaiter = waiter();
  const secondWaiter = waiter();
  await waitUntil(() => busyGuards >= 2, {
    message: 'both contenders to encounter the held reclaim guard',
  });
  releaseGuard();
  await retirement;
  const acquired = await Promise.race([
    firstWaiter.then((lease) => ({ lease, other: secondWaiter })),
    secondWaiter.then((lease) => ({ lease, other: firstWaiter })),
  ]);
  await acquired.lease.release();
  const remainingWaiter = await acquired.other;
  await remainingWaiter.release();
  return { collisions, busyGuards, remaining: existsSync(reclaimPath) };
}

// The default spelling of the temporary directory: on macOS `tmpdir()` is under `/var`, a symlink
// to `/private/var`, so this spelling differs from the canonical one a lease records.
const reclaim = await concurrentReclaim(root, 'reclaim-lock');
// A deliberately aliased temporary parent: the worktree is named through a symlink on every
// platform, so the checkpoint is reached however the operating system spells its temporary folder.
const aliasedTarget = join(root, 'aliased-target');
mkdirSync(aliasedTarget);
const aliasedRoot = join(root, 'alias');
symlinkSync(aliasedTarget, aliasedRoot);
const aliasedReclaim = await concurrentReclaim(aliasedRoot, 'reclaim-lock');
// An owner record that names the worktree by a non-canonical spelling is not this lease's identity:
// acquisition and retirement both refuse it, and leave it where it is.
const spelledPath = join(aliasedTarget, 'spelled-lock');
mkdirSync(spelledPath);
writeFileSync(
  join(spelledPath, 'owner.json'),
  JSON.stringify({
    ...(await deadOwnerRecord(aliasedTarget, 'spelled owner')),
    cwd: aliasedRoot,
  }),
);
const spelledAcquire = await acquireOwnedProcessLease(spelledPath, aliasedRoot, 'spelled').then(
  () => undefined,
  (error: unknown) => error,
);
const spelledRetire = await retireOwnedProcessLease(spelledPath, aliasedRoot).then(
  () => undefined,
  (error: unknown) => error,
);
const livePath = join(root, 'live-lock');
const live = await acquireOwnedProcessLease(livePath, root, 'live control');
const liveRefusal = await retireOwnedProcessLease(livePath, root).then(
  () => undefined,
  (error: unknown) => error,
);
await live.release();
await retireOwnedProcessLease(livePath, root);
await retireOwnedProcessLease(livePath, root);
const unknownPath = join(root, 'unknown-lock');
mkdirSync(unknownPath);
const unknownAcquire = await acquireOwnedProcessLease(unknownPath, root, 'unknown control').then(
  () => undefined,
  (error: unknown) => error,
);
const unknownRetire = await retireOwnedProcessLease(unknownPath, root).then(
  () => undefined,
  (error: unknown) => error,
);
const foreignPath = join(root, 'foreign-lock');
mkdirSync(foreignPath);
const foreign = spawnWithHangGuard([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
  stdout: 'ignore',
  stderr: 'ignore',
});
let foreignRefusal: unknown;
let foreignStayedAlive = false;
try {
  await waitUntil(() => processStartTime(foreign.pid) !== undefined, {
    message: 'foreign process identity',
  });
  writeFileSync(
    join(foreignPath, 'owner.json'),
    JSON.stringify({
      pid: 99999999,
      pidStartedAt: 'previous owner',
      processGroup: foreign.pid,
      processGroupStartedAt: processStartTime(foreign.pid),
      cwd: realpathSync(root),
      command: 'foreign control',
      acquiredAt: new Date().toISOString(),
      token: crypto.randomUUID(),
    }),
  );
  foreignRefusal = await retireOwnedProcessLease(foreignPath, root).then(
    () => undefined,
    (error: unknown) => error,
  );
  foreignStayedAlive = foreign.exitCode === null;
} finally {
  foreign.kill('SIGTERM');
  await foreign.exited;
}

const owner = spawnPipedWithHangGuard([
  process.execPath,
  join(import.meta.dir, 'owned-process-lease.test-support.ts'),
  root,
]);
void new Response(owner.stdout).text();
void new Response(owner.stderr).text();
let ownerStopped = false;
let listenerResponse = '';
let ownerExit: number | null = 0;
let listenerClosed = false;
let expiredRefusal: unknown;
let listenerAfterExpiry = 0;
try {
  const urlPath = join(root, 'listener-url');
  await waitUntil(() => existsSync(urlPath), { message: 'owned listener to bind' });
  const url = readFileSync(urlPath, 'utf8');
  const listener = await fetch(url);
  listenerResponse = await listener.text();
  owner.kill('SIGKILL');
  ownerExit = await owner.exited;
  ownerStopped = true;
  expiredRefusal = await retireOwnedProcessLease(join(root, 'process-lock'), root, 0).then(
    () => undefined,
    (error: unknown) => error,
  );
  const expiredResponse = await fetch(url);
  listenerAfterExpiry = expiredResponse.status;
  await retireOwnedProcessLease(join(root, 'process-lock'), root);
  await retireOwnedProcessLease(join(root, 'process-lock'), root);
  listenerClosed = await fetch(url).then(
    () => false,
    () => true,
  );
} finally {
  if (!ownerStopped) owner.kill('SIGKILL');
}
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('refuses a live owner and makes repeated cleanup harmless', () => {
  expect(liveRefusal).toBeInstanceOf(Error);
  expect((liveRefusal as Error).message).toContain('live');
  expect(existsSync(livePath)).toBe(false);
});

test.each([
  ['the default temporary spelling', reclaim],
  ['an aliased temporary parent', aliasedReclaim],
])('ordinary waiters survive release and concurrent reclamation under %s', (_name, result) => {
  expect(collisionObserved).toBe(true);
  expect(result.collisions).toBeGreaterThanOrEqual(2);
  expect(result.busyGuards).toBeGreaterThanOrEqual(2);
  expect(result.remaining).toBe(false);
});

test('refuses an owner that names the worktree by a non-canonical spelling', () => {
  expect(spelledAcquire).toBeInstanceOf(Error);
  expect(spelledRetire).toBeInstanceOf(Error);
  expect(existsSync(join(spelledPath, 'owner.json'))).toBe(true);
});

test('does not replace or reclaim an ownerless lock directory', () => {
  expect(unknownAcquire).toBeInstanceOf(Error);
  expect(unknownRetire).toBeInstanceOf(Error);
  expect(existsSync(unknownPath)).toBe(true);
});

test('never signals a live process without the recorded gate identity', () => {
  expect(foreignRefusal).toBeInstanceOf(Error);
  expect(foreignStayedAlive).toBe(true);
  expect(existsSync(foreignPath)).toBe(true);
});

test('reclaims a killed owner’s verified listener group twice', () => {
  expect(listenerResponse).toBe('alive');
  expect(ownerExit).not.toBe(0);
  expect(listenerClosed).toBe(true);
  expect(expiredRefusal).toBeInstanceOf(Error);
  expect(listenerAfterExpiry).toBe(200);
  expect(existsSync(join(root, 'process-lock'))).toBe(false);
});
