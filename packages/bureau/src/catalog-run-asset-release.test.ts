/**
 * COR-1630 — the step that releases a catalog run's `run-row` claims when the run ends, and the
 * decision of which endings release. The matrix this file pins, by who runs the step:
 *
 * - A handle the catalog dispatcher watched (`releaseAfterHandle`): resolved or rejected, and the
 *   durable record terminal (or, with no durable engine, no record at all), releases. A durable
 *   record still in flight, or one that cannot be read, releases nothing: the run is cut short (an
 *   engine disposal, a lost compare-and-swap), not over. Once shutdown has begun, a run that
 *   `abort`ed or whose handle rejected releases nothing, because that abort was the shutdown's own.
 * - A recovered run (`releaseAfterRecovery`): terminal in the durable record releases, from the
 *   checkpoint, before cleanup prunes it. A conversation that cannot be read releases nothing and
 *   warns once.
 * - A goal attempt the forwarder ended (`releaseConversation`, `releaseEndedRun`): the forwarder
 *   decides when; these only do the work.
 *
 * Every pass releases only the pairs the asset's privileged references show are held.
 */
import { describe, expect, it } from 'bun:test';

import { runRowHolderId } from './assets/row-asset-claims';
import type { AssetService } from './assets/types';
import {
  type CatalogRunAssetReleaserDependencies,
  createCatalogRunAssetReleaser,
  createRecoveredRunReleaseListener,
  type EndedRunConversation,
} from './catalog-run-asset-release';
import type { CatalogRunSettlement } from './catalog-run-settlement';
import type { CatalogRunRecoveryLoad } from './runtime-composition';
import type { BureauDiagnostic } from './types';

const RUN = 'agent-run-1';
const held = (rowId: string) => runRowHolderId(RUN, rowId);

const imageRow = (id: string, assetId: string, hidden = false) => ({
  id,
  hidden,
  content: [{ type: 'image', source: { kind: 'managed-asset', assetId } }],
});

/** A conversation that, like the real one, hides hidden rows unless asked for them. */
function conversationOf(rows: ReadonlyArray<ReturnType<typeof imageRow>>) {
  return {
    getMessages: (options?: { includeHidden?: boolean }) =>
      rows.filter((row) => options?.includeHidden === true || !row.hidden),
  };
}

function setup(
  overrides: Partial<CatalogRunAssetReleaserDependencies> & {
    references?: Record<string, string[]>;
    withoutAssets?: boolean;
  } = {},
) {
  const references = overrides.references ?? {};
  const released: Array<[string, string]> = [];
  const assets = {
    async inspect(assetId: string) {
      return {
        projection: 'privileged',
        retention: {
          references: (references[assetId] ?? []).map((holderId) => ({ holderId, until: 'x' })),
        },
      };
    },
    async release(assetId: string, _principal: unknown, holderId: string) {
      released.push([assetId, holderId]);
      if (assetId === 'broken') throw new Error('the store is down');
    },
  } as unknown as AssetService;
  const diagnostics: BureauDiagnostic[] = [];
  const reads: string[] = [];
  const releaser = createCatalogRunAssetReleaser({
    assets: () => (overrides.withoutAssets === true ? undefined : assets),
    durableEnd: overrides.durableEnd ?? (async () => 'completed'),
    readEnded:
      overrides.readEnded ??
      (async (runId) => {
        reads.push(runId);
        return {
          status: 'ended',
          conversation: conversationOf([imageRow('row-1', 'checkpointed')]),
        };
      }),
    isShuttingDown: overrides.isShuttingDown ?? (() => false),
    diagnose: (diagnostic) => diagnostics.push(diagnostic),
  });
  return { releaser, released, diagnostics, reads };
}

const result = (finishReason: string, rows = [imageRow('row-1', 'photo')]) =>
  ({ kind: 'result', finishReason, conversation: conversationOf(rows) }) as const;

