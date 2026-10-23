import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import { MaximumStepsExceededError } from '../errors';
import { createSessionStore } from './create-session-store';
import { createSessionHandle } from './session-handle';
import { finishReasonToStatus } from './session-handle-support';

/**
 * COR-1627: a session run that stops at its step limit is a failure. Its run reference reads
 * `error`, and `session.monitor` stops on it the way it stops on every other failed tick.
 */

afterEach(async () => {
  await yieldToPortableEventLoop();
});

/** A run whose model never stops, so it ends at its one step. */
function stepLimitRunOptions() {
  return {
    generate: async () => ({ content: 'still going', toolCalls: [] }),
    toolbox: createToolbox([]),
    maximumSteps: 1,
  };
}

function stepLimitFixture() {
  const store = createSessionStore(textValueStore(new MemoryStorage()));
  const handle = createSessionHandle('step-limit-session', {
    store,
    agentName: 'test-agent',
    runOptions: stepLimitRunOptions(),
  });
  return { store, handle };
}

describe('finishReasonToStatus (COR-1627)', () => {
  it('maps a step-limit run to error, beside the other failures, and keeps stops and aborts', () => {
    expect(finishReasonToStatus('maximum-steps')).toBe('error');
    expect(finishReasonToStatus('error')).toBe('error');
    expect(finishReasonToStatus('tripwire')).toBe('error');
    expect(finishReasonToStatus('budget-exceeded')).toBe('error');
    expect(finishReasonToStatus('elicitation-denied')).toBe('error');
    expect(finishReasonToStatus('stop-condition')).toBe('completed');
    expect(finishReasonToStatus('aborted')).toBe('aborted');
  });
});

describe('a session run that hits its step limit (COR-1627)', () => {
  it('commits a run reference with status error and its finish reason', async () => {
    const { store, handle } = stepLimitFixture();

    const result = await handle.run('go').result();
    await yieldToPortableEventLoop();

    expect(result.finishReason).toBe('maximum-steps');
    const session = await store.load('step-limit-session');
    expect(session?.runs).toHaveLength(1);
    expect(session?.runs[0]?.status).toBe('error');
    expect(session?.runs[0]?.outcome?.finishReason).toBe('maximum-steps');
  });

  it('stops session.monitor with the MaximumStepsExceededError before the predicate sees the tick', async () => {
    const { handle } = stepLimitFixture();
    let predicateCalls = 0;

    let caught: unknown;
    try {
      await handle.monitor({
        every: 5,
        input: 'check',
        until: () => {
          predicateCalls += 1;
          return true;
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MaximumStepsExceededError);
    expect(predicateCalls).toBe(0);
  });
});
