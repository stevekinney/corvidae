import { describe, expect, test } from 'bun:test';

import {
  applyEnvironmentCall,
  type EnvironmentState,
  meetsExpectation,
  replayEnvironment,
} from './environment';

const UNTOUCHED: EnvironmentState = { kind: 'untouched' };

describe('applyEnvironmentCall', () => {
  test("accepts the task's action with a value, or the task's action reported unknown", () => {
    expect(
      applyEnvironmentCall(UNTOUCHED, 'ship_order', {
        name: 'environment_action',
        arguments: { action: 'ship_order', value: '17 Cedar Lane' },
      }),
    ).toEqual({
      accepted: true,
      state: { kind: 'acted', action: 'ship_order', value: '17 Cedar Lane' },
    });
    expect(
      applyEnvironmentCall(UNTOUCHED, 'ship_order', {
        name: 'environment_unknown',
        arguments: { action: 'ship_order' },
      }),
    ).toEqual({ accepted: true, state: { kind: 'unknown', action: 'ship_order' } });
  });

  test('refuses another tool, malformed arguments, another action, and a second completion', () => {
    const refusal = (state: EnvironmentState, name: string, input: unknown) => {
      const step = applyEnvironmentCall(state, 'ship_order', { name, arguments: input });
      expect(step.state).toBe(state);
      return step.accepted ? 'accepted' : step.refusal;
    };
    expect(refusal(UNTOUCHED, 'memory_recall', {})).toBe('unknown-tool');
    expect(refusal(UNTOUCHED, 'environment_action', { action: 'ship_order' })).toBe('malformed');
    expect(refusal(UNTOUCHED, 'environment_unknown', {})).toBe('malformed');
    expect(refusal(UNTOUCHED, 'environment_unknown', { action: 'refund_order' })).toBe(
      'wrong-action',
    );
    const done: EnvironmentState = { kind: 'unknown', action: 'ship_order' };
    expect(refusal(done, 'environment_unknown', { action: 'ship_order' })).toBe(
      'already-completed',
    );
  });
});

describe('replayEnvironment', () => {
  test('applies calls in order and keeps every refusal', () => {
    expect(
      replayEnvironment('ship_order', [
        { name: 'environment_action', arguments: { action: 'refund_order', value: 'x' } },
        { name: 'environment_action', arguments: { action: 'ship_order', value: 'x' } },
        { name: 'environment_unknown', arguments: { action: 'ship_order' } },
      ]),
    ).toEqual({
      state: { kind: 'acted', action: 'ship_order', value: 'x' },
      refusals: ['wrong-action', 'already-completed'],
    });
  });
});

describe('meetsExpectation', () => {
  test('compares an acted value exactly after trimming, and an expected unknown by kind', () => {
    const acted: EnvironmentState = { kind: 'acted', action: 'ship_order', value: ' gold ' };
    expect(meetsExpectation(acted, { kind: 'act', value: 'gold' })).toBe(true);
    expect(meetsExpectation(acted, { kind: 'act', value: 'Gold' })).toBe(false);
    expect(meetsExpectation(acted, { kind: 'unknown' })).toBe(false);
    expect(meetsExpectation(UNTOUCHED, { kind: 'act', value: 'gold' })).toBe(false);
    expect(meetsExpectation({ kind: 'unknown', action: 'x' }, { kind: 'unknown' })).toBe(true);
  });
});
