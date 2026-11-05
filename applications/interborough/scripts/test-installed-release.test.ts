import { describe, expect, test } from 'bun:test';

import { parseInstalledReleaseArguments, runInstalledRelease } from './test-installed-release.ts';

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

  test('rejects a missing or mixed mode', () => {
    for (const arguments_ of [
      [],
      ['--archive'],
      ['--command', ''],
      ['--archive', 'x', 'extra'],
      ['--other', 'x'],
    ])
      expect(() => parseInstalledReleaseArguments(arguments_)).toThrow('Usage:');
  });

  test.skipIf(process.env['COR2039_ARCHIVE'] === undefined)(
    'runs the retained archive journey',
    async () => {
      await runInstalledRelease(['--archive', process.env['COR2039_ARCHIVE']!]);
    },
    240_000,
  );
});
