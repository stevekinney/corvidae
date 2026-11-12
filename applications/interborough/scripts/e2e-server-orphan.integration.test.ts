import { afterAll, expect, test } from 'bun:test';
import { join } from 'node:path';

import { outcomeOf, rethrow, spawnWithHangGuard, waitUntil } from '@lostgradient/testing';

import { readProcessTable } from '../../../scripts/bun-test-pool.ts';
import { processTreeOf } from '../../../scripts/test-watchdog.ts';

/**
 * The end-to-end host must not outlive the Playwright run that started it. Playwright starts it
 * through `sh -c` and stops it with SIGTERM, but a run killed with SIGKILL sends nothing, and ten
 * of these hosts were found running one to five days later. The scenario starts the real
 * `e2e-server.ts` under a starter and an intermediate shell, kills the starter with SIGKILL while
 * the host is still building the application (so it never binds the suite's fixed ports), and
 * waits for the host and the shell to exit. It runs at module scope, where no per-test clock
 * applies.
 */
const server = join(import.meta.dir, '..', 'tests', 'e2e', 'e2e-server.ts');
const started: number[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterAll(() => {
  for (const pid of started) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone, as it should be.
    }
  }
});

const exitsWithItsStarter = await outcomeOf(async () => {
  // Each `&& true` keeps its shell alive as a parent instead of letting it exec the command.
  const starter = spawnWithHangGuard(
    [
      'sh',
      '-c',
      `sh -c '"$0" --no-install "$1" && true' "$0" "$1" && true`,
      process.execPath,
      server,
    ],
    {
      stdout: 'ignore',
      stderr: 'pipe',
    },
  );
  started.push(starter.pid);
  const decoder = new TextDecoder();
  let errors = '';
  const reading = (async () => {
    for await (const chunk of starter.stderr) errors += decoder.decode(chunk, { stream: true });
  })();
  await waitUntil(() => errors.includes('[e2e startup] building-application'), {
    message: 'the end-to-end host started building the application',
  });
  const table = readProcessTable();
  if (table === undefined) throw new Error('the process table could not be read');
  const descendants = processTreeOf(starter.pid, table).filter((pid) => pid !== starter.pid);
  started.push(...descendants);
  // The intermediate shell and the host.
  expect(descendants.length).toBeGreaterThanOrEqual(2);

  starter.kill('SIGKILL');
  await starter.exited;
  await waitUntil(() => descendants.every((pid) => !isAlive(pid)), {
    message: 'the end-to-end host exited after its starter was killed',
  });
  await reading;
  expect(errors).toContain('exit-when-orphaned: the process that started this server is gone');
});

test('the end-to-end host exits when the process that started it is killed', () => {
  rethrow(exitsWithItsStarter);
});
