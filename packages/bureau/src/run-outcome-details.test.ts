import {
  type ActiveRun,
  AgentRunError,
  createAgentRunEventRegistry,
  RunErrorEvent,
} from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { attachRunEventFeed } from './run-event-feed-attachment';
import { createRunOutcomeDetails } from './run-outcome-details';

/** A run that is only an event target, which is all the attachment reads. */
function fakeRun(): {
  readonly run: Pick<ActiveRun, 'addEventListener' | 'removeEventListener'>;
  readonly dispatch: (event: Event) => void;
} {
  const target = new EventTarget();
  return {
    run: target as unknown as Pick<ActiveRun, 'addEventListener' | 'removeEventListener'>,
    dispatch: (event) => {
      target.dispatchEvent(event);
    },
  };
}

const PROVIDER_FAILURE = new AgentRunError('the provider failed', {
  kind: 'generate',
  code: 'UNKNOWN',
});

describe('run outcome details (COR-2095)', () => {
  it('hands an entry over once: take removes it', () => {
    const details = createRunOutcomeDetails();
    details.record('run-1', { step: 2, error: { code: 'E_CODE', kind: 'generate' } });

    expect(details.size()).toBe(1);
    expect(details.take('run-1')).toEqual({ step: 2, errorCode: 'E_CODE', errorKind: 'generate' });
    expect(details.take('run-1')).toBeUndefined();
    expect(details.size()).toBe(0);
  });

  it('omits the step of a reconstructed RunErrorEvent, whose step is a count and not the failing step', () => {
    const details = createRunOutcomeDetails();
    details.record('run-1', {
      step: 7,
      error: { code: 'E_CODE', kind: 'generate' },
      reconstructed: true,
    });

    const entry = details.take('run-1');
    expect(entry).toEqual({ errorCode: 'E_CODE', errorKind: 'generate' });
    expect(entry).not.toHaveProperty('step');
  });

  it('keeps a code only when it is an identifier and a kind only when it is a known one', () => {
    const details = createRunOutcomeDetails();
    details.record('run-1', {
      step: 1,
      error: { code: 'rate limited, call 555-0100', kind: 'free text' },
    });
    details.record('run-2', { step: 1, error: { code: 'a'.repeat(10), kind: 'policy' } });
    details.record('run-3', { step: 1, error: { code: 'A'.repeat(65), kind: 'policy' } });

    expect(details.take('run-1')).toEqual({ step: 1, errorCode: 'UNKNOWN' });
    expect(details.take('run-2')).toEqual({ step: 1, errorCode: 'UNKNOWN', errorKind: 'policy' });
    expect(details.take('run-3')).toEqual({ step: 1, errorCode: 'UNKNOWN', errorKind: 'policy' });
  });

  it('forgets one run and clears every run', () => {
    const details = createRunOutcomeDetails();
    details.record('run-1', { step: 0, error: { code: 'E_CODE', kind: 'generate' } });
    details.record('run-2', { step: 0, error: { code: 'E_CODE', kind: 'generate' } });

    details.forget('run-1');
    expect(details.size()).toBe(1);
    details.clear();
    expect(details.size()).toBe(0);
  });
});

describe('attachRunEventFeed and the outcome details (COR-2095)', () => {
  it('records the live RunErrorEvent under the run, with its step, code and kind', () => {
    const details = createRunOutcomeDetails();
    const { run, dispatch } = fakeRun();
    attachRunEventFeed('run-1', run, createAgentRunEventRegistry(), { outcomeDetails: details });

    dispatch(new RunErrorEvent(3, PROVIDER_FAILURE));

    expect(details.take('run-1')).toEqual({
      step: 3,
      errorCode: PROVIDER_FAILURE.code,
      errorKind: PROVIDER_FAILURE.kind,
    });
  });

  it('records a reconstructed RunErrorEvent without its step (a reattached run)', () => {
    const details = createRunOutcomeDetails();
    const { run, dispatch } = fakeRun();
    attachRunEventFeed('run-1', run, createAgentRunEventRegistry(), { outcomeDetails: details });

    dispatch(new RunErrorEvent(9, PROVIDER_FAILURE, undefined, { reconstructed: true }));

    const entry = details.take('run-1');
    expect(entry).toMatchObject({
      errorCode: PROVIDER_FAILURE.code,
      errorKind: PROVIDER_FAILURE.kind,
    });
    expect(entry).not.toHaveProperty('step');
  });

  it('reports a recorder that throws, and the run’s own dispatch goes on', () => {
    const reported: Array<[unknown, string]> = [];
    const { run, dispatch } = fakeRun();
    attachRunEventFeed('run-1', run, createAgentRunEventRegistry(), {
      outcomeDetails: {
        record() {
          throw new Error('recorder down');
        },
        recordRetrying() {},
      },
      onError: (error, kind) => reported.push([error, kind]),
    });

    expect(() => dispatch(new RunErrorEvent(0, PROVIDER_FAILURE))).not.toThrow();
    expect(reported.map(([, kind]) => kind)).toContain('run.error');
  });

  it('stops recording once the run is detached', () => {
    const details = createRunOutcomeDetails();
    const { run, dispatch } = fakeRun();
    const detach = attachRunEventFeed('run-1', run, createAgentRunEventRegistry(), {
      outcomeDetails: details,
    });

    detach();
    dispatch(new RunErrorEvent(0, PROVIDER_FAILURE));

    expect(details.size()).toBe(0);
  });

  it('records nothing for a run attached with no details, as before', () => {
    const { run, dispatch } = fakeRun();
    attachRunEventFeed('run-1', run, createAgentRunEventRegistry());

    expect(() => dispatch(new RunErrorEvent(0, PROVIDER_FAILURE))).not.toThrow();
  });
});
