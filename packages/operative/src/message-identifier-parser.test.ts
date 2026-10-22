/**
 * COR-1560 — the parser that reads a run's assistant step id back: the inverse of
 * `assistantMessageIdentifier`, and nothing else's.
 */
import { describe, expect, it } from 'bun:test';

import {
  assistantMessageIdentifier,
  inputMessageIdentifier,
  parseAssistantMessageIdentifier,
  parseStepRowIdentifier,
  signalMessageIdentifier,
  toolCallMessageIdentifiers,
  toolResultMessageIdentifier,
} from './message-identifiers';

describe('parseAssistantMessageIdentifier', () => {
  it('reads back the run and the step of an id it was built from', () => {
    for (const [runId, step] of [
      ['run-1-3f2a', 0],
      ['run-1-3f2a', 12],
      ['a:b:c', 3],
      ['run:step:9', 1],
    ] as const) {
      const id = assistantMessageIdentifier(runId, step)!;
      expect(parseAssistantMessageIdentifier(id)).toEqual({ runId, step });
    }
  });

  it('is undefined for every other id a run mints', () => {
    for (const id of [
      toolResultMessageIdentifier('run-1', 0, 'c1')!,
      `${assistantMessageIdentifier('run-1', 0)!}:call:c1`,
      inputMessageIdentifier('run-1')!,
      signalMessageIdentifier('run-1', 'human-response', 0)!,
    ]) {
      expect(parseAssistantMessageIdentifier(id)).toBeUndefined();
    }
  });

  it('is undefined for an id in no such form, without throwing', () => {
    for (const id of [
      '',
      'step:1',
      ':step:1',
      'run:step:',
      'run:step:x',
      'run:step:-1',
      'run:step:1.5',
      'conversation-1-abc',
      'run:step:1 ',
    ]) {
      expect(parseAssistantMessageIdentifier(id)).toBeUndefined();
    }
  });
});

describe('parseStepRowIdentifier', () => {
  it('reads back the run, the step and the kind of every row id a step mints', () => {
    for (const runId of ['run-1-3f2a', 'a:b:c', 'run:step:9']) {
      const step = assistantMessageIdentifier(runId, 2)!;
      expect(parseStepRowIdentifier(step)).toEqual({ runId, step: 2, kind: 'step' });
      expect(
        parseStepRowIdentifier(toolCallMessageIdentifiers(step, [{ id: 'c-1' }], true)![0]!),
      ).toEqual({
        runId,
        step: 2,
        kind: 'call',
        callId: 'c-1',
      });
      expect(parseStepRowIdentifier(toolResultMessageIdentifier(runId, 2, 'c-1')!)).toEqual({
        runId,
        step: 2,
        kind: 'result',
        callId: 'c-1',
      });
    }
  });

  it('reads the call row that stands in for a step with no text as the step id', () => {
    const step = assistantMessageIdentifier('run-1', 1)!;
    const [first] = toolCallMessageIdentifiers(step, [{ id: 'c-9' }], false)!;

    expect(first).toBe(step);
    expect(parseStepRowIdentifier(first!)).toEqual({ runId: 'run-1', step: 1, kind: 'step' });
  });

  it('is undefined for the rows that are no step’s, and for an id in no such form', () => {
    for (const id of [
      inputMessageIdentifier('run-1')!,
      signalMessageIdentifier('run-1', 'human-response', 0)!,
      'conversation-1-abc',
      '',
      'run:step:',
      'run:step:1:call:',
      'run:step:1:result:',
      'run:step:x:call:c',
    ]) {
      expect(parseStepRowIdentifier(id)).toBeUndefined();
    }
  });
});
