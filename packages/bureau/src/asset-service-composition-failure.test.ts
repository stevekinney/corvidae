import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { shutdownThenRethrow } from './composition-failure';
import { createBureau } from './create-bureau';
import { createMemoryAssetStorageFixture } from './test/asset-storage-fixtures';
import { createAgent } from '@lostgradient/operative';
import type { AgentDefinitions } from './agent-catalog';

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

/**
 * COR-716 — the asset service starts before the runtime composition so a
 * scheduled fire never finds it missing. When the composition then fails, the
 * service is shut down and the composition error is what the caller sees.
 */
describe('composition failure after the asset service started', () => {
  it('shuts the early-built asset service down when composition rejects, leaving no timer armed', async () => {
    const runtime = createManualRuntimeServices();
    const fixture = createMemoryAssetStorageFixture({});
    const thrown = await rejectionOf(
      createBureau<AgentDefinitions>({
        agents: {
          default: createAgent({ generate: async () => ({ content: 'ok', toolCalls: [] }) }),
        },
        durableExecution: true,
        persistence: textValueStore(new MemoryStorage()),
        runtime,
        assets: { storage: fixture.storage, garbageCollectionIntervalMilliseconds: 1_000 },
      }),
    );
    expect(String(thrown)).toContain('durableExecution: true is incompatible');
    expect(runtime.pendingTimers()).toHaveLength(0);
    await fixture.dispose();
  });

  it('a shutdown that fails does not hide the composition error', async () => {
    const composition = new Error('composition failed');
    const shutdownFailure = new Error('shutdown failed');
    const thrown = await rejectionOf(
      shutdownThenRethrow(composition, async () => {
        throw shutdownFailure;
      }),
    );
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([composition, shutdownFailure]);
    expect((thrown as AggregateError).message).toContain('composition failed');
  });

  it('rethrows the composition error itself when shutdown succeeds', async () => {
    const composition = new Error('composition failed');
    let shutdowns = 0;
    const thrown = await rejectionOf(
      shutdownThenRethrow(composition, async () => {
        shutdowns += 1;
      }),
    );
    expect(thrown).toBe(composition);
    expect(shutdowns).toBe(1);
  });
});
