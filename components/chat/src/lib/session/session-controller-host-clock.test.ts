/**
 * COR-2014: a host whose server keeps its own clock stamps the rows the person writes with it, a
 * turn's message and a follow-up alike, so the transcript reads one clock; without one, the rows
 * carry the browser's time as before.
 */
import { describe, expect, test } from 'bun:test';

import { createHarness, settle } from './session-controller-run-input-test-support.ts';

const HOST_NOW = '2026-11-02T16:45:00.000Z';

describe('the host’s clock on the rows the person writes', () => {
  test('stamps a turn’s message and a follow-up with the host’s time', async () => {
    const harness = createHarness({ now: () => HOST_NOW });
    const run = harness.startRun();
    await settle();
    const followUp = harness.controller.adapter.sendRunInput!(
      'run-input',
      { role: 'user', content: 'Also look up order 4398, the same carrier.' },
      [],
    );
    await settle();
    expect(harness.rowNamed('start')?.createdAt).toBe(HOST_NOW);
    expect(harness.rowNamed('Also look up order 4398, the same carrier.')?.createdAt).toBe(
      HOST_NOW,
    );
    harness.releaseRun();
    await run;
    await followUp;
  });

  test('keeps the browser’s time when the host gives none', async () => {
    const harness = createHarness();
    const before = Date.now();
    const run = harness.startRun();
    await settle();
    const stamped = Date.parse(harness.rowNamed('start')?.createdAt ?? '');
    expect(stamped).toBeGreaterThanOrEqual(before);
    harness.releaseRun();
    await run;
  });
});
