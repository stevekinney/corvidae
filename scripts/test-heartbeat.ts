/**
 * The heartbeat every pooled test process records, so the wrapper can tell from outside that it is
 * still starting and finishing tests (`scripts/test-watchdog.ts`).
 *
 * `runPooledBunTest` preloads this file into `bun test` and names a directory in
 * `CORVIDAE_TEST_HEARTBEATS`. The process keeps one file there, named by its pid, and rewrites its
 * first line when it loads and before and after each test: a counter, `running` or `idle`, and the
 * current test file (`Bun.main`). It is one positioned write to a descriptor opened once, with no
 * timer, so fake timers and the timer leak guards never see it, and the file-system functions are
 * taken when this file loads, so a test that mocks `node:fs` later does not reach them. A failure
 * to record never fails a test.
 */

import { afterEach, beforeEach } from 'bun:test';
import { openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { rootScriptEnvironment } from './environment-configuration.ts';

const directory = rootScriptEnvironment()['CORVIDAE_TEST_HEARTBEATS'];

if (directory !== undefined && directory !== '') {
  const write = writeSync;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(join(directory, String(process.pid)), 'w');
  } catch {
    // The run ends without a stall guard for this process.
  }
  let sequence = 0;
  const record = (state: 'running' | 'idle'): void => {
    if (descriptor === undefined) return;
    sequence += 1;
    try {
      write(descriptor, `${sequence}\t${state}\t${Bun.main}\n`, 0);
    } catch {
      // Recording is best effort.
    }
  };
  record('idle');
  beforeEach(() => record('running'));
  afterEach(() => record('idle'));
}
