/**
 * COR-1302 — `Store.removeRun` releases everything the store held for a run.
 *
 * Bureau registers each `bureau.run()` run on its store and removes it once it
 * settles, so a store that kept a removed run's actions in its store-wide log
 * would grow by every historical run's event payloads for its whole life.
 *
 * COR-1614 — `Store.settleRun` ends a run's record that no terminal event will end.
 */
import { CompletableEventTarget } from '@lostgradient/lifecycle';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';

import { stopWhen } from '../conditions/index';
import { type ActiveRun, createActiveRun } from '../create-run';
import { makeInterruptedRunResult } from '../durable/active-run-result-reconstruction';
import { type CombinedOperativeEventMap, RunCompletedEvent } from '../events';
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

/** A run that settles only when the test says so, through `emitter`. */
function heldRun(emitter: CompletableEventTarget<CombinedOperativeEventMap>): ActiveRun {
  return { toObservable: emitter.toObservable.bind(emitter) } as unknown as ActiveRun;
}

describe('Store.settleRun (COR-1614)', () => {
  it('ends a running run’s record with the outcome, once, and stops observing the run', () => {
    const store = createStore();
    const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
    store.register(heldRun(emitter), 'held-run');
    const dispatched: string[] = [];
    store.subscribe((_, action) => dispatched.push(action.type));
    const error = new Error('cancelled elsewhere');

    store.settleRun('held-run', 'run.aborted', { error, committedElsewhere: true });
    store.settleRun('held-run', 'run.error', { error: new Error('second') });
    emitter.dispatch(new RunCompletedEvent(makeInterruptedRunResult(new Conversation())));

    const run = store.getRun('held-run');
    expect(run?.status).toBe('aborted');
    expect(run?.error).toBe(error);
    expect(run?.actions.map((action) => action.type)).toEqual(['run.aborted']);
    expect(run?.actions[0]?.detail).toEqual({ error, committedElsewhere: true });
    expect(dispatched).toEqual(['run.aborted']);
  });

  it('records a failure as `error`, and does nothing for a run it does not hold', () => {
    const store = createStore();
    store.register(heldRun(new CompletableEventTarget<CombinedOperativeEventMap>()), 'failed-run');
    const error = new Error('timed out elsewhere');

    store.settleRun('failed-run', 'run.error', { error });
    store.settleRun('unknown-run', 'run.error', { error });

    expect(store.getRun('failed-run')?.status).toBe('error');
    expect(store.getRun('failed-run')?.error).toBe(error);
    expect(store.getRun('unknown-run')).toBeUndefined();
    expect(store.getState().actions.map((action) => action.runId)).toEqual(['failed-run']);
  });
});
