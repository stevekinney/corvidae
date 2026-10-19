import { describe, expect, it } from 'bun:test';

import {
  type CatalogRunSettlement,
  createCatalogRunSettlementHook,
} from './catalog-run-settlement';

const settlement: CatalogRunSettlement = {
  runId: 'agent-run-1',
  agentName: 'worker',
  status: 'completed',
  finishReason: 'stop-condition',
  message: null,
  content: 'answer',
  recovered: true,
};

describe('the catalog-run settlement hook', () => {
  it('tells every subscriber, in subscription order, and stops telling one that unsubscribed', async () => {
    const hook = createCatalogRunSettlementHook(() => undefined);
    const seen: string[] = [];
    const first = hook.subscribe((event) => void seen.push(`first:${event.runId}`));
    hook.subscribe(async (event) => {
      await Promise.resolve();
      seen.push(`second:${event.runId}`);
    });

    await hook.publish(settlement);
    first();
    await hook.publish({ ...settlement, runId: 'agent-run-2' });

    expect(seen).toEqual(['first:agent-run-1', 'second:agent-run-1', 'second:agent-run-2']);
  });

  it('isolates a listener that throws or rejects, and reports it', async () => {
    const diagnostics: string[] = [];
    const hook = createCatalogRunSettlementHook((diagnostic) =>
      diagnostics.push(diagnostic.message),
    );
    const seen: string[] = [];
    hook.subscribe(() => {
      throw new Error('boom');
    });
    hook.subscribe(() => Promise.reject(new Error('later boom')));
    hook.subscribe((event) => void seen.push(event.runId));

    await hook.publish(settlement);

    expect(seen).toEqual(['agent-run-1']);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.join()).toContain('agent-run-1');
  });
});
