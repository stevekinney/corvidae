/**
 * COR-1527 — the engine is the source of truth for which document revision an in-flight run is
 * pinned to. Bureau reads those pins at startup, before it registers anything and before
 * `recoverAll()`, to decide which revisions to register as `retained`.
 */
import {
  Engine,
  MemoryStorage,
  registerWorkflowDocuments,
  workflowDocumentVersion,
  type DocumentWorkflowHost,
  type WorkflowDocument,
} from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';
import { awakeTurns } from '@lostgradient/testing/wait-until';

const host: DocumentWorkflowHost = {
  activities: { echo: ({ input }) => input },
  triggerKinds: { manual: () => undefined },
};

const document: WorkflowDocument = {
  name: 'pinned-listing',
  trigger: { kind: 'manual' },
  steps: [
    { kind: 'await-signal', signal: 'go' },
    { kind: 'activity', handler: 'echo', input: 1 },
  ],
};

async function untilParked(engine: Engine, workflowId: string): Promise<void> {
  for await (const attempt of awakeTurns()) {
    const timeline = await engine.getTimeline(workflowId);
    if (timeline.some((entry) => entry.operationType === 'wait-signal')) return;
    await Bun.sleep(5);
  }
  throw new Error('the run never parked');
}

describe('reading run pins from the engine before recovery', () => {
  it('lists non-terminal runs of a type with their workflow version on an engine that has registered nothing', async () => {
    const storage = new MemoryStorage();
    const expectedVersion = await workflowDocumentVersion(document);
    {
      await using original = new Engine({ storage });
      await registerWorkflowDocuments(original, host, { active: [document] });
      await original.start('pinned-listing', null, { id: 'pinned-listing-run' });
      await untilParked(original, 'pinned-listing-run');
    }

    await using restarted = new Engine({ storage });
    const page = await restarted.list({
      type: 'pinned-listing',
      status: ['pending', 'running', 'suspended'],
    });

    expect(page.items.map((item) => [item.id, item.version])).toEqual([
      ['pinned-listing-run', expectedVersion],
    ]);
    // Nothing was recovered by listing: the run is still waiting to be adopted.
    const [recovered] = await (async () => {
      await registerWorkflowDocuments(restarted, host, { active: [document] });
      return restarted.recoverAll();
    })();
    expect(recovered?.id).toBe('pinned-listing-run');
  });
});