describe('a handle the dispatcher watched', () => {
  it.each(['stop-condition', 'error', 'aborted'])(
    'releases the held pairs of a durable run that ended with %s',
    async (finishReason) => {
      const { releaser, released } = setup({
        references: { photo: [held('row-1')], earlier: [], other: ['session-row:s:i:row-1'] },
      });

      await releaser.releaseAfterHandle({
        runId: RUN,
        principalId: 'alice',
        settled: result(finishReason, [
          imageRow('row-0', 'earlier'),
          imageRow('row-1', 'photo'),
          imageRow('row-2', 'other'),
        ]),
      });

      expect(released).toEqual([['photo', held('row-1')]]);
    },
  );

  it('releases a run with no durable record (the in-process path) when its result settles', async () => {
    const { releaser, released } = setup({
      durableEnd: async () => 'not-durable',
      references: { photo: [held('row-1')] },
    });

    await releaser.releaseAfterHandle({
      runId: RUN,
      principalId: 'alice',
      settled: result('stop-condition'),
    });

    expect(released).toEqual([['photo', held('row-1')]]);
  });

  it('includes hidden rows, which can reference assets too', async () => {
    const { releaser, released } = setup({ references: { secret: [held('row-h')] } });

    await releaser.releaseAfterHandle({
      runId: RUN,
      principalId: 'alice',
      settled: result('stop-condition', [imageRow('row-h', 'secret', true)]),
    });

    expect(released).toEqual([['secret', held('row-h')]]);
  });

  it('releases nothing when the durable run is still going, as after an engine disposal or a lost run', async () => {
    const { releaser, released } = setup({
      durableEnd: async () => 'in-flight',
      references: { photo: [held('row-1')] },
    });

    await releaser.releaseAfterHandle({
      runId: RUN,
      principalId: 'alice',
      settled: result('aborted'),
    });
    await releaser.releaseAfterHandle({
      runId: RUN,
      principalId: 'alice',
      settled: { kind: 'rejected' },
    });

    expect(released).toEqual([]);
  });

  it('treats a durable run that cannot be read as still going', async () => {
    const { releaser, released, diagnostics } = setup({
      durableEnd: async () => {
        throw new Error('storage closed');
      },
      references: { photo: [held('row-1')] },
    });

    await releaser.releaseAfterHandle({
      runId: RUN,
      principalId: 'alice',
      settled: result('stop-condition'),
    });

    expect(released).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it.each(['aborted', 'stop-condition', 'error'])(
    'releases nothing once shutdown has begun, whatever the finish reason (%s) or the record reads',
    async (finishReason) => {
      const { releaser, released, reads } = setup({
        isShuttingDown: () => true,
        durableEnd: async () => 'canceled',
        references: { photo: [held('row-1')] },
      });

      await releaser.releaseAfterHandle({
        runId: RUN,
        principalId: 'alice',
        settled: result(finishReason),
      });
      await releaser.releaseAfterHandle({
        runId: RUN,
        principalId: 'alice',
        settled: { kind: 'rejected' },
      });

      expect([released, reads]).toEqual([[], []]);
    },
  );

  it('releases nothing when shutdown begins while the durable record is being read', async () => {
    let shuttingDown = false;
    const { releaser, released } = setup({
      isShuttingDown: () => shuttingDown,
      durableEnd: async () => {
        shuttingDown = true;
        return 'completed';
      },
      references: { photo: [held('row-1')] },
    });

    await releaser.releaseAfterHandle({
      runId: RUN,
      principalId: 'alice',
      settled: result('stop-condition'),
    });

    expect(released).toEqual([]);
  });

  it('reads a rejected durable run’s conversation from its checkpoint, as an engine failure ends it', async () => {
    const { releaser, released, reads } = setup({
      durableEnd: async () => 'failed',
      references: { checkpointed: [held('row-1')] },
    });

    await releaser.releaseAfterHandle({
      runId: RUN,
      principalId: 'alice',
      settled: { kind: 'rejected' },
    });

    expect(reads).toEqual([RUN]);
    expect(released).toEqual([['checkpointed', held('row-1')]]);
  });

  it('warns once, naming the run, when a rejected run has no durable record to read', async () => {
    const { releaser, released, diagnostics } = setup({ durableEnd: async () => 'not-durable' });

    await releaser.releaseAfterHandle({
      runId: RUN,
      principalId: 'alice',
      settled: { kind: 'rejected' },
    });

    expect(released).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ level: 'warn', scope: 'assets' });
    expect(diagnostics[0]?.message).toContain(RUN);
  });

  it('does nothing without an asset service', async () => {
    const { releaser, released, reads, diagnostics } = setup({
      withoutAssets: true,
      durableEnd: async () => 'failed',
    });

    await releaser.releaseAfterHandle({
      runId: RUN,
      principalId: 'alice',
      settled: { kind: 'rejected' },
    });

    expect([released, reads, diagnostics]).toEqual([[], [], []]);
  });
});

describe('a recovered run', () => {
  it('releases the held pairs of the conversation its checkpoint holds', async () => {
    const { releaser, released, reads } = setup({
      references: { checkpointed: [held('row-1')] },
    });

    await releaser.releaseAfterRecovery({ runId: RUN, principalId: 'alice' });

    expect(reads).toEqual([RUN]);
    expect(released).toEqual([['checkpointed', held('row-1')]]);
  });

  it.each<[string, EndedRunConversation]>([
    ['still running', { status: 'running' }],
    ['missing', { status: 'missing' }],
  ])('releases nothing for a run the engine reports as %s', async (_name, reading) => {
    const { releaser, released, diagnostics } = setup({ readEnded: async () => reading });

    await releaser.releaseAfterRecovery({ runId: RUN, principalId: 'alice' });

    expect(released).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it('releases nothing once shutdown has begun', async () => {
    const { releaser, released, reads } = setup({ isShuttingDown: () => true });

    await releaser.releaseAfterRecovery({ runId: RUN, principalId: 'alice' });

    expect([released, reads]).toEqual([[], []]);
  });

  it('releases nothing and warns once, naming the run, when its conversation cannot be read', async () => {
    const { releaser, released, diagnostics } = setup({
      readEnded: async () => {
        throw new Error('the checkpoint is unreadable');
      },
    });

    await releaser.releaseAfterRecovery({ runId: RUN, principalId: 'alice' });

    expect(released).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ level: 'warn', scope: 'assets' });
    expect(diagnostics[0]?.message).toContain(RUN);
  });
});

