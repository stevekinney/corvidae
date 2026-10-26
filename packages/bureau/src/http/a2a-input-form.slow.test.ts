/**
 * COR-1683 — the previous form's surface is still found when the run's audit trail is long: more
 * than 10,000 records, or 50 plain human waits after the form. Real parks take about a second each,
 * so this lives in the slow lane.
 */
import type { Task } from '@a2a-js/sdk';
import { describe, expect, it } from 'bun:test';

import { A2UI_EXTENSION_URI } from '../a2ui/catalogs.ts';
import { waitForCondition } from '../test';
import { deploySchema, open, userMessage } from './a2a-input-form.test-support.ts';

describe('the previous form lookup on a long audit trail', () => {
  it('still closes the previous form’s surface when the run has more than 10,000 audit records', async () => {
    const fixture = await open(deploySchema, ['deploy', 'region']);
    try {
      const task = await fixture.start();
      await fixture.send(userMessage('m-first', task.id, { data: { environment: 'staging' } }));
      await waitForCondition(async () => {
        const view = await fixture.bureau.tasks.get(task.id);
        return (
          view?.status === 'input-required' &&
          view.openWaits.some((wait) => wait.kind === 'human-wait' && wait.signalName === 'region')
        );
      }, 'the task never parked on the second signal');

      // Older than every record the run wrote, so an oldest-first read of 10,000 never reaches the form.
      const trail = fixture.bureau.auditTrail!;
      for (let start = 0; start < 10_001; start += 500) {
        await Promise.all(
          Array.from({ length: 500 }, (_, offset) =>
            trail.record({
              runId: task.id,
              type: 'noise',
              detail: null,
              timestampMs: 1_000 + start + offset,
            }),
          ),
        );
      }

      const read = await fixture.read(task.id, [A2UI_EXTENSION_URI]);
      const data = (read.status?.message?.parts ?? []).find(
        (part) => part.content?.$case === 'data',
      );
      const messages =
        data?.content?.$case === 'data' ? (data.content.value as Record<string, any>[]) : [];
      expect(messages[0]).toEqual({
        version: 'v0.9',
        deleteSurface: { surfaceId: `input-form:human-wait:${task.id}:deploy:0` },
      });
    } finally {
      await fixture.opened.dispose();
    }
  });

  it('still closes the previous form’s surface after 50 or more plain waits followed it', async () => {
    const plain = Array.from({ length: 51 }, (_, index) => `plain-${index}`);
    const fixture = await open(deploySchema, ['deploy', ...plain, 'region'], ['deploy', 'region']);
    const parkedOn = (task: Task, signalName: string) =>
      waitForCondition(async () => {
        const view = await fixture.bureau.tasks.get(task.id);
        return (
          view?.status === 'input-required' &&
          view.openWaits.some(
            (wait) => wait.kind === 'human-wait' && wait.signalName === signalName,
          )
        );
      }, `the task never parked on ${signalName}`);
    try {
      const task = await fixture.start();
      await fixture.send(userMessage('m-form', task.id, { data: { environment: 'staging' } }));
      for (const signalName of plain) {
        await parkedOn(task, signalName);
        await fixture.send(userMessage(`m-${signalName}`, task.id, { text: 'ok' }));
      }
      await parkedOn(task, 'region');

      const read = await fixture.read(task.id, [A2UI_EXTENSION_URI]);
      const data = (read.status?.message?.parts ?? []).find(
        (part) => part.content?.$case === 'data',
      );
      const messages =
        data?.content?.$case === 'data' ? (data.content.value as Record<string, any>[]) : [];
      expect(messages[0]).toEqual({
        version: 'v0.9',
        deleteSurface: { surfaceId: `input-form:human-wait:${task.id}:deploy:0` },
      });
    } finally {
      await fixture.opened.dispose();
    }
  });
});
