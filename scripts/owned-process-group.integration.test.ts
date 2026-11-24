import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnPipedWithHangGuard } from '../testing/testing/src/hang-guard.ts';
import { waitUntil } from '../testing/testing/src/wait-until.ts';
import { processIsAlive } from './owned-process-group.test-support.ts';
import { runOwnedProcessGroup } from './owned-process-group.ts';

const root = mkdtempSync(join(tmpdir(), 'owned-process-group-'));
const completed = join(root, 'completed');
const forbidden = join(root, 'forbidden');
let existedDuringRegistration = true;
let registeredPid = 0;
let registeredStart = '';
const exit = await runOwnedProcessGroup({
  command: [process.execPath, '-e', 'await Bun.write(process.argv[1], "completed")', completed],
  cwd: root,
  environment: process.env,
  register: async (pid, startedAt) => {
    registeredPid = pid;
    registeredStart = startedAt;
    existedDuringRegistration = existsSync(completed);
  },
});
const rejected = await runOwnedProcessGroup({
  command: [process.execPath, '-e', 'await Bun.write(process.argv[1], "forbidden")', forbidden],
  cwd: root,
  environment: process.env,
  register: async () => {
    throw new Error('registration failed');
  },
}).then(
  () => undefined,
  (error: unknown) => error,
);
const originalTarget = join(root, 'original-command');
const changedTarget = join(root, 'changed-command');
const mutableCommand = [
  process.execPath,
  '-e',
  'await Bun.write(process.argv[1], "original")',
  originalTarget,
];
const snapshotExit = await runOwnedProcessGroup({
  command: mutableCommand,
  cwd: root,
  environment: process.env,
  register: async () => {
    mutableCommand[3] = changedTarget;
  },
});
const owner = spawnPipedWithHangGuard([
  process.execPath,
  join(import.meta.dir, 'owned-process-group.test-support.ts'),
  root,
]);
void new Response(owner.stdout).text();
void new Response(owner.stderr).text();
let ownerExit: number | null;
let gatePid = 0;
let ownerStopped = false;
try {
  await waitUntil(() => existsSync(join(root, 'gate-pid')), {
    message: 'the child gate registration',
  });
  gatePid = Number(readFileSync(join(root, 'gate-pid'), 'utf8'));
  owner.kill('SIGKILL');
  ownerExit = await owner.exited;
  ownerStopped = true;
  await waitUntil(() => !processIsAlive(gatePid), {
    message: 'the unapproved gate to exit after owner death',
  });
} finally {
  if (!ownerStopped) owner.kill('SIGKILL');
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

test('does no work before recording a process identity', () => {
  expect(registeredPid).toBeGreaterThan(0);
  expect(registeredStart).not.toBe('');
  expect(existedDuringRegistration).toBe(false);
  expect(exit).toBe(0);
  expect(existsSync(completed)).toBe(true);
});

test('does no work when registration fails', () => {
  expect(rejected).toBeInstanceOf(Error);
  expect((rejected as Error).message).toBe('registration failed');
  expect(existsSync(forbidden)).toBe(false);
});

test('runs the command captured before registration, even if its caller changes the array', () => {
  expect(snapshotExit).toBe(0);
  expect(readFileSync(originalTarget, 'utf8')).toBe('original');
  expect(existsSync(changedTarget)).toBe(false);
});

test('a killed owner cannot release an unregistered gate', () => {
  expect(ownerExit).not.toBe(0);
  expect(gatePid).toBeGreaterThan(0);
  expect(processIsAlive(gatePid)).toBe(false);
  expect(existsSync(join(root, 'after-owner-death'))).toBe(false);
});
