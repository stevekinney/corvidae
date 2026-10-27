/**
 * COR-1710 — each live `engine.*` setting reaches the durable engine through
 * `engine.reconfigure`, now and on every later change, and the engine reports it applied.
 */
import { describe, expect, it, spyOn } from 'bun:test';

import { ENGINE_PATCH_FIELDS } from './settings-options.ts';
import { withLiveSettingsBureau } from '../testing/live-settings-bureau.test-support.ts';

const NEW_VALUES = {
  'engine.retention': { completed: 1_000 },
  'engine.retentionSweepInterval': 60_000,
  'engine.retentionSweepBatchSize': 10,
  'engine.history': { maxEvents: 100 },
  'engine.payloadSize': { maxBytes: 1_024 },
  'engine.checkpointSizeWarningThreshold': 2_048,
  'engine.schedulerPollIntervalMs': 500,
} as const satisfies Record<keyof typeof ENGINE_PATCH_FIELDS, unknown>;

describe('engine.* live settings', () => {
  for (const [key, value] of Object.entries(NEW_VALUES)) {
    it(`${key} is applied to the engine by its next reconfigure`, async () => {
      await withLiveSettingsBureau(async ({ bureau, change }) => {
        const engine = bureau.durableEngine();
        if (engine === undefined) throw new Error('expected a durable engine');
        const reconfigure = spyOn(engine, 'reconfigure');

        await change({ [key]: value });

        expect(reconfigure).toHaveBeenCalledTimes(1);
        const field = ENGINE_PATCH_FIELDS[key as keyof typeof ENGINE_PATCH_FIELDS];
        expect(reconfigure.mock.calls[0]?.[0]).toEqual({ [field]: value });
        expect(reconfigure.mock.results[0]?.value).toMatchObject({ outcome: 'applied' });
      });
    });
  }

  it('a restart key is stored without reconfiguring the engine', async () => {
    await withLiveSettingsBureau(async ({ bureau, change }) => {
      const engine = bureau.durableEngine();
      if (engine === undefined) throw new Error('expected a durable engine');
      const reconfigure = spyOn(engine, 'reconfigure');
      await change({ 'engine.maxNestingDepth': 4 });
      expect(reconfigure).not.toHaveBeenCalled();
    });
  });
});
