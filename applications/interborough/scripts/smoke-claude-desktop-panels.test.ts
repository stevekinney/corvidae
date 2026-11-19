import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BUILD_INFO_FILE, type GitRunner } from '../src/host/build-info.ts';
import { staleBuildRefusal, waitForStop } from './smoke-claude-desktop-panels.ts';

describe('staleBuildRefusal', () => {
  const headAt =
    (commit: string): GitRunner =>
    (_directory, argumentsList) =>
      argumentsList[0] === 'rev-parse' ? `${commit}\n` : '';

  function build(commit: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'smoke-stale-'));
    writeFileSync(join(directory, 'index.html'), 'page');
    writeFileSync(join(directory, BUILD_INFO_FILE), JSON.stringify({ commit, changes: '' }));
    return directory;
  }

  // spawn-free: the git runner is a stand-in that answers from memory
  test('refuses a build made from another commit, with the message `serve` gives', () => {
    const message = staleBuildRefusal(build('a'.repeat(40)), '.', headAt('b'.repeat(40)));
    expect(message).toContain('was made from aaaaaaa but HEAD is bbbbbbb');
    expect(message).toContain('Run `bun run build` first.');
  });

  // spawn-free: the git runner is a stand-in that answers from memory
  test('lets the smoke start on a build of the current commit', () => {
    expect(staleBuildRefusal(build('a'.repeat(40)), '.', headAt('a'.repeat(40)))).toBeUndefined();
  });
});

describe('waitForStop', () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    test(`without a TTY stays pending until ${signal}, then removes its listeners`, async () => {
      const signals = new EventEmitter();
      let settled = false;
      const waiting = waitForStop({ isTTY: false, signals }).then(() => {
        settled = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(signals.listenerCount('SIGINT')).toBe(1);
      expect(signals.listenerCount('SIGTERM')).toBe(1);
      signals.emit(signal);
      await waiting;
      expect(settled).toBe(true);
      expect(signals.listenerCount('SIGINT')).toBe(0);
      expect(signals.listenerCount('SIGTERM')).toBe(0);
    });
  }
});
