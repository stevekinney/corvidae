/**
 * COR-1812 — a real schedule fire against an `inputSchema`. A fire carries no input, so a schema
 * that asks for an object is broken by every fire: the instance exists and fails with
 * `input-invalid` (Weft starts it, so Bureau cannot refuse it first), no step runs, and the
 * schedule stays active. It waits for the engine's own one-second cadence, so it is a slow test.
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
  it('fails the instance with input-invalid and its issues, and leaves the schedule running', async () => {
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
    const engine = harness.bureau.durableEngine()!;

    await waitUntil(
      async () => {
        const page = await engine.list({ type: 'nightly', status: ['failed'] });
        return page.items.length > 0;
      },
      { message: 'a fire failed its input schema' },
    );

    const failedPage = await engine.list({ type: 'nightly', status: ['failed'] });
    const failed = failedPage.items[0]!;
    const run = await harness.bureau.workflows!.getRun(failed.id);
    expect(run?.finishReason).toBe('input-invalid');
    expect(run?.error).toBe('input-invalid: The input must be object');
    expect(run?.trigger).toMatchObject({
      kind: 'schedule',
      scheduleId: 'bureau-workflow-schedule:nightly:1',
    });
    expect(harness.calls).toEqual([]);
    const schedule = await harness.bureau.schedules.get('bureau-workflow-schedule:nightly:1');
    expect(schedule?.status).toBe('active');
  });
});
