import { describe, expect, test } from 'bun:test';

import { parseWorkflowListFilter } from '../../lib/filters.ts';
import { ENGINE_RUNS_PATH } from '../../lib/workflow-type-paths.ts';
import { engineRunsPathForStatus } from './engine-runs-link.ts';
import { STATUS_DISPLAY_ORDER } from './status-tone.ts';

describe('engineRunsPathForStatus', () => {
  test('opens the engine run list on the status word the engine uses, for each status', () => {
    expect(STATUS_DISPLAY_ORDER.map((status) => [status, engineRunsPathForStatus(status)])).toEqual(
      [
        ['running', '/engine/runs?status=running'],
        ['pending', '/engine/runs?status=pending'],
        ['suspended', '/engine/runs?status=suspended'],
        ['completed', '/engine/runs?status=completed'],
        ['cancelled', '/engine/runs?status=cancelled'],
        ['failed', '/engine/runs?status=failed'],
        ['timed-out', '/engine/runs?status=timed-out'],
      ],
    );
  });

  test('names a filter the engine list reads back as the same status, for every status', () => {
    for (const status of STATUS_DISPLAY_ORDER) {
      const url = new URL(engineRunsPathForStatus(status), 'http://localhost');
      expect(url.pathname).toBe(ENGINE_RUNS_PATH);
      expect(parseWorkflowListFilter(url.searchParams).status, status).toBe(status);
    }
  });

  test('never points at the Bureau runs list', () => {
    for (const status of STATUS_DISPLAY_ORDER) {
      expect(engineRunsPathForStatus(status).startsWith('/runs')).toBe(false);
    }
  });
});
