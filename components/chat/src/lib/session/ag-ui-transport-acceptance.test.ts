import type { Event as AGUIEvent } from '@ag-ui/core';
import { describe, expect, test } from 'bun:test';
import { AGUIChatTransportError } from './ag-ui-transport-error.ts';
import { emptyConversation, runFinished, runStarted } from './ag-ui-transport-test-support.ts';
import { mapAGUIEventsToChatStream } from './ag-ui-transport.ts';

type Entry = readonly ['accepted', unknown] | readonly ['frame', string];

/**
 * Runs `events` through the mapper and records, in one log, each acceptance
 * and each frame the consumer received, in the order they happened.
 */
async function trace(
  events: unknown[],
  onAccepted?: (event: AGUIEvent) => void,
): Promise<{ log: Entry[]; failure: unknown }> {
  const log: Entry[] = [];
  let failure: unknown;
  try {
    for await (const frame of mapAGUIEventsToChatStream(events, {
      conversation: emptyConversation(),
      onEventAccepted: (event) => {
        log.push(['accepted', event]);
        onAccepted?.(event);
      },
    }))
      log.push(['frame', frame.type]);
  } catch (error) {
    failure = error;
  }
  return { log, failure };
}

function accepted(log: Entry[]): unknown[] {
  return log.flatMap((entry) => (entry[0] === 'accepted' ? [entry[1]] : []));
}

describe('semantic acceptance of AG-UI events', () => {
  test('accepts each source event once, by identity, before any frame it produced', async () => {
    const stepStarted = { type: 'STEP_STARTED', stepName: 'plan' };
    const stepFinished = { type: 'STEP_FINISHED', stepName: 'plan' };

    const { log, failure } = await trace([runStarted, stepStarted, stepFinished, runFinished]);

    expect(failure).toBeUndefined();
    expect(log).toEqual([
      ['accepted', runStarted],
      ['frame', 'run.started'],
      ['accepted', stepStarted],
      ['frame', 'stream:block-start'],
      ['accepted', stepFinished],
      ['frame', 'stream:block-complete'],
      ['accepted', runFinished],
      ['frame', 'run.completed'],
    ]);
    const identities = accepted(log);
    expect(identities[0]).toBe(runStarted);
    expect(identities[1]).toBe(stepStarted);
    expect(identities[2]).toBe(stepFinished);
    expect(identities[3]).toBe(runFinished);
  });

  test('accepts skipped subagent events and ignored unsupported events', async () => {
    const custom = { type: 'CUSTOM', name: 'warm-up', value: 1 };
    const subagentStep = { type: 'STEP_STARTED', stepName: 'plan', subagentRunId: 's1' };
    const state = { type: 'STATE_SNAPSHOT', snapshot: {} };
    const events = [custom, runStarted, subagentStep, state, runFinished];

    const { log, failure } = await trace(events);

    expect(failure).toBeUndefined();
    expect(accepted(log)).toEqual(events);
    expect(log.filter((entry) => entry[0] === 'frame')).toEqual([
      ['frame', 'run.started'],
      ['frame', 'run.completed'],
    ]);
  });

  test('accepts an unsupported event only after it has closed the open chunk lanes', async () => {
    const custom = { type: 'CUSTOM', name: 'telemetry', value: 1 };

    const { log, failure } = await trace([
      runStarted,
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'a' },
      custom,
      runFinished,
    ]);

    expect(failure).toBeUndefined();
    const acceptedCustom = log.findIndex((entry) => entry[0] === 'accepted' && entry[1] === custom);
    const acceptedFinish = log.findIndex(
      (entry) => entry[0] === 'accepted' && entry[1] === runFinished,
    );
    const closed = log.findIndex(
      (entry) => entry[0] === 'frame' && entry[1] === 'assistant.step.completed',
    );
    expect(acceptedCustom).toBeGreaterThan(-1);
    expect(closed).toBeGreaterThan(acceptedCustom);
    expect(closed).toBeLessThan(acceptedFinish);
  });

  const rejected: Array<[string, unknown[], number, RegExp]> = [
    [
      'an unknown STEP_FINISHED',
      [runStarted, { type: 'STEP_FINISHED', stepName: 'plan' }],
      1,
      /finished without starting/,
    ],
    [
      'a duplicate STEP_STARTED',
      [
        runStarted,
        { type: 'STEP_STARTED', stepName: 'plan' },
        { type: 'STEP_STARTED', stepName: 'plan' },
      ],
      2,
      /started twice/,
    ],
    [
      'an event after the terminal',
      [runStarted, runFinished, { type: 'STEP_STARTED', stepName: 'plan' }],
      2,
      /after the run ended/,
    ],
    ['an event that fails the schema', [runStarted, { type: 'STEP_STARTED' }], 1, /schema/],
  ];

  for (const [label, events, eventIndex, message] of rejected) {
    test(`never accepts ${label}, and keeps its strict error`, async () => {
      const { log, failure } = await trace(events);

      expect(failure).toBeInstanceOf(AGUIChatTransportError);
      expect(failure).toMatchObject({ eventIndex });
      expect((failure as AGUIChatTransportError).message).toMatch(message);
      expect(accepted(log)).toEqual(events.slice(0, eventIndex));
    });
  }

  test('an exception from the callback fails the stream and suppresses that event’s frames', async () => {
    const stepStarted = { type: 'STEP_STARTED', stepName: 'plan' };
    const refusal = new Error('cursor store unavailable');

    const { log, failure } = await trace(
      [runStarted, stepStarted, { type: 'STEP_FINISHED', stepName: 'plan' }, runFinished],
      (event) => {
        if (event === stepStarted) throw refusal;
      },
    );

    expect(failure).toBe(refusal);
    expect(log).toEqual([
      ['accepted', runStarted],
      ['frame', 'run.started'],
      ['accepted', stepStarted],
    ]);
  });

  test('accepts the terminal before its frame, with no later pull', async () => {
    const seen: unknown[] = [];
    const iterator = mapAGUIEventsToChatStream([runStarted, runFinished], {
      conversation: emptyConversation(),
      onEventAccepted: (event) => {
        seen.push(event);
      },
    });

    const first = await iterator.next();
    expect(first.value).toMatchObject({ type: 'run.started' });
    expect(seen).toEqual([runStarted]);
    const second = await iterator.next();
    expect(second.value).toMatchObject({ type: 'run.completed' });
    expect(seen).toEqual([runStarted, runFinished]);
    await iterator.return(undefined);
  });
});
