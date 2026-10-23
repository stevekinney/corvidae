import { describe, expect, test } from 'bun:test';

import { parseRunFilter } from '../workflows/runs/run-rows.ts';
import { runsPathForStatus } from './runs-link.ts';
import { STATUS_DISPLAY_ORDER } from './status-tone.ts';

describe('runsPathForStatus', () => {
  test('reads each engine status as the state of a run the list can filter by', () => {
    expect(STATUS_DISPLAY_ORDER.map((status) => [status, runsPathForStatus(status)])).toEqual([
      ['running', '/runs?status=working'],
      ['pending', '/runs?status=working'],
      ['suspended', '/runs?status=working'],
      ['completed', '/runs?status=completed'],
      ['cancelled', '/runs?status=canceled'],
      ['failed', '/runs?status=failed'],
      ['timed-out', '/runs?status=failed'],
    ]);
  });

  test('names a filter the runs list reads, for every status', () => {
    for (const status of STATUS_DISPLAY_ORDER) {
      const search = new URL(runsPathForStatus(status), 'http://localhost').searchParams;
      expect(parseRunFilter(search).status, status).toBeDefined();
    }
  });
});
