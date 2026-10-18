import { describe, expect, test } from 'bun:test';

import { Role, TaskState } from '@a2a-js/sdk';
import {
  RequestMalformedError,
  TaskNotFoundError,
  UnsupportedOperationError,
} from '@a2a-js/sdk/errors';

import { JsonRpcTransportHandler } from '@a2a-js/sdk/server';

import { rejectionOf, throwingRejectionOf } from '../testing/promise-outcome.test-support.ts';
import { payloadOf } from './workflow-agent-messages.ts';
import {
  callContext,
  choiceWorkflow,
  createWorkflowAgentFixture,
  dataPart,
  echoWorkflow,
  sendRequest,
  serveWorkflow,
  startTask,
  textPart,
  userMessage,
  useWorkflowAgentFixtures,
  waitForState,
} from './workflow-agent.test-support.ts';

useWorkflowAgentFixtures();

const alice = () => callContext({ user: 'alice' });

describe('starting a workflow with SendMessage', () => {
  test('starts the workflow with the concatenated text parts and names the task after it', async () => {
    const { agent, engine } = await createWorkflowAgentFixture({ inputMode: 'text' });
    const message = userMessage({
      parts: [textPart('Hello, '), dataPart({ x: 1 }), textPart('agent')],
    });

    const task = await startTask(agent, alice(), message);

    const state = await engine.get(task.id);
    expect(state?.type).toBe('agent-approval');
    expect(state?.input).toBe('Hello, agent');
    expect(task.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
  });

  test('starts the workflow with the first data part in data mode', async () => {
    const { agent, engine } = await createWorkflowAgentFixture({ inputMode: 'data' });
    const message = userMessage({
      parts: [textPart('ignored'), dataPart({ order: 42 }), dataPart({ order: 7 })],
    });

    const task = await startTask(agent, alice(), message);

    const state = await engine.get(task.id);
    expect(state?.input).toEqual({ order: 42 });
  });

  test('rejects a message without a part the input mode reads', async () => {
    const text = await createWorkflowAgentFixture({ inputMode: 'text' });
    const data = await createWorkflowAgentFixture({ inputMode: 'data' });

    expect(
      await rejectionOf(
        startTask(text.agent, alice(), userMessage({ parts: [dataPart({ x: 1 })] })),
      ),
    ).toBeInstanceOf(RequestMalformedError);
    expect(
      await rejectionOf(startTask(data.agent, alice(), userMessage({ parts: [textPart('x')] }))),
    ).toBeInstanceOf(RequestMalformedError);
  });

  test('uses the client contextId when supplied and the task identifier otherwise', async () => {
    const { agent } = await createWorkflowAgentFixture();

    const supplied = await startTask(agent, alice(), userMessage({ contextId: 'conversation-1' }));
    const minted = await startTask(agent, alice());

    expect(supplied.contextId).toBe('conversation-1');
    expect(minted.contextId).toBe(minted.id);
    expect(minted.history[0]?.taskId).toBe(minted.id);
  });

  test('returns the same task for a retried message and starts the workflow with the user and message identifier as its idempotency key', async () => {
    const { agent, engine } = await createWorkflowAgentFixture();
    const keys: unknown[] = [];
    const start = engine.start.bind(engine);
    engine.start = async (type: string, input: unknown, options?: { idempotencyKey?: string }) => {
      keys.push(options?.idempotencyKey);
      return start(type, input, options);
    };
    const message = userMessage({ messageId: 'message-1' });

    const first = await startTask(agent, alice(), message);
    const retried = await startTask(agent, alice(), message);

    expect(retried.id).toBe(first.id);
    expect(retried.history.filter((entry) => entry.role === Role.ROLE_USER)).toHaveLength(1);
    expect(keys).toEqual(['alice:message-1', 'alice:message-1']);
  });

  test('refuses a message whose idempotency key already started another agent’s workflow', async () => {
    const fixture = await createWorkflowAgentFixture();
    const echo = serveWorkflow(fixture.push, fixture.engine, {
      workflowType: echoWorkflow.name,
      namespace: 'echo-agent',
    });
    await startTask(echo.agent, alice(), userMessage({ messageId: 'shared' }));

    expect(
      await rejectionOf(startTask(fixture.agent, alice(), userMessage({ messageId: 'shared' }))),
    ).toBeInstanceOf(RequestMalformedError);
  });

  test('refuses a message whose idempotency key already started a task in another tenant', async () => {
    const { agent } = await createWorkflowAgentFixture();
    await startTask(
      agent,
      callContext({ user: 'alice', tenant: 'east' }),
      userMessage({ messageId: 'shared' }),
    );

    expect(
      await rejectionOf(
        startTask(
          agent,
          callContext({ user: 'alice', tenant: 'west' }),
          userMessage({ messageId: 'shared' }),
        ),
      ),
    ).toBeInstanceOf(RequestMalformedError);
  });

  test('rejects a message without a messageId', async () => {
    const { agent } = await createWorkflowAgentFixture();

    expect(
      await rejectionOf(startTask(agent, alice(), userMessage({ messageId: '' }))),
    ).toBeInstanceOf(RequestMalformedError);
  });

  test('returns at once with returnImmediately, before the workflow settles', async () => {
    const { agent } = await createWorkflowAgentFixture();

    const task = await agent.requestHandler.sendMessage(
      sendRequest(userMessage(), { returnImmediately: true }),
      alice(),
    );

    expect(task).toMatchObject({ status: { state: TaskState.TASK_STATE_SUBMITTED } });
  });

  test('applies configuration.historyLength to the returned task', async () => {
    const { agent } = await createWorkflowAgentFixture();

    const task = await agent.requestHandler.sendMessage(
      sendRequest(userMessage(), { historyLength: 1 }),
      alice(),
    );

    expect('history' in task && task.history.map((entry) => entry.role)).toEqual([Role.ROLE_AGENT]);
  });
});

describe('continuing a task with SendMessage', () => {
  test('delivers the message as the payload of the signal the workflow waits for', async () => {
    const { agent } = await createWorkflowAgentFixture();
    const task = await startTask(agent, alice());

    const continued = await startTask(
      agent,
      alice(),
      userMessage({ taskId: task.id, text: 'approved' }),
    );

    expect(continued.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(continued.artifacts).toHaveLength(1);
    expect(continued.artifacts[0]?.parts).toEqual([
      expect.objectContaining({
        content: { $case: 'data', value: { request: 'hello', input: 'approved' } },
      }),
    ]);
  });

  test('requires metadata.signalName to choose among several waits and delivers to the one it names', async () => {
    const { agent, engine } = await createWorkflowAgentFixture({
      workflowType: choiceWorkflow.name,
    });
    const task = await startTask(agent, alice());
    expect(task.status?.message?.metadata).toEqual({ signalNames: ['approve', 'reject'] });

    expect(
      await rejectionOf(startTask(agent, alice(), userMessage({ taskId: task.id, text: 'yes' }))),
    ).toBeInstanceOf(RequestMalformedError);
    expect(
      await rejectionOf(
        startTask(
          agent,
          alice(),
          userMessage({ taskId: task.id, text: 'yes', metadata: { signalName: 'other' } }),
        ),
      ),
    ).toBeInstanceOf(RequestMalformedError);

    const continued = await startTask(
      agent,
      alice(),
      userMessage({ taskId: task.id, text: 'nope', metadata: { signalName: 'reject' } }),
    );

    expect(continued.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const state = await engine.get(task.id);
    expect(state?.result).toEqual({ choice: 'reject', value: 'nope' });
  });

  test('rejects a continuation to a task that is not waiting for a signal', async () => {
    const { agent, engine } = await createWorkflowAgentFixture();
    const task = await startTask(agent, alice());
    await engine.suspend(task.id);
    await waitForState(agent, task.id, alice(), TaskState.TASK_STATE_WORKING);

    expect(
      await rejectionOf(startTask(agent, alice(), userMessage({ taskId: task.id, text: 'late' }))),
    ).toBeInstanceOf(RequestMalformedError);
  });

  test('rejects a continuation whose contextId differs from the task’s with -32602', async () => {
    const { agent, engine } = await createWorkflowAgentFixture();
    const task = await startTask(agent, alice(), userMessage({ contextId: 'conversation-1' }));
    const signal = engine.signal.bind(engine);
    let signalled = false;
    engine.signal = (async (...args: Parameters<typeof signal>) => {
      signalled = true;
      return signal(...args);
    }) as typeof engine.signal;

    const rejected = startTask(
      agent,
      alice(),
      userMessage({ taskId: task.id, contextId: 'conversation-2', text: 'x' }),
    );

    const error = await rejected.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RequestMalformedError);
    expect(JsonRpcTransportHandler.mapToJSONRPCError(error).code).toBe(-32602);
    expect(signalled).toBe(false);
  });

  for (const terminal of ['completed', 'failed', 'cancelled'] as const) {
    test(`rejects a continuation to a ${terminal} task with UnsupportedOperationError`, async () => {
      const { agent, engine } = await createWorkflowAgentFixture();
      const task = await startTask(agent, alice());
      if (terminal === 'completed')
        await startTask(agent, alice(), userMessage({ taskId: task.id }));
      if (terminal === 'cancelled') await engine.cancel(task.id);
      if (terminal === 'failed') await engine.timeout(task.id);
      const expected = {
        completed: TaskState.TASK_STATE_COMPLETED,
        failed: TaskState.TASK_STATE_FAILED,
        cancelled: TaskState.TASK_STATE_CANCELED,
      }[terminal];
      await waitForState(agent, task.id, alice(), expected);

      expect(
        await rejectionOf(
          startTask(agent, alice(), userMessage({ taskId: task.id, text: 'again' })),
        ),
      ).toBeInstanceOf(UnsupportedOperationError);
    });
  }

  test('reports a signal the engine refuses, and still delivers the next continuation', async () => {
    const { agent, engine } = await createWorkflowAgentFixture();
    const task = await startTask(agent, alice());
    const signal = engine.signal.bind(engine);
    engine.signal = async () => {
      throw new Error('signal refused');
    };

    expect(
      await throwingRejectionOf(
        startTask(agent, alice(), userMessage({ taskId: task.id, text: 'first' })),
      ),
    ).toThrow('signal refused');
    engine.signal = signal;
    const continued = await startTask(
      agent,
      alice(),
      userMessage({ taskId: task.id, text: 'second' }),
    );

    expect(continued.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(continued.history.filter((message) => message.role === Role.ROLE_USER)).toHaveLength(2);
  });

  test('records the message without a WORKING step when the workflow finishes before the delivery is recorded', async () => {
    const { agent, engine } = await createWorkflowAgentFixture();
    const task = await startTask(agent, alice());
    const signal = engine.signal.bind(engine);
    engine.signal = (async (id: string, name: string, payload?: unknown) => {
      await signal(id, name, payload);
      await waitForState(agent, id, alice(), TaskState.TASK_STATE_COMPLETED);
    }) as typeof engine.signal;

    const continued = await startTask(
      agent,
      alice(),
      userMessage({ taskId: task.id, text: 'fast' }),
    );

    expect(continued.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(continued.history.at(-1)?.parts[0]?.content).toEqual({ $case: 'text', value: 'fast' });
    expect(continued.history).toHaveLength(3);
  });

  test('rejects a continuation to a task the caller does not own as not found', async () => {
    const { agent } = await createWorkflowAgentFixture();
    const task = await startTask(agent, alice());

    expect(
      await rejectionOf(
        startTask(agent, callContext({ user: 'bob' }), userMessage({ taskId: task.id })),
      ),
    ).toBeInstanceOf(TaskNotFoundError);
  });
});

describe('payloadOf', () => {
  test('reads a data part’s null value as null', () => {
    expect(payloadOf(userMessage({ parts: [dataPart(undefined)] }), 'data')).toBeNull();
  });
});
