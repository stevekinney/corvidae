import { MemoryStorage } from '@lostgradient/storage';
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { definePlugin, defineTrigger } from './index.ts';

describe('defineTrigger', () => {
  test('returns the entry it was given', () => {
    const entry = {
      name: 'heartbeat',
      description: 'Fires every interval.',
      configuration: z.object({ seconds: z.number() }),
      start: async () => () => undefined,
    };
    expect(defineTrigger(entry)).toBe(entry);
  });

  test('reads the configuration a start receives as the schema parses it', async () => {
    const seen: number[] = [];
    const heartbeat = defineTrigger({
      name: 'heartbeat',
      description: 'Fires every interval.',
      configuration: z.object({ seconds: z.number() }),
      async start({ configuration }) {
        seen.push(configuration.seconds);
        return () => undefined;
      },
    });
    const plugin = definePlugin({
      name: 'example',
      version: '1.0.0',
      description: 'An example plugin.',
      setup: () => ({ triggers: [heartbeat] }),
    });
    expect(plugin.name).toBe('example');
    await heartbeat.start({
      configuration: heartbeat.configuration.parse({ seconds: 3 }),
      workflowId: 'pulse',
      storage: new MemoryStorage(),
      fire: async () => ({ outcome: 'skipped', reason: 'stopped' }),
      signal: new AbortController().signal,
    });
    expect(seen).toEqual([3]);
  });
});
