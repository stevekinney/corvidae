/** Tests for the workflow world the page tests stand on: the answers it gives that no page test asks for. */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  emptyWorld,
  installWorkflowWorld,
  scheduleFixture,
  type WorkflowStub,
} from './workflow-world.test-support.ts';

let stub: WorkflowStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

function call(method: string, params: unknown, path = '/bureau/jsonrpc'): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

describe('the workflow world', () => {
  test('answers 400 to a body that names no method, and records no call', async () => {
    stub = installWorkflowWorld();

    for (const body of ['[]', '{}', '{"method":7}']) {
      const response = await fetch('/bureau/jsonrpc', { method: 'POST', body });
      expect(response.status, body).toBe(400);
    }
    expect(stub.calls).toEqual([]);
  });

  test('refuses the revisions of a file it does not hold, as the Bureau does', async () => {
    stub = installWorkflowWorld();

    const response = await call('bureau.workflows.revisions', { id: 'missing' });
    const answer: unknown = await response.json();

    expect(answer).toMatchObject({
      error: { message: 'No workflow missing.', data: { httpStatus: 404 } },
    });
  });

  test('refuses to create a file from a definition that names itself', async () => {
    stub = installWorkflowWorld();

    const response = await call('bureau.workflows.create', {
      id: 'new-file',
      definition: { name: 'new-file' },
    });
    const answer: unknown = await response.json();

    expect(answer).toMatchObject({
      error: { message: 'Unrecognized key: "name"', data: { httpStatus: 400 } },
    });
  });

  test('resumes a paused schedule, and leaves an active one as it is', async () => {
    stub = installWorkflowWorld(
      emptyWorld({
        schedules: [
          scheduleFixture('paused-one', 'order', { status: 'paused' }),
          scheduleFixture('active-one', 'order'),
        ],
      }),
    );

    for (const id of ['paused-one', 'active-one']) {
      const response = await fetch(`/api/schedules/${id}/resume`, { method: 'POST' });
      expect(response.status).toBe(204);
    }

    expect(stub.world.schedules.map((schedule) => [schedule.id, schedule.status])).toEqual([
      ['paused-one', 'active'],
      ['active-one', 'active'],
    ]);
  });
});
