import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';

import { waitForStop } from './smoke-claude-desktop-panels.ts';

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
