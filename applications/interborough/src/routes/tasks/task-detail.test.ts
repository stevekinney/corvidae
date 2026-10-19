/**
 * `/tasks/:id`: one task from `bureau.tasks.get`, its answer from `bureau.tasks.events`, the wait it
 * is held on, and cancelling it. The management plane's task view carries no message text, so the
 * page shows no message history.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';

import { TASK_COPY } from '../../app/copy.ts';
import {
  humanWaitFixture,
  taskFixture,
  toolApprovalFixture,
} from '../../lib/bureau-fixtures.test-support.ts';
import { taskCancelReceiptSchema, type TaskView } from '../../lib/bureau-tasks.ts';
import { StubFault } from '../../lib/bureau-stub.test-support.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  snapshotElement,
  statusElement,
  type BureauWorld,
  type BureauWorldStub,
} from '../../lib/bureau-world.test-support.ts';
import { settle } from '../../lib/fake-timers.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import Harness from './tasks-area.test-harness.svelte';

let stub: BureauWorldStub | undefined;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
  jest.useRealTimers();
});

function open(task: TaskView, world: Partial<BureauWorld> = {}) {
  stub = installBureauWorld(emptyBureauWorld({ tasks: [task], ...world }));
  router.navigate(`/tasks/${task.id}`, { replace: true });
  return render(Harness, {
    props: { client: new HttpClient({ baseUrl: 'http://localhost/api' }), scopes: AUTHORIZATION_SCOPES },
  } as never);
}

const WAITING_FOR_ANSWER = taskFixture({
  id: 'run-2',
  agentName: 'request-human-input',
  status: 'input-required',
  openWaits: [{ kind: 'human-wait', reviewId: humanWaitFixture().id, signalName: 'environment' }],
});

describe('what the page shows of a task', () => {
  test('is its status, its agent, its session, and the status message the Bureau reports', async () => {
    const { container, findByRole } = open(
      taskFixture({
        agentName: 'assistant',
        status: 'failed',
        statusMessage: 'The model refused.',
        finishReason: 'error',
      }),
    );
    await findByRole('heading', { level: 1, name: 'assistant task' });
    expect(container.textContent).toContain('Failed');
    expect(container.textContent).toContain('The model refused.');
    expect(container.querySelector('a[href="/chat/session-1"]')).not.toBeNull();
    expect(container.querySelector('[data-view="tasks"]')?.getAttribute('data-state')).toBe(
      'ready',
    );
  });

  test('has no message history, and asks the Bureau for none', async () => {
    const { container, findByRole } = open(taskFixture());
    await findByRole('heading', { level: 1 });
    expect(container.textContent?.toLowerCase()).not.toContain('history');
    expect(container.textContent?.toLowerCase()).not.toContain('messages');
    expect(stub?.calls.map((call) => call.method).every((m) => m === 'bureau.tasks.get')).toBe(
      true,
    );
  });

  test('shows the answer from the stream, because the task view carries none', async () => {
    const { findByText, container } = open(taskFixture({ id: 'run-1', status: 'completed' }));
    await waitFor(() => expect(stub?.streams.length).toBe(1));
    expect(stub?.streams[0]?.taskId).toBe('run-1');
    stub?.streams[0]?.push(snapshotElement('run-1', 'completed'));
    stub?.streams[0]?.push(
      statusElement('run-1', '21', 'completed', {
        artifact: { artifactId: 'run-1:result', text: 'The release goes to staging.', truncated: false },
      }),
    );
    await findByText('The release goes to staging.');
    expect(container.querySelector('h2')?.textContent).toContain('Answer');
  });

  test('says when the answer was cut short', async () => {
    const { findByText } = open(taskFixture({ id: 'run-1', status: 'completed' }));
    await waitFor(() => expect(stub?.streams.length).toBe(1));
    stub?.streams[0]?.push(
      statusElement('run-1', '21', 'completed', {
        artifact: { artifactId: 'run-1:result', text: 'Long answer', truncated: true },
      }),
    );
    await findByText(TASK_COPY.answerTruncated);
  });

  test('reads the task again when the stream reports a change, so the status stays current', async () => {
    const { findByText, container } = open(taskFixture({ id: 'run-1', status: 'working' }));
    await waitFor(() => expect(stub?.streams.length).toBe(1));
    expect(stub?.callsTo('bureau.tasks.get').length).toBeGreaterThanOrEqual(1);
    const before = stub?.callsTo('bureau.tasks.get').length ?? 0;
    stub?.on('bureau.tasks.get', () => taskFixture({ id: 'run-1', status: 'completed' }));
    stub?.streams[0]?.push(statusElement('run-1', '9', 'completed'));
    await findByText('Completed');
    expect(stub?.callsTo('bureau.tasks.get').length).toBeGreaterThan(before);
    expect(container.querySelector('dl')?.textContent).toContain('Completed');
  });

  test('says nothing is following the task when the Bureau keeps no history to follow', async () => {
    stub?.restore();
    stub = installBureauWorld(emptyBureauWorld({ tasks: [taskFixture({ id: 'run-1' })] }));
    stub.refuseStreams(501);
    router.navigate('/tasks/run-1', { replace: true });
    const { findByText } = render(Harness, {
      props: { client: new HttpClient({ baseUrl: 'http://localhost/api' }), scopes: AUTHORIZATION_SCOPES },
    } as never);
    await findByText(TASK_COPY.followUnavailable);
  });
});

describe('a task that waits on a person', () => {
  test('with an open human wait shows the question the wait asks', async () => {
    const { findByText } = open(WAITING_FOR_ANSWER, { reviews: [humanWaitFixture()] });
    await findByText('Which environment should the release go to?');
    expect(stub?.callsTo('bureau.reviews.get').at(-1)?.params).toEqual({ id: humanWaitFixture().id });
  });

  test('with an open tool approval shows the reason and the message of that review', async () => {
    const approval = toolApprovalFixture({ runId: 'run-3' });
    const task = taskFixture({
      id: 'run-3',
      status: 'input-required',
      openWaits: [{ kind: 'tool-approval', reviewId: approval.id, callId: approval.approval.callId }],
    });
    const { findByText, container } = open(task, { reviews: [approval] });
    await findByText('Tool "issue-refund" requires approval.');
    await findByText('Refund order-1001?');
    expect(container.querySelector('a[href="/reviews"]')).not.toBeNull();
    expect(stub?.callsTo('bureau.reviews.get').at(-1)?.params).toEqual({ id: approval.id });
  });

  test('says when the wait it names is no longer there', async () => {
    const { findByText } = open(WAITING_FOR_ANSWER, { reviews: [] });
    await findByText(TASK_COPY.waitGone);
  });

  test('answers a human wait with one text field, sent to the wait under its own message identifier', async () => {
    const { findByLabelText, getByRole } = open(WAITING_FOR_ANSWER, { reviews: [humanWaitFixture()] });
    stub?.on('bureau.tasks.respond', () => ({
      taskId: 'run-2',
      messageId: 'm',
      reviewId: humanWaitFixture().id,
      kind: 'human-wait',
      decision: 'approve',
      receipt: 'applied',
    }));
    const field = await findByLabelText('Your answer');
    await fireEvent.input(field, { target: { value: 'staging' } });
    await fireEvent.click(getByRole('button', { name: 'Send answer' }));

    await waitFor(() => expect(stub?.callsTo('bureau.tasks.respond').length).toBe(1));
    expect(stub?.callsTo('bureau.tasks.respond')[0]?.params).toMatchObject({
      taskId: 'run-2',
      answer: 'staging',
      signalName: 'environment',
    });
    expect(String(stub?.callsTo('bureau.tasks.respond')[0]?.params['messageId']).length).toBeGreaterThan(8);
  });

  test('reads the task again once the answer is accepted, so the task shows it continued', async () => {
    const { findByLabelText, getByRole, findByText } = open(WAITING_FOR_ANSWER, {
      reviews: [humanWaitFixture()],
    });
    stub?.on('bureau.tasks.respond', () => {
      stub?.on('bureau.tasks.get', () => taskFixture({ id: 'run-2', status: 'completed' }));
      return {
        taskId: 'run-2',
        messageId: 'm',
        reviewId: humanWaitFixture().id,
        kind: 'human-wait',
        decision: 'approve',
        receipt: 'applied',
      };
    });
    await fireEvent.input(await findByLabelText('Your answer'), { target: { value: 'staging' } });
    await fireEvent.click(getByRole('button', { name: 'Send answer' }));
    await findByText('Completed');
  });

  test('cannot send an empty answer', async () => {
    const { findByLabelText, getByRole } = open(WAITING_FOR_ANSWER, { reviews: [humanWaitFixture()] });
    await findByLabelText('Your answer');
    expect(getByRole('button', { name: 'Send answer' }).hasAttribute('disabled')).toBe(true);
  });

  test('keeps what was typed and says why when the Bureau refuses the answer', async () => {
    const { findByLabelText, getByRole, findByText } = open(WAITING_FOR_ANSWER, {
      reviews: [humanWaitFixture()],
    });
    stub?.on('bureau.tasks.respond', () => {
      throw new StubFault('Conflict', 409, 'That wait was already answered.', {
        reason: 'That wait was already answered.',
      });
    });
    const field = (await findByLabelText('Your answer')) as HTMLTextAreaElement;
    await fireEvent.input(field, { target: { value: 'staging' } });
    await fireEvent.click(getByRole('button', { name: 'Send answer' }));
    await findByText(TASK_COPY.respondFailed);
    expect(field.value).toBe('staging');
  });
});

describe('cancelling a task', () => {
  test('is offered while the task is going, and not once it is over', async () => {
    const going = open(taskFixture({ status: 'working' }));
    await going.findByRole('button', { name: 'Cancel task' });
    going.unmount();
    stub?.restore();

    const over = open(taskFixture({ status: 'completed' }));
    await over.findByRole('heading', { level: 1 });
    expect(over.queryByRole('button', { name: 'Cancel task' })).toBeNull();
  });

  for (const receipt of taskCancelReceiptSchema.options) {
    test(`says "${TASK_COPY.cancel[receipt]}" for the receipt ${receipt}`, async () => {
      const { findByRole, findByText } = open(taskFixture({ status: 'working' }));
      stub?.on('bureau.tasks.cancel', () => ({
        taskId: 'run-1',
        receipt,
        task: taskFixture({
          status: receipt === 'rejected' ? 'completed' : 'canceled',
          cleanup: receipt === 'rejected' ? null : receipt,
        }),
      }));
      await fireEvent.click(await findByRole('button', { name: 'Cancel task' }));
      await findByText(TASK_COPY.cancel[receipt]);
      expect(stub?.callsTo('bureau.tasks.cancel')[0]?.params).toEqual({ taskId: 'run-1' });
    });
  }

  test('has a label of its own for every receipt, and no two the same', () => {
    const labels = taskCancelReceiptSchema.options.map((receipt) => TASK_COPY.cancel[receipt]);
    expect(labels).toHaveLength(8);
    expect(new Set(labels).size).toBe(8);
  });
});

describe('after a cancellation that is not finished', () => {
  test('reads the task again until its cleanup is neither requested nor pending', async () => {
    const { findByRole, container } = open(taskFixture({ status: 'working' }));
    const cancelButton = await findByRole('button', { name: 'Cancel task' });
    // The page is up under real timers. The poll starts when the cancel is answered, so it is the
    // fake clock's.
    jest.useFakeTimers();
    stub?.on('bureau.tasks.cancel', () => ({
      taskId: 'run-1',
      receipt: 'cancel-requested',
      task: taskFixture({ status: 'working', cleanup: 'cancel-requested' }),
    }));
    const answers: TaskView[] = [
      taskFixture({ status: 'working', cleanup: 'cleanup-pending' }),
      taskFixture({ status: 'canceled', cleanup: 'cleaned-up' }),
    ];
    stub?.on('bureau.tasks.get', () => answers.shift() ?? taskFixture({ status: 'canceled', cleanup: 'cleaned-up' }));

    await fireEvent.click(cancelButton);
    await settle();
    expect(container.textContent).toContain(TASK_COPY.cancel['cancel-requested']);
    const readsAfterCancel = stub?.callsTo('bureau.tasks.get').length ?? 0;

    jest.advanceTimersByTime(TASK_COPY.cleanupPollMilliseconds);
    await settle();
    expect(container.textContent).toContain(TASK_COPY.cancel['cleanup-pending']);

    jest.advanceTimersByTime(TASK_COPY.cleanupPollMilliseconds);
    await settle();
    expect(container.textContent).toContain(TASK_COPY.cancel['cleaned-up']);
    const readsWhenDone = stub?.callsTo('bureau.tasks.get').length ?? 0;
    expect(readsWhenDone).toBeGreaterThan(readsAfterCancel);

    // Cleaned up is the end: the page reads the task no more.
    jest.advanceTimersByTime(TASK_COPY.cleanupPollMilliseconds * 5);
    await settle();
    expect(stub?.callsTo('bureau.tasks.get').length).toBe(readsWhenDone);
  });
});
