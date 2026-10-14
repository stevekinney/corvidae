/**
 * A stand-in for Playwright, injected through the runner's test-runner command.
 *
 *   --mode pass   record a passing result for every case in the shard, then exit 0
 *   --mode fail   record the same results, then exit 3
 *   --mode hang   never exit; the runner must end it
 *
 * `--environment-record <file>` writes the names of the credential-shaped variables it inherited.
 * `--stubborn` (with `--record`) also starts a sleeper that ignores SIGTERM.
 *
 * With `--record <dir>` it behaves like a browser run under lifecycle test: it starts a sleeper in
 * its own group and a detached one that names the run-owned `TMPDIR` (as Chromium's profile does),
 * writes `ready`, starts two more of the same kinds when `spawn-late` appears, and waits for
 * `proceed` before a `pass` or `fail` exit. Without `--record` it finishes at once.
 */
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readEnvironmentConfiguration,
  readSecretEnvironmentEntries,
} from '../../../../src/environment-configuration.ts';
import type { StaticCase } from '../../../static-playground-cases.ts';
import { argumentValue, startSleeper, waitForFile } from './stand-in-processes.ts';

const mode = argumentValue('--mode') ?? 'pass';
const record = argumentValue('--record');
const environment = readEnvironmentConfiguration();
const environmentRecord = argumentValue('--environment-record');

// Proves what the runner hands its children: the names of every credential-shaped variable
// this process can see, which must be none.
if (environmentRecord !== undefined) {
  await Bun.write(
    environmentRecord,
    JSON.stringify(readSecretEnvironmentEntries().map(([name]) => name)),
  );
}

if (record !== undefined) {
  await Bun.write(join(record, 'test-runner.pid'), `${process.pid}\n`);
  startSleeper(record, 'runner-grandchild');
  startSleeper(record, 'runner-detached', true, join(tmpdir(), 'stand-in-profile'));
  // A sleeper that ignores SIGTERM keeps the runner's cleanup in its grace period, so a case can
  // signal the runner while cleanup is running.
  if (process.argv.includes('--stubborn')) startSleeper(record, 'stubborn', false, '', true);
  await Bun.write(join(record, 'ready'), '');
  void waitForFile(join(record, 'spawn-late')).then(() => {
    startSleeper(record, 'late-grandchild');
    startSleeper(record, 'late-detached', true, join(tmpdir(), 'late-profile'));
    return undefined;
  });
}

if (mode === 'hang') {
  setInterval(() => undefined, 1_000);
} else {
  if (record !== undefined) await waitForFile(join(record, 'proceed'));
  const cases = (await Bun.file(environment.playgroundStaticCases ?? '').json()) as StaticCase[];
  for (const testCase of cases) {
    appendFileSync(
      environment.playgroundStaticResults ?? '',
      `${JSON.stringify({ caseId: testCase.id, status: 'passed', errors: [], diagnostics: [], screenshot: null })}\n`,
    );
  }
  process.exit(mode === 'fail' ? 3 : 0);
}
