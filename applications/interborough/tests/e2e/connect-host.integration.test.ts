import { runWithHangGuard } from '@lostgradient/testing/hang-guard';
import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'connect-port-'));
const fixture = join(import.meta.dir, 'connect-host.test-support.ts');
const hostSlots = join(import.meta.dir, '../../../../scripts/host-slots.ts');
const command = (mode: string) => [
  process.execPath,
  hostSlots,
  '--slots=1',
  '--',
  process.execPath,
  fixture,
  directory,
  mode,
];
let collision: Awaited<ReturnType<typeof runWithHangGuard>>;
let hung: Awaited<ReturnType<typeof runWithHangGuard>>;
let repeatedSignal: Awaited<ReturnType<typeof runWithHangGuard>>;
let earlySignal: Awaited<ReturnType<typeof runWithHangGuard>>;
let collisionEvidence: { code: string };
let hungEvidence: { port: number; supervisorPid: number };
let cleanupEvidence: string;
let portWasReleased = false;
let supervisorWasReaped = false;
let repeatedSupervisorWasReaped = false;
let repeatedCleanupEvidence: string;
let earlyAbortEvidence: string;
try {
  collision = await runWithHangGuard(command('collision'));
  process.stdout.write(collision.stdout);
  process.stderr.write(collision.stderr);
  collisionEvidence = collision.success
    ? JSON.parse(await readFile(join(directory, 'collision.json'), 'utf8'))
    : { code: '' };
  earlySignal = await runWithHangGuard(command('early-signal'));
  earlyAbortEvidence = await readFile(join(directory, 'startup-aborted'), 'utf8');
  repeatedSignal = await runWithHangGuard(command('repeat-signal'));
  process.stdout.write(repeatedSignal.stdout);
  process.stderr.write(repeatedSignal.stderr);
  const repeatedEvidence: { supervisorPid: number } = JSON.parse(
    await readFile(join(directory, 'ready-repeat-signal.json'), 'utf8'),
  );
  repeatedCleanupEvidence = await readFile(join(directory, 'cleaned-repeat-signal'), 'utf8');
  try {
    process.kill(repeatedEvidence.supervisorPid, 0);
  } catch {
    repeatedSupervisorWasReaped = true;
  }
  hung = await runWithHangGuard(command('hang'));
  process.stdout.write(hung.stdout);
  process.stderr.write(hung.stderr);
  hungEvidence = JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8'));
  cleanupEvidence = await readFile(join(directory, 'cleaned-hang'), 'utf8');
  const probe = Bun.listen({
    hostname: '127.0.0.1',
    port: hungEvidence.port,
    socket: { data() {} },
  });
  probe.stop(true);
  portWasReleased = true;
  try {
    process.kill(hungEvidence.supervisorPid, 0);
  } catch {
    supervisorWasReaped = true;
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

test('reports an occupied connect port as a bind collision', () => {
  expect(collision.exitCode).toBe(0);
  expect(collisionEvidence.code).toBe('EADDRINUSE');
});

test('the hang guard ends a stalled connect host and reaps its supervisor', () => {
  expect(hung.exitCode).toBe(143);
  expect(cleanupEvidence).toBe('signal');
  expect(portWasReleased).toBe(true);
  expect(supervisorWasReaped).toBe(true);
});

test('repeated termination signals still reap the supervisor', () => {
  expect(repeatedSignal.exitCode).toBe(143);
  expect(repeatedCleanupEvidence).toBe('2');
  expect(repeatedSupervisorWasReaped).toBe(true);
});

test('termination during helper startup does not spawn a supervisor', () => {
  expect(earlySignal.exitCode).toBe(143);
  expect(earlyAbortEvidence).toBe('aborted');
  expect(earlySignal.stdout.toString()).not.toContain('Started the host');
});
