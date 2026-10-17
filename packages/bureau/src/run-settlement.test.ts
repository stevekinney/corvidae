import { describe, expect, it } from 'bun:test';

import { settledActionTimestamp } from './run-settlement';

describe('settledActionTimestamp', () => {
  it('reads nothing from a run that is running or has only recorded run.error', () => {
    expect(settledActionTimestamp([])).toBeUndefined();
    expect(settledActionTimestamp([{ type: 'step.completed', timestamp: 5 }])).toBeUndefined();
    // Operative marks the run `error` here and dispatches `run.completed` next:
    // between the two the run is still finishing and must not read as settled.
    expect(
      settledActionTimestamp([
        { type: 'step.completed', timestamp: 5 },
        { type: 'run.error', timestamp: 6 },
      ]),
    ).toBeUndefined();
  });

  it('reads the closing action once it has been recorded', () => {
    expect(
      settledActionTimestamp([
        { type: 'run.error', timestamp: 6 },
        { type: 'run.completed', timestamp: 9 },
      ]),
    ).toBe(9);
    expect(settledActionTimestamp([{ type: 'run.aborted', timestamp: 4 }])).toBe(4);
  });
});
