import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import {
  bunCrashReportsSince,
  crashedWorkerFiles,
  workerCrashMessage,
} from './worker-crash-report.ts';

// The shape Bun 1.4.2 wrote on 2026-10-27 when a --parallel worker died mid-file.
const crashedReport = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" failures="1">
  <testsuite name="src/a.test.ts" file="src/a.test.ts" tests="2" failures="0">
    <testcase name="fine" classname="a" time="0.1" file="src/a.test.ts" />
  </testsuite>
  <testsuite name="src/session-input-crash-recovery.test.ts" tests="1" failures="1">
    <testcase name="(worker crashed)"><failure message="worker process crashed before reporting results" /></testcase>
  </testsuite>
</testsuites>`;

describe('crashedWorkerFiles', () => {
  test('names the file whose worker crashed and no passing file', () => {
    expect(crashedWorkerFiles(crashedReport)).toEqual(['src/session-input-crash-recovery.test.ts']);
  });

  test('decodes XML entities in the file name', () => {
    const report =
      '<testsuite name="src/a &amp; b.test.ts"><testcase name="(worker crashed)"></testcase></testsuite>';
    expect(crashedWorkerFiles(report)).toEqual(['src/a & b.test.ts']);
  });

  test('is empty for a report with only ordinary failures', () => {
    const report =
      '<testsuite name="src/a.test.ts"><testcase name="x"><failure message="boom" /></testcase></testsuite>';
    expect(crashedWorkerFiles(report)).toEqual([]);
  });
});

describe('workerCrashMessage', () => {
  test('is null when no worker crashed', () => {
    expect(
      workerCrashMessage('packages/bureau', ['<testsuite name="a"></testsuite>'], []),
    ).toBeNull();
  });

  test('names the file, the workspace and the crash reports', () => {
    const message = workerCrashMessage('packages/bureau', [crashedReport], ['/x/bun-1.ips']);
    expect(message).toContain('packages/bureau: 1 test worker crashed');
    expect(message).toContain(
      'worker crashed while running src/session-input-crash-recovery.test.ts',
    );
    expect(message).toContain('/x/bun-1.ips');
  });

  test('says so when no crash report was written', () => {
    expect(workerCrashMessage('w', [crashedReport], [])).toContain('No Bun crash report');
  });
});

describe('bunCrashReportsSince', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  test('returns only Bun reports written at or after the start, newest first', () => {
    const directory = mkdtempSync(join(tmpdir(), 'worker-crash-report-'));
    directories.push(directory);
    const touch = (name: string, seconds: number): void => {
      writeFileSync(join(directory, name), '{}');
      utimesSync(join(directory, name), seconds, seconds);
    };
    touch('bun-old.ips', 1_000);
    touch('bun-first.ips', 2_000);
    touch('bun-second.ips', 3_000);
    touch('node-new.ips', 4_000);
    expect(bunCrashReportsSince(1_500_000, directory)).toEqual([
      join(directory, 'bun-second.ips'),
      join(directory, 'bun-first.ips'),
    ]);
  });

  test('is empty for a missing directory', () => {
    expect(bunCrashReportsSince(0, join(tmpdir(), 'worker-crash-report-missing', 'x'))).toEqual([]);
  });
});
