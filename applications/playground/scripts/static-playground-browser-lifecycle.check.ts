/**
 * The real-Chromium lifecycle case: SIGINT to the gate's runner while Playwright holds a browser
 * page open must leave no browser, worker, test-runner, or server process behind.
 *
 *   bun scripts/static-playground-browser-lifecycle.check.ts
 *
 * The name ends in `.check.ts`, not `.test.ts`, so the default `test` suite never launches a
 * browser (`run-tests.test.ts` asserts that). `test:lifecycle` runs it by path, after the
 * stand-in cases, and the Linux recipe runs `test:lifecycle` in both container modes. It exits 0
 * when every captured process and group is gone and an unrelated sentinel survives.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readEnvironmentConfiguration } from '../src/environment-configuration.ts';
import {
  descendantProcesses,
  isZombie,
  type ProcessRow,
  readProcessTable,
} from './static-playground-processes.ts';

const DRIVER = join(
  import.meta.dirname,
  'fixtures',
  'static-playground',
  'stand-ins',
  'lifecycle-driver.ts',
);
const requireReaped = readEnvironmentConfiguration().playgroundLifecycleRequireReaped === '1';

function fail(message: string): never {
  throw new Error(`[browser-lifecycle] ${message}`);
}

async function main(): Promise<void> {
  const output = await mkdtemp(join(tmpdir(), 'static-browser-lifecycle-'));
  const sentinel = Bun.spawn(['/bin/sh', '-c', 'while :; do sleep 1; done'], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const driver = Bun.spawn([process.execPath, DRIVER, '--browser', '--output', output], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  let stdout = '';
  void (async () => {
    for await (const chunk of driver.stdout) {
      const text = new TextDecoder().decode(chunk);
      stdout += text;
      process.stdout.write(text);
    }
  })();
  try {
    let runDirectory: string | undefined;
    while (runDirectory === undefined || !existsSync(join(runDirectory, 'browser-active'))) {
      if (driver.exitCode !== null)
        fail(`the runner exited ${driver.exitCode} before Chromium was active`);
      runDirectory ??= /run directory (\S+)/.exec(stdout)?.[1];
      await Bun.sleep(50);
    }
    const origin = /at (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1] ?? fail('no server origin');

    const table = readProcessTable();
    const ownGroup = table.find((row) => row.pid === process.pid)?.pgid;
    const captured = [
      ...descendantProcesses(driver.pid, table),
      ...table.filter((row) => row.args.includes(runDirectory)),
    ].filter((row) => row.pgid !== ownGroup);
    const browsers = captured.filter((row) => /chrom/i.test(row.args));
    if (browsers.length === 0) fail('no Chromium process was captured before signaling');
    const pids = new Set(captured.map((row) => row.pid));
    const groups = new Set(captured.map((row) => row.pgid));
    process.stdout.write(
      `[browser-lifecycle] captured ${pids.size} processes (${browsers.length} Chromium) in ${groups.size} groups; sending SIGINT\n`,
    );

    driver.kill('SIGINT');
    const status = await driver.exited;
    if (status !== 130) fail(`the runner exited ${status}, not 130`);

    const after = readProcessTable();
    const isGone = (row: ProcessRow | undefined) =>
      row === undefined || (!requireReaped && isZombie(row));
    const living = after.filter(
      (row) => (pids.has(row.pid) || groups.has(row.pgid)) && !isGone(row),
    );
    if (living.length > 0) {
      fail(`owned processes survived: ${living.map((row) => `${row.pid} ${row.args}`).join('; ')}`);
    }
    if (isGone(after.find((row) => row.pid === sentinel.pid))) fail('the sentinel did not survive');
    if (existsSync(runDirectory)) fail(`the run directory ${runDirectory} survived`);
    const port = await fetch(origin).then(
      () => 'listening',
      () => 'closed',
    );
    if (port !== 'closed') fail(`the static server port at ${origin} is still listening`);
    process.stdout.write(
      `[browser-lifecycle] passed: exit 130, ${pids.size} captured processes and ${groups.size} groups gone${requireReaped ? ' and reaped' : ''}\n`,
    );
  } finally {
    if (driver.exitCode === null) driver.kill('SIGKILL');
    sentinel.kill('SIGKILL');
    await Promise.all([driver.exited, sentinel.exited]);
    await rm(output, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
