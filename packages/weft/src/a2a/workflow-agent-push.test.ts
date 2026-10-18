import { describe, expect, test } from 'bun:test';

import { StreamResponse, TaskState } from '@a2a-js/sdk';
import { ContentTypeNotSupportedError } from '@a2a-js/sdk/errors';

import { rejectionOf } from '../testing/promise-outcome.test-support.ts';
import {
  callContext,
  createWorkflowAgentFixture,
  sendRequest,
  textPart,
  userMessage,
  useWorkflowAgentFixtures,
  waitForState,
} from './workflow-agent.test-support.ts';

useWorkflowAgentFixtures();

const alice = () => callContext({ user: 'alice' });

/** Deliver every queued notification and return what each carried: a state or an event kind. */
async function deliveredStates(fixture: Awaited<ReturnType<typeof createWorkflowAgentFixture>>) {
  for (;;) {
    const delivered = await fixture.push.outbox.deliverNext();
    if (delivered.status === 'empty') break;
  }
  return fixture.push.receiver.requests.map((request) => {
    const payload = StreamResponse.fromJSON(JSON.parse(request.body)).payload;
    return payload?.$case === 'statusUpdate' ? payload.value.status?.state : payload?.$case;
  });
}

describe('workflow agent push notifications', () => {
  test('notifies a configuration sent with the first message of every change, from the first', async () => {
    const fixture = await createWorkflowAgentFixture();
    const message = userMessage();
    const task = await fixture.agent.requestHandler.sendMessage(
      sendRequest(message, {
        taskPushNotificationConfig: {
          id: 'config-1',
          taskId: '',
          url: fixture.push.receiver.url(),
          token: 'token-1',
          authentication: { scheme: 'Bearer', credentials: 'secret' },
          tenant: '',
        },
      }),
      alice(),
    );

    // Each notification is its own outbox delivery, so they arrive in no fixed order.
    const states = await deliveredStates(fixture);

    expect(states).toContain(TaskState.TASK_STATE_SUBMITTED);
    expect(states).toContain(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(fixture.push.receiver.requests[0]?.headers['authorization']).toBe('Bearer secret');
    const stored = await fixture.push.pushStore.load('id' in task ? task.id : '', alice());
    expect(stored.map((config) => config.id)).toEqual(['config-1']);
  });

  test('notifies the task’s owner of a change the engine reports while no request runs', async () => {
    const fixture = await createWorkflowAgentFixture();
    const task = await fixture.agent.requestHandler.sendMessage(
      sendRequest(userMessage(), {
        taskPushNotificationConfig: {
          id: 'config-1',
          taskId: '',
          url: fixture.push.receiver.url(),
          token: '',
          authentication: undefined,
          tenant: '',
        },
      }),
      alice(),
    );
    const taskId = 'id' in task ? task.id : '';

    await fixture.engine.signal(taskId, 'input', 'from elsewhere');
    await fixture.engine.getHandle(taskId).result();
    await fixture.agent.idle();

    const states = await deliveredStates(fixture);
    expect(states).toContain('artifactUpdate');
    expect(states).toContain(TaskState.TASK_STATE_COMPLETED);
    expect(fixture.errors).toEqual([]);
  });

  test('reports a push enqueue that fails to onError and still serves the request', async () => {
    const fixture = await createWorkflowAgentFixture();
    fixture.push.sender.send = async () => {
      throw new Error('outbox full');
    };

    const task = await fixture.agent.requestHandler.sendMessage(
      sendRequest(userMessage()),
      alice(),
    );

    expect('status' in task && task.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(fixture.errors.length).toBeGreaterThan(0);
    expect(fixture.errors[0]).toMatchObject({ message: 'outbox full' });
    await waitForState(
      fixture.agent,
      'id' in task ? task.id : '',
      alice(),
      TaskState.TASK_STATE_INPUT_REQUIRED,
    );
  });
});

describe('message media types', () => {
  test('refuses a part whose media type the card does not accept', async () => {
    const { agent } = await createWorkflowAgentFixture({ inputMode: 'text' });
    const part = { ...textPart('hello'), mediaType: 'application/x-unsupported' };

    expect(
      await rejectionOf(
        agent.requestHandler.sendMessage(sendRequest(userMessage({ parts: [part] })), alice()),
      ),
    ).toBeInstanceOf(ContentTypeNotSupportedError);
    const accepted = await agent.requestHandler.sendMessage(
      sendRequest(userMessage({ parts: [{ ...part, mediaType: 'text/plain' }] })),
      alice(),
    );
    expect('status' in accepted && accepted.status?.state).toBe(
      TaskState.TASK_STATE_INPUT_REQUIRED,
    );
  });
});
