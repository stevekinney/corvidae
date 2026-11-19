import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';

import { buildThenStart, guideText, waitForStop } from './smoke-claude-desktop-panels.ts';

describe('guideText', () => {
  test('asks for the record as a comment on COR-2220, not in a pull request', () => {
    const text = guideText('http://127.0.0.1:1/bureau/mcp');
    expect(text).toContain('Paste this record as a comment on COR-2220');
    expect(text).not.toContain('pull request');
    expect(text).toContain('Endpoint tested: http://127.0.0.1:1/bureau/mcp');
  });
});

describe('buildThenStart', () => {
  test('builds the browser bundle before it starts the host', async () => {
    const order: string[] = [];
    const host = await buildThenStart({
      build: async () => {
        order.push('build');
      },
      start: async () => {
        order.push('start');
        return 'host';
      },
    });
    expect(order).toEqual(['build', 'start']);
    expect(host).toBe('host');
  });

  test('does not start the host, and says why, when the build fails', async () => {
    let started = false;
    const failing = buildThenStart({
      build: async () => {
        throw new Error('the production build exited with code 1');
      },
      start: async () => {
        started = true;
        return 'host';
      },
    });
    await expect(failing).rejects.toThrow(/browser build failed.*exited with code 1/);
    expect(started).toBe(false);
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
