/**
 * A durable Bureau on a manual clock, for the tests that show a live setting is read at its next
 * point of use (COR-1710). `at(offset)` moves the clock to an offset from the origin;
 * `retentionFloor()` reads the fleet feed's floor from the same store.
 */
import { createManualRuntimeServices, type ManualRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { createFleetEventFeed, resolveStorage } from '@lostgradient/weft';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createToolbox, type Tool } from 'armorer';

import type { AgentDefinitions } from '../agent-catalog.ts';
import { createBureau } from '../create-bureau.ts';
import { createSqliteStorageFixture } from '../test/storage-fixtures.ts';
import type { Bureau, BureauOptions } from '../types.ts';

export const LIVE_SETTINGS_ORIGIN = '2026-10-13T00:00:00.000Z';
const ORIGIN_MS = Date.parse(LIVE_SETTINGS_ORIGIN);
export const DAY_MS = 86_400_000;

const finishes: GenerateFunction = async () => ({ content: 'done', toolCalls: [] });

export interface LiveSettingsContext {
  readonly bureau: Bureau<AgentDefinitions>;
  readonly runtime: ManualRuntimeServices;
  /** Moves the clock to `offsetMs` after the origin. */
  readonly at: (offsetMs: number) => void;
  /** The fleet event feed's retention floor, read from the Bureau's own store. */
  readonly retentionFloor: () => Promise<number>;
  /** Changes `patch` at the current revision and expects it applied. */
  readonly change: (patch: Record<string, unknown>) => Promise<void>;
  /** Starts a task and waits until it completes. */
  readonly settledTask: (input?: string) => Promise<string>;
}

/** Runs `body` against a durable manual-maintenance Bureau over a fresh SQLite store. */
export async function withLiveSettingsBureau(
  body: (context: LiveSettingsContext) => Promise<void>,
  overrides: Partial<BureauOptions<AgentDefinitions>> = {},
): Promise<void> {
  const runtime = createManualRuntimeServices({ origin: LIVE_SETTINGS_ORIGIN });
  const fixture = createSqliteStorageFixture({ runtime });
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: finishes,
        stopWhen: stopWhen.noToolCalls(),
        toolbox: createToolbox<readonly Tool[]>([]),
      }),
    },
    runtime,
    storage: fixture.configuration,
    durable: true,
    durableOwnership: { ownership: 'none' },
    maintenance: 'manual',
    ...overrides,
  });
  try {
    await body({
      bureau,
      runtime,
      at: (offsetMs) => runtime.setTime(ORIGIN_MS + offsetMs),
      retentionFloor: async () => {
        const storage = await resolveStorage(fixture.configuration);
        try {
          const feed = createFleetEventFeed(storage);
          try {
            return await feed.snapshotRetentionFloor();
          } finally {
            feed.dispose();
          }
        } finally {
          storage[Symbol.dispose]();
        }
      },
      change: async (patch) => {
        const { revision } = await bureau.settings.get();
        const result = await bureau.settings.update(patch, { expectedRevision: revision });
        if (result.outcome !== 'applied') {
          throw new Error(`settings update refused: ${JSON.stringify(result)}`);
        }
      },
      settledTask: async (input = 'work') => {
        const created = await bureau.tasks.start('default', input, { principal: 'alice' });
        await waitUntil(() => bureau.tasks.detail(created.id)?.status === 'completed', {
          message: 'the task to complete',
        });
        await runtime.deferred.drain();
        return created.id;
      },
    });
  } finally {
    await bureau.dispose();
    await fixture.dispose();
  }
}
