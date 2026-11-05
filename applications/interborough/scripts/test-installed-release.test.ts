import { describe, expect, test } from 'bun:test';

import {
  parseInstalledReleaseArguments,
  parseRunStartedRunId,
  referencedAssets,
} from './test-installed-release.ts';

describe('installed-release harness arguments', () => {
  test('accepts archive mode and resolves the archive path', () => {
    expect(parseInstalledReleaseArguments(['--archive', './release.tar.gz'])).toEqual({
      mode: 'archive',
      archive: expect.stringMatching(/release\.tar\.gz$/),
    });
  });

  test('accepts command mode and resolves the executable path', () => {
    expect(parseInstalledReleaseArguments(['--command', './interborough'])).toEqual({
      mode: 'command',
      command: expect.stringMatching(/interborough$/),
    });
  });

  test('accepts a caller-selected evidence directory', () => {
    expect(
      parseInstalledReleaseArguments(['--command', './interborough', '--evidence', './evidence']),
    ).toMatchObject({
      evidence: expect.stringMatching(/evidence$/),
    });
  });

  test('extracts only the run identifier from a RUN_STARTED event', () => {
    expect(parseRunStartedRunId('data: {"type":"RUN_STARTED","runId":"run-42"}\n\n')).toBe(
      'run-42',
    );
    expect(() => parseRunStartedRunId('data: {"type":"RUN_FINISHED"}\n\n')).toThrow('RUN_STARTED');
  });

  test('extracts shell JavaScript and CSS references for HTTP assertions', () => {
    expect(referencedAssets('<script src="/app.js"></script><link href="/app.css">')).toEqual([
      '/app.js',
      '/app.css',
    ]);
  });

  test('rejects a missing or mixed mode', () => {
    for (const arguments_ of [
      [],
      ['--archive'],
      ['--command', ''],
      ['--archive', 'x', 'extra'],
      ['--other', 'x'],
      ['--archive', 'x', '--evidence'],
    ])
      expect(() => parseInstalledReleaseArguments(arguments_)).toThrow('Usage:');
  });
});
