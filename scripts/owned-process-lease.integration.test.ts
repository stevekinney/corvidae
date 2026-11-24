import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const reclaimPath = join(root, 'reclaim-lock');
mkdirSync(reclaimPath);
writeFileSync(
  join(reclaimPath, 'owner.json'),
  JSON.stringify({
    pid: 99999999,
    pidStartedAt: 'dead',
    cwd: root,
    command: 'dead owner',
    acquiredAt: new Date().toISOString(),
    token: crypto.randomUUID(),
  }),
);
let releaseGuard!: () => void;
let guardHeld!: () => void;
const guardReady = new Promise<void>((resolve) => {
  guardHeld = resolve;
});
const guardWait = new Promise<void>((resolve) => {
  releaseGuard = resolve;
});
const retirement = retireOwnedProcessLease(reclaimPath, root, undefined, async () => {
  guardHeld();
  await guardWait;
});
await guardReady;
let collisions = 0;
let busyGuards = 0;
const waiter = () =>
  acquireOwnedProcessLease(
    reclaimPath,
    root,
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
      cwd: root,
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

test('ordinary waiters survive release and concurrent reclamation', () => {
  expect(collisionObserved).toBe(true);
  expect(collisions).toBeGreaterThanOrEqual(2);
  expect(busyGuards).toBeGreaterThanOrEqual(2);
  expect(existsSync(reclaimPath)).toBe(false);
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