describe('releasing a run’s claims', () => {
  it('reports a release that fails with the run, the row and the asset, and still releases the others', async () => {
    const { releaser, released, diagnostics } = setup({
      references: { broken: [held('row-1')], photo: [held('row-2')] },
    });

    await releaser.releaseConversation({
      runId: RUN,
      principalId: 'alice',
      conversation: conversationOf([imageRow('row-1', 'broken'), imageRow('row-2', 'photo')]),
    });

    expect(released.map(([assetId]) => assetId)).toEqual(['broken', 'photo']);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ level: 'warn', scope: 'assets' });
    expect(diagnostics[0]?.message).toContain(RUN);
    expect(diagnostics[0]?.message).toContain('row-1');
    expect(diagnostics[0]?.message).toContain('broken');
  });

  it('reads an ended run’s conversation, for a goal attempt whose goal ended first', async () => {
    const { releaser, released } = setup({ references: { checkpointed: [held('row-1')] } });

    await releaser.releaseEndedRun({ runId: RUN, principalId: 'alice' });

    expect(released).toEqual([['checkpointed', held('row-1')]]);
  });

  it('is idempotent: a second pass over the same run releases no pair twice', async () => {
    const references = { photo: [held('row-1')] };
    const { releaser, released } = setup({ references });
    // The fake service does not drop a released reference, so model the real one.
    const pass = async () => {
      await releaser.releaseConversation({
        runId: RUN,
        principalId: 'alice',
        conversation: conversationOf([imageRow('row-1', 'photo')]),
      });
      references.photo = [];
    };

    await pass();
    await pass();

    expect(released).toEqual([['photo', held('row-1')]]);
  });
});

describe('the recovered-run listener', () => {
  const settlement = (overrides: Partial<CatalogRunSettlement> = {}): CatalogRunSettlement => ({
    runId: RUN,
    agentName: 'painter',
    status: 'completed',
    finishReason: 'stop-condition',
    message: null,
    content: null,
    recovered: true,
    ...overrides,
  });

  function listening(load: CatalogRunRecoveryLoad | Error) {
    const calls: Array<{ runId: string; principalId: string }> = [];
    const diagnostics: BureauDiagnostic[] = [];
    const listener = createRecoveredRunReleaseListener({
      releaser: { releaseAfterRecovery: async (run) => void calls.push(run) },
      loadRecoveryRecord: async () => {
        if (load instanceof Error) throw load;
        return load;
      },
      ownerOf: (principal) => principal ?? 'anonymous:local',
      diagnose: (diagnostic) => diagnostics.push(diagnostic),
    });
    return { listener, calls, diagnostics };
  }
  const found = (record: Record<string, unknown>) =>
    ({
      status: 'found',
      record: { agentName: 'painter', ...record },
    }) as unknown as CatalogRunRecoveryLoad;

  it('releases a recovered run as the principal its record names', async () => {
    const { listener, calls } = listening(found({ principal: 'alice' }));

    await listener(settlement());

    expect(calls).toEqual([{ runId: RUN, principalId: 'alice' }]);
  });

  it('leaves a fresh dispatch to the dispatcher, which released it where it was dispatched', async () => {
    const { listener, calls } = listening(found({ principal: 'alice' }));

    await listener(settlement({ recovered: false }));

    expect(calls).toEqual([]);
  });

  it('leaves a goal attempt to the goal forwarder', async () => {
    const { listener, calls, diagnostics } = listening(
      found({ principal: 'alice', goalAttempt: { goalRunId: 'g1', attemptIndex: 0 } }),
    );

    await listener(settlement());

    expect([calls, diagnostics]).toEqual([[], []]);
  });

  it.each<[string, CatalogRunRecoveryLoad | Error]>([
    ['missing', { status: 'missing' }],
    ['corrupt', { status: 'corrupt' }],
    ['unreadable', { status: 'read-error', error: new Error('boom') }],
    ['rejecting', new Error('boom')],
  ])('releases nothing and warns once when the recovery record is %s', async (_name, load) => {
    const { listener, calls, diagnostics } = listening(load);

    await listener(settlement());

    expect(calls).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain(RUN);
  });
});
