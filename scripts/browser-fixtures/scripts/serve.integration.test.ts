import { afterAll, expect, test } from 'bun:test';
import { join } from 'node:path';

import { spawnWithHangGuard } from '../../../testing/testing/src/hang-guard.ts';
import { waitUntil } from '../../../testing/testing/src/wait-until.ts';
import { readProcessTable } from '../../bun-test-pool.ts';
import { outcomeOf, rethrow } from '../../module-scope-scenario.test-support.ts';
import { processTreeOf } from '../../test-watchdog.ts';

/**
 * The fixture host must not outlive the process that started it. Playwright starts it through
 * `sh -c`, and a Playwright killed with SIGKILL stops nothing, so five preview servers were found
 * running days later, reparented to pid 1. The scenario starts the real `serve.ts` the same way,
 * under a starter and an intermediate shell, kills the starter with SIGKILL, and waits for the
 * server and the shell to exit. It runs at module scope, where no per-test clock applies.
 */
const root = join(import.meta.dir, '..');
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

/** Reads the stream until a line matches, and returns the match. */
async function lineMatching(
  stream: ReadableStream<Uint8Array>,
  pattern: RegExp,
): Promise<RegExpExecArray> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    const match = pattern.exec(text);
    if (match !== null) return match;
  }
  throw new Error(`the server exited before printing ${String(pattern)}: ${text}`);
}

const exitsWithItsStarter = await outcomeOf(async () => {
  // Each `&& true` keeps its shell alive as a parent instead of letting it exec the command.
  const starter = spawnWithHangGuard(
    [
      'sh',
      '-c',
      `sh -c '"$0" --no-install scripts/serve.ts --preview --port 0 && true' "$0" && true`,
      process.execPath,
    ],
    { cwd: root, stdout: 'pipe', stderr: 'inherit' },
  );
  started.push(starter.pid);
  const [, origin = ''] = await lineMatching(
    starter.stdout,
    /fixture host listening on (http:\/\/\S+)/,
  );
  const table = readProcessTable();
  if (table === undefined) throw new Error('the process table could not be read');
  const descendants = processTreeOf(starter.pid, table).filter((pid) => pid !== starter.pid);
  started.push(...descendants);
  // The intermediate shell and the server.
  expect(descendants.length).toBeGreaterThanOrEqual(2);
  const answer = await fetch(new URL('/missing', origin));
  expect(answer.status).toBe(404);

  starter.kill('SIGKILL');
  await starter.exited;
  await waitUntil(() => descendants.every((pid) => !isAlive(pid)), {
    message: 'the fixture host exited after its starter was killed',
  });
});

test('the fixture host exits when the process that started it is killed', () => {
  rethrow(exitsWithItsStarter);
});
