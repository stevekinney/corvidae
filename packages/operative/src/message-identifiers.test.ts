/**
 * COR-1560 — the parser that reads a run's assistant step id back: the inverse of
 * `assistantMessageIdentifier`, and nothing else's.
 */
import { describe, expect, it } from 'bun:test';

import {
  assistantMessageIdentifier,
  inputMessageIdentifier,
  parseAssistantMessageIdentifier,
  signalMessageIdentifier,
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
