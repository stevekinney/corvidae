/**
 * COR-1302 — `Store.removeRun` releases everything the store held for a run.
 *
 * Bureau registers each `bureau.run()` run on its store and removes it once it
 * settles, so a store that kept a removed run's actions in its store-wide log
 * would grow by every historical run's event payloads for its whole life.
 */
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { stopWhen } from '../conditions/index';
import { createActiveRun } from '../create-run';
import { createStore } from './store';

function completedRun(runId: string) {
  return createActiveRun({
    runId,
    generate: async () => ({ content: 'done', toolCalls: [] }),
    toolbox: createToolbox([]),
    conversation: createConversationHistory(),
    stopWhen: stopWhen.noToolCalls(),
  });
}

describe('Store.removeRun (COR-1302)', () => {
  it('drops the removed run’s actions from the store-wide log and keeps every other run’s', async () => {
    const store = createStore();
    const removed = completedRun('removed-run');
    const kept = completedRun('kept-run');
    store.register(removed, removed.runId);
    store.register(kept, kept.runId);
    await Promise.all([removed.result, kept.result]);

    const runIdsInLog = () => new Set(store.getState().actions.map((action) => action.runId));
    expect(runIdsInLog()).toEqual(new Set(['removed-run', 'kept-run']));
    const keptActions = store.getState().actions.filter((action) => action.runId === 'kept-run');

    store.removeRun('removed-run');

    expect(store.getRun('removed-run')).toBeUndefined();
    expect(runIdsInLog()).toEqual(new Set(['kept-run']));
    expect(store.getState().actions).toEqual(keptActions);
    expect(store.getRun('kept-run')?.actions).toEqual(keptActions);
  });
});
