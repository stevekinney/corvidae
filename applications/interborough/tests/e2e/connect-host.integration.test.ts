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
let collisionEvidence: { code: string };
let hungEvidence: { port: number; supervisorPid: number; hostPid: number };
let cleanupEvidence: string;
let portWasReleased = false;
let supervisorWasReaped = false;
try {
  collision = await runWithHangGuard(command('collision'));
  process.stdout.write(collision.stdout);
  process.stderr.write(collision.stderr);
  collisionEvidence = collision.success
    ? JSON.parse(await readFile(join(directory, 'collision.json'), 'utf8'))
    : { code: '' };
  hung = await runWithHangGuard(command('hang'));
  process.stdout.write(hung.stdout);
  process.stderr.write(hung.stderr);
  hungEvidence = JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8'));
  cleanupEvidence = await readFile(join(directory, 'cleaned-hang'), 'utf8');
  if (process.platform === 'linux') {
    const readEvidence = (path: string) =>
      readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    process.stdout.write(
      `COR2653_CONNECT_PROCESS ${JSON.stringify({
        before: hungEvidence,
        after: {
          supervisorStat: await readEvidence(`/proc/${String(hungEvidence.supervisorPid)}/stat`),
          hostStat: await readEvidence(`/proc/${String(hungEvidence.hostPid)}/stat`),
          instance: await readEvidence(join(directory, 'home-hang', 'instance.json')),
        },
      })}\n`,
    );
  }
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
