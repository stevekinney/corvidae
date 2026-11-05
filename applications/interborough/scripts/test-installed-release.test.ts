import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseInstalledReleaseArguments,
  parseRunStartedRunId,
  referencedAssets,
  runInstalledRelease,
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

  test('orchestrates archive and relocation through injectable process seams', async () => {
    const calls: string[] = [];
    const evidenceDirectory = await mkdtemp(join(tmpdir(), 'installed-release-seam-'));
    try {
      const evidence = await runInstalledRelease(
        ['--archive', './fixture.tar.gz', '--evidence', evidenceDirectory],
        {
          unpack: async (_archive, prefix) => {
            const executable = `${prefix}/interborough/bin/interborough`;
            await mkdir(`${prefix}/interborough/bin`, { recursive: true });
            await mkdir(`${prefix}/interborough/share/interborough/plugin-runtime/node_modules`, {
              recursive: true,
            });
            await writeFile(executable, 'fixture');
            return executable;
          },
          runInstalled: async (executable, prefix, relocated) => {
            await mkdir(`${prefix}/home/plugins`, { recursive: true });
            calls.push(`${relocated ? 'relocated' : 'initial'}:${executable}:${prefix}`);
          },
        },
      );
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain('initial:');
      expect(calls[1]).toContain('relocated:');
      expect(evidence).toMatch(/installed-release-.*\.json$/);
    } finally {
      await rm(evidenceDirectory, { recursive: true, force: true });
    }
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
