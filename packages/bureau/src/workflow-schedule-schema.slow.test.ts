/**
 * COR-1812, COR-1927 — a real schedule fire against an `inputSchema`. A fire carries no input,
 * which is `null`, so a schedule-triggered file can only declare a schema that accepts `null`
 * (a file whose schema refuses it is refused when written, instead of failing every fire). Such a
 * file's fires start, pass the input check, and run their steps. It waits for the engine's own
 * one-second cadence, so it is a slow test.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { waitUntil } from '@lostgradient/testing/wait-until';

import { workflowFileText } from './testing/workflow-file-fixtures.test-support';
import {
  startWorkflowBureau,
  type WorkflowBureauHarness,
} from './testing/workflow-bureau.test-support';

const harnesses: WorkflowBureauHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

describe('a schedule fire against an inputSchema', () => {
  it('passes a schema that accepts null, runs the steps, and leaves the schedule running', async () => {
    const harness = await startWorkflowBureau();
    harnesses.push(harness);
    await harness.put(
      'nightly.json',
      workflowFileText('nightly', {
        trigger: { kind: 'schedule', spec: '1s' },
        inputSchema: { type: ['object', 'null'], required: ['city'] },
      }),
    );
    await harness.bureau.workflows?.refresh();
    const engine = harness.bureau.durableEngine()!;

    await waitUntil(
      async () => {
        const page = await engine.list({ type: 'nightly', status: ['completed'] });
        return page.items.length > 0;
      },
      { message: 'a fire passed its input schema and completed' },
    );

    const failed = await engine.list({ type: 'nightly', status: ['failed'] });
    expect(failed.items).toEqual([]);
    expect(harness.calls.length).toBeGreaterThan(0);
    const schedule = await harness.bureau.schedules.get('bureau-workflow-schedule:nightly:1');
    expect(schedule?.status).toBe('active');
  });

  it('never starts a file whose schema refuses null: the file is invalid, so no schedule exists', async () => {
    const harness = await startWorkflowBureau();
    harnesses.push(harness);
    await harness.put(
      'nightly.json',
      workflowFileText('nightly', {
        trigger: { kind: 'schedule', spec: '1s' },
        inputSchema: { type: 'object', required: ['city'] },
      }),
    );
    await harness.bureau.workflows?.refresh();

    const listing = harness.bureau.workflows?.list().find((entry) => entry.id === 'nightly');
    expect(listing?.state).toBe('invalid');
    expect(listing?.problem?.issues?.[0]?.path).toBe('inputSchema');
    const page = await harness.bureau.schedules.list();
    expect(page?.items).toEqual([]);
  });
});
