/**
 * Runs the real gate runner over the good fixture with stand-in children, as its own process, so
 * a lifecycle case can signal it like a reader pressing Ctrl-C.
 *
 *   bun lifecycle-driver.ts --mode pass|fail|hang --record <dir> --output <dir>
 *   bun lifecycle-driver.ts --browser --output <dir>   (real server and real Playwright)
 *
 * `--fixture <name>` serves another fixture directory (default `good`) with its own export report.
 */
import { join } from 'node:path';

import { runStaticPlaygroundGate } from '../../../check-static-playground.ts';
import { argumentValue } from './stand-in-processes.ts';

const fixtures = join(import.meta.dirname, '..');
const standIns = import.meta.dirname;
const output = argumentValue('--output');
const record = argumentValue('--record');
if (output === undefined) throw new Error('usage: lifecycle-driver.ts --output <dir> ...');

const fixture = argumentValue('--fixture') ?? 'good';
const browser = process.argv.includes('--browser');
process.exitCode = await runStaticPlaygroundGate({
  directory: join(fixtures, fixture),
  exportReportPath: join(fixtures, `${fixture}.export-report.json`),
  output,
  shard: { index: 1, count: 1 },
  workers: 1,
  allowSourceMismatch: true,
  ...(browser
    ? {
        testRunnerCommand: () => [
          process.execPath,
          'x',
          '--no-install',
          'playwright',
          'test',
          '-c',
          join(fixtures, 'lifecycle.playwright.config.ts'),
        ],
      }
    : {
        ...(record === undefined
          ? {}
          : {
              serverCommand: ({ directory, portFile }: { directory: string; portFile: string }) => [
                process.execPath,
                join(standIns, 'stand-in-server.ts'),
                '--directory',
                directory,
                '--port-file',
                portFile,
                '--record',
                record,
              ],
            }),
        testRunnerCommand: () => [
          process.execPath,
          join(standIns, 'stand-in-test-runner.ts'),
          '--mode',
          argumentValue('--mode') ?? 'pass',
          ...(record === undefined ? [] : ['--record', record]),
        ],
      }),
});
