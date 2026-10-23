/** The order a person reads the run states in, and which of them mean a run is over. */
import { describe, expect, test } from 'bun:test';

import { TASK_STATE_ORDER, isTaskOver } from './task-status.ts';

describe('a task’s state', () => {
  test('is over once it completed, failed, or was canceled, and not while it waits or works', () => {
    expect(TASK_STATE_ORDER.filter(isTaskOver)).toEqual(['completed', 'failed', 'canceled']);
    expect(isTaskOver('input-required')).toBe(false);
    expect(isTaskOver('working')).toBe(false);
  });
});
