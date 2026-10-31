/**
 * What a person does on a run's page: cancel it after a confirmation, and decide what it is
 * waiting on, through `/runs/:run` and the route outlet, over a Bureau that answers from a table.
 */
import { HttpClient } from '@lostgradient/weft';
import { QueryClient } from '@tanstack/svelte-query';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { REVIEWS_COPY, TASK_COPY } from '../../../app/copy.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import {
  humanWaitFixture,
  taskFixture,
  toolApprovalFixture,
} from '../../../lib/bureau-fixtures.test-support.ts';
import { StubFault } from '../../../lib/bureau-stub.test-support.ts';
import type { TaskView } from '../../../lib/bureau-tasks.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorld,
  type BureauWorldStub,
} from '../../../lib/bureau-world.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../../../lib/scopes.svelte.ts';
import { landAt } from '../../chat/pages.test-support.ts';
import RunWaitingHarness from './run-waiting.test-harness.svelte';

let stub: BureauWorldStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

function open(task: TaskView, world: Partial<BureauWorld> = {}) {
  stub = installBureauWorld(emptyBureauWorld({ tasks: [task], ...world }));
  stub.on('bureau.goals.list', () => ({ goals: [], nextOffset: null }));
  stub.on('bureau.contexts.list', () => ({ contexts: [], nextOffset: null }));
  stub.on('bureau.agents.list', () => ({ agents: [] }));
  landAt(`/runs/${task.id}`);
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

const WORKING = taskFixture({ id: 'run-1', agentName: 'echo', status: 'working' });

describe('cancelling a run', () => {
  test('asks first, and keeping the run sends nothing', async () => {
    const view = open(WORKING);
    await fireEvent.click(await view.findByRole('button', { name: TASK_COPY.cancelAction }));

    const dialog = await view.findByRole('dialog', { name: TASK_COPY.cancelConfirm.title });
    await fireEvent.click(
      within(dialog).getByRole('button', { name: TASK_COPY.cancelConfirm.keep }),
    );

    await waitFor(() =>
      expect(
        view.queryByRole('dialog', { name: TASK_COPY.cancelConfirm.title })?.outerHTML ?? null,
      ).toBeNull(),
    );
    expect(stub?.callsTo('bureau.tasks.cancel')).toEqual([]);
  });

  test('confirming asks the Bureau to stop the run and says where the cancellation stands', async () => {
    const view = open(WORKING);
    stub?.on('bureau.tasks.cancel', () => ({ taskId: 'run-1', receipt: 'cancel-requested' }));
    await fireEvent.click(await view.findByRole('button', { name: TASK_COPY.cancelAction }));

    const dialog = await view.findByRole('dialog', { name: TASK_COPY.cancelConfirm.title });
    await fireEvent.click(within(dialog).getByRole('button', { name: TASK_COPY.cancelAction }));

    await waitFor(() =>
      expect(view.container.querySelector('[data-cleanup="cancel-requested"]')?.textContent).toBe(
        TASK_COPY.cancel['cancel-requested'],
      ),
    );
    expect(stub?.callsTo('bureau.tasks.cancel').map((call) => call.params)).toEqual([
      { taskId: 'run-1' },
    ]);
  });

  test('a cancel the Bureau answers with the task shows that task’s own cleanup', async () => {
    const view = open(WORKING);
    stub?.on('bureau.tasks.cancel', () => {
      // From now on the task reports the cleanup, as the Bureau does once it has begun.
      stub?.on('bureau.tasks.get', () => ({ ...WORKING, cleanup: 'cleanup-pending' }));
      return {
        taskId: 'run-1',
        receipt: 'cleanup-pending',
        task: { ...WORKING, cleanup: 'cleanup-pending' },
      };
    });
    await fireEvent.click(await view.findByRole('button', { name: TASK_COPY.cancelAction }));
    const dialog = await view.findByRole('dialog', { name: TASK_COPY.cancelConfirm.title });
    await fireEvent.click(within(dialog).getByRole('button', { name: TASK_COPY.cancelAction }));

    await waitFor(() =>
      expect(view.container.querySelector('[data-cleanup="cleanup-pending"]')?.textContent).toBe(
        TASK_COPY.cancel['cleanup-pending'],
      ),
    );
    // Once cleanup is under way there is nothing left to cancel.
    expect(view.queryByRole('button', { name: TASK_COPY.cancelAction })).toBeNull();
  });

  test('a cancel the Bureau refuses says so, and the run can be cancelled again', async () => {
    const view = open(WORKING);
    stub?.on('bureau.tasks.cancel', () => {
      throw new StubFault('EngineFailure', 500, 'The Bureau broke.');
    });
    await fireEvent.click(await view.findByRole('button', { name: TASK_COPY.cancelAction }));
    const dialog = await view.findByRole('dialog', { name: TASK_COPY.cancelConfirm.title });
    await fireEvent.click(within(dialog).getByRole('button', { name: TASK_COPY.cancelAction }));

    await waitFor(() => expect(view.container.textContent).toContain(TASK_COPY.cancelFailed));
    expect(view.getByRole('button', { name: TASK_COPY.cancelAction })).not.toBeNull();
  });

  test.each([
    ['an attempt of a goal', { kind: 'goal', goalRunId: 'goal-1', attemptId: 'a' }],
    ['a step of a workflow', { kind: 'parent', parentRunId: 'wf-1' }],
  ])('%s offers no cancel, because the goal or the workflow stops it', async (_name, origin) => {
    const view = open(taskFixture({ id: 'run-1', agentName: 'echo', status: 'working', origin }));

    await view.findByRole('heading', { level: 1, name: 'echo' });
    expect(view.queryByRole('button', { name: TASK_COPY.cancelAction })).toBeNull();
  });

  test.each([
    ['owned-by-goal', TASK_COPY.cancelOwned['owned-by-goal']],
    ['owned-by-workflow', TASK_COPY.cancelOwned['owned-by-workflow']],
  ] as const)(
    'a cancel refused as %s says who owns the run, not that it had finished',
    async (reason, words) => {
      const view = open(WORKING);
      stub?.on('bureau.tasks.cancel', () => ({ taskId: 'run-1', receipt: 'rejected', reason }));
      await fireEvent.click(await view.findByRole('button', { name: TASK_COPY.cancelAction }));
      const dialog = await view.findByRole('dialog', { name: TASK_COPY.cancelConfirm.title });
      await fireEvent.click(within(dialog).getByRole('button', { name: TASK_COPY.cancelAction }));

      await waitFor(() =>
        expect(view.container.querySelector('[data-cleanup="rejected"]')?.textContent?.trim()).toBe(
          words,
        ),
      );
    },
  );

  test('a finished run offers no cancel', async () => {
    const view = open(taskFixture({ id: 'run-1', agentName: 'echo', status: 'completed' }));

    await view.findByRole('heading', { level: 1, name: 'echo' });
    expect(view.queryByRole('button', { name: TASK_COPY.cancelAction })).toBeNull();
  });
});

describe('what a run is waiting on', () => {
  const waitingOn = (kind: 'human-wait' | 'tool-approval', reviewId: string) =>
    taskFixture({
      id: 'run-1',
      agentName: 'echo',
      status: 'input-required',
      openWaits:
        kind === 'human-wait'
          ? [{ kind, reviewId, signalName: 'environment' }]
          : [{ kind, reviewId, callId: 'call-1' }],
    });

  test('a question is answered with text, sent to the run with the wait’s signal', async () => {
    const view = open(waitingOn('human-wait', 'human-wait:run-1:environment:0'), {
      reviews: [humanWaitFixture({ id: 'human-wait:run-1:environment:0', runId: 'run-1' })],
    });
    stub?.on('bureau.tasks.respond', (params) => ({
      taskId: 'run-1',
      messageId: params['messageId'],
      reviewId: 'human-wait:run-1:environment:0',
      kind: 'human-wait',
      decision: 'approve',
      receipt: 'applied',
    }));

    expect(await view.findByText('Which environment should the release go to?')).not.toBeNull();
    // The question is answered where it is asked, at the top of the page, with the chat's control.
    const send = view.getByRole('button', { name: /^Send$/ });
    expect(send.hasAttribute('disabled')).toBe(true);
    await fireEvent.input(view.getByLabelText('Your answer'), { target: { value: ' staging ' } });
    await fireEvent.click(send);

    await waitFor(() => expect(stub?.callsTo('bureau.tasks.respond')).toHaveLength(1));
    expect(stub?.callsTo('bureau.tasks.respond')[0]?.params).toMatchObject({
      taskId: 'run-1',
      answer: 'staging',
      signalName: 'environment',
    });
    // The answer is read back masked as the chat reads it, for as long as the page is open.
    expect(await view.findByText('You answered')).not.toBeNull();
    expect(view.container.querySelector('[data-question-answer]')?.textContent).toBe('staging');
  });

  test('an answered question keeps its row after the task stops listing the wait', async () => {
    const reviewId = 'human-wait:run-1:environment:0';
    const task = waitingOn('human-wait', reviewId);
    const view = open(task, { reviews: [humanWaitFixture({ id: reviewId, runId: 'run-1' })] });
    stub?.on('bureau.tasks.respond', (params) => {
      // The next read of the task no longer lists the wait.
      stub?.on('bureau.tasks.get', () => ({ ...task, openWaits: [], status: 'working' }));
      return {
        taskId: 'run-1',
        messageId: params['messageId'],
        reviewId,
        kind: 'human-wait',
        decision: 'approve',
        receipt: 'applied',
      };
    });

    await view.findByText('Which environment should the release go to?');
    await fireEvent.input(view.getByLabelText('Your answer'), { target: { value: 'staging' } });
    await fireEvent.click(view.getByRole('button', { name: /^Send$/ }));

    await waitFor(() => expect(stub?.callsTo('bureau.tasks.get').length).toBeGreaterThan(1));
    await waitFor(() =>
      expect(view.container.querySelector('[data-section="waiting"]')).not.toBeNull(),
    );
    expect(view.container.querySelector('[data-question-answer]')?.textContent).toBe('staging');
  });

  test('a task read that lands before the answer is taken keeps the row, and then says what was answered', async () => {
    const reviewId = 'human-wait:run-1:environment:0';
    const task = waitingOn('human-wait', reviewId);
    stub = installBureauWorld(
      emptyBureauWorld({
        tasks: [task],
        reviews: [humanWaitFixture({ id: reviewId, runId: 'run-1' })],
      }),
    );
    let release: () => void = () => undefined;
    const taken = new Promise<void>((resolve) => (release = resolve));
    stub.on('bureau.tasks.respond', async (params) => {
      await taken;
      return {
        taskId: 'run-1',
        messageId: params['messageId'],
        reviewId,
        kind: 'human-wait',
        decision: 'approve',
        receipt: 'applied',
      };
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(RunWaitingHarness, { props: { task, queryClient } });

    await view.findByText('Which environment should the release go to?');
    await fireEvent.input(view.getByLabelText('Your answer'), { target: { value: 'staging' } });
    await fireEvent.click(view.getByRole('button', { name: /^Send$/ }));
    await waitFor(() => expect(stub?.callsTo('bureau.tasks.respond')).toHaveLength(1));
    // The task is read again, and no longer lists the wait, before the answer is taken.
    await view.rerender({ task: { ...task, openWaits: [], status: 'completed' } });
    // The review is read again too, and is closed.
    stub.on('bureau.reviews.get', () => humanWaitFixture({ id: reviewId, status: 'approved' }));
    await queryClient.invalidateQueries({ queryKey: ['bureau-reviews'] });
    expect(await view.findByText(TASK_COPY.sendingAnswer)).not.toBeNull();
    expect(view.queryByText(TASK_COPY.waitGone)).toBeNull();
    release();

    await waitFor(() =>
      expect(view.container.querySelector('[data-question-answer]')?.textContent).toBe('staging'),
    );
    expect(view.queryByText(TASK_COPY.waitGone)).toBeNull();
    // Nothing is waiting on the person any more, so the section does not say it is.
    expect(view.queryByText(TASK_COPY.waitsHeading)).toBeNull();
    expect(view.getByText(TASK_COPY.waitsAnsweredHeading)).not.toBeNull();
  });

  test('a yes or no is sent as JSON text, and the row reads the answer given', async () => {
    const reviewId = 'human-wait:run-1:environment:0';
    const view = open(waitingOn('human-wait', reviewId), {
      reviews: [
        humanWaitFixture({ id: reviewId, runId: 'run-1', inputSchema: { type: 'boolean' } }),
      ],
    });
    stub?.on('bureau.tasks.respond', (params) => ({
      taskId: 'run-1',
      messageId: params['messageId'],
      reviewId,
      kind: 'human-wait',
      decision: 'approve',
      receipt: 'applied',
    }));

    await view.findByText('Which environment should the release go to?');
    await fireEvent.click(view.getByRole('button', { name: 'Yes' }));

    await waitFor(() => expect(stub?.callsTo('bureau.tasks.respond')).toHaveLength(1));
    expect(stub?.callsTo('bureau.tasks.respond')[0]?.params).toMatchObject({ answer: 'true' });
    expect(await view.findByText('Yes', { selector: '[data-question-answer]' })).not.toBeNull();
  });

  test('a pick of several is sent as a JSON array', async () => {
    const reviewId = 'human-wait:run-1:environment:0';
    const view = open(waitingOn('human-wait', reviewId), {
      reviews: [
        humanWaitFixture({
          id: reviewId,
          runId: 'run-1',
          inputSchema: {
            type: 'array',
            uniqueItems: true,
            minItems: 1,
            items: { enum: ['staging', 'production'] },
          },
        }),
      ],
    });
    stub?.on('bureau.tasks.respond', (params) => ({
      taskId: 'run-1',
      messageId: params['messageId'],
      reviewId,
      kind: 'human-wait',
      decision: 'approve',
      receipt: 'applied',
    }));

    await view.findByText('Which environment should the release go to?');
    await fireEvent.click(view.getByLabelText('staging'));
    await fireEvent.click(view.getByLabelText('production'));
    await fireEvent.click(view.getByRole('button', { name: /^Send$/ }));

    await waitFor(() => expect(stub?.callsTo('bureau.tasks.respond')).toHaveLength(1));
    expect(stub?.callsTo('bureau.tasks.respond')[0]?.params).toMatchObject({
      answer: '["staging","production"]',
    });
    expect(await view.findByText(/staging/, { selector: '[data-question-answer]' })).not.toBeNull();
  });

  test('a secret question is a masked field, and what was answered is never shown', async () => {
    const reviewId = 'human-wait:run-1:environment:0';
    const view = open(waitingOn('human-wait', reviewId), {
      reviews: [
        humanWaitFixture({
          id: reviewId,
          runId: 'run-1',
          inputSchema: { type: 'string', writeOnly: true, 'x-secret': true },
        }),
      ],
    });
    stub?.on('bureau.tasks.respond', (params) => ({
      taskId: 'run-1',
      messageId: params['messageId'],
      reviewId,
      kind: 'human-wait',
      decision: 'approve',
      receipt: 'applied',
    }));

    await view.findByText('Which environment should the release go to?');
    const field = view.getByLabelText('Your answer');
    expect(field.getAttribute('type')).toBe('password');
    await fireEvent.input(field, { target: { value: 'hunter2' } });
    await fireEvent.click(view.getByRole('button', { name: /^Send$/ }));

    await waitFor(() => expect(stub?.callsTo('bureau.tasks.respond')).toHaveLength(1));
    expect(await view.findByText('You answered')).not.toBeNull();
    expect(view.container.querySelector('[data-question-answer]')?.textContent).toBe(
      'a secret (not shown)',
    );
    expect(view.container.textContent).not.toContain('hunter2');
  });

  test('an answer the Bureau refuses for its content is told on the field, not as a failure', async () => {
    const reviewId = 'human-wait:run-1:environment:0';
    const view = open(waitingOn('human-wait', reviewId), {
      reviews: [
        humanWaitFixture({
          id: reviewId,
          runId: 'run-1',
          inputSchema: { type: 'string', pattern: '^[a-z]+$' },
        }),
      ],
    });
    stub?.on('bureau.tasks.respond', () => {
      throw new StubFault('InvalidParams', 400, 'The answer is not valid.', {
        issues: [
          {
            path: ['answer'],
            message: 'The answer must match the pattern ^[a-z]+$',
            code: 'pattern',
          },
        ],
      });
    });

    await view.findByText('Which environment should the release go to?');
    await fireEvent.input(view.getByLabelText('Your answer'), { target: { value: 'Staging 1' } });
    await fireEvent.click(view.getByRole('button', { name: /^Send$/ }));

    expect(await view.findByText(/must match the pattern/)).not.toBeNull();
    expect(view.container.querySelector('[data-question-answer]')).toBeNull();
  });

  test('an answer the Bureau refuses is told next to the field', async () => {
    const view = open(waitingOn('human-wait', 'human-wait:run-1:environment:0'), {
      reviews: [humanWaitFixture({ id: 'human-wait:run-1:environment:0', runId: 'run-1' })],
    });
    stub?.on('bureau.tasks.respond', () => {
      throw new StubFault('EngineFailure', 500, 'The Bureau broke.');
    });

    await view.findByText('Which environment should the release go to?');
    await fireEvent.input(view.getByLabelText('Your answer'), { target: { value: 'staging' } });
    await fireEvent.click(view.getByRole('button', { name: /^Send$/ }));

    expect(await view.findByText(/The Bureau broke/)).not.toBeNull();
    // The question stays open to answer again.
    expect(view.getByLabelText('Your answer')).not.toBeNull();
  });

  test('a tool approval is approved or denied where the run is shown', async () => {
    const approval = toolApprovalFixture({ id: 'approval:run-1:call-1', runId: 'run-1' });
    const view = open(waitingOn('tool-approval', approval.id), { reviews: [approval] });
    let decisions: unknown[] = [];
    stub?.on('bureau.reviews.resolve', (params) => {
      decisions = [...decisions, params];
      return {
        id: approval.id,
        kind: 'tool-approval',
        decision: params['decision'],
        receipt: 'applied',
      };
    });

    await view.findByRole('button', { name: 'Approve' });
    await fireEvent.click(view.getByRole('button', { name: 'Deny' }));

    await waitFor(() => expect(decisions).toHaveLength(1));
    expect(decisions[0]).toMatchObject({ id: approval.id, decision: 'deny' });
  });

  test('a decision the Bureau refuses is told, and the approval stays', async () => {
    const approval = toolApprovalFixture({ id: 'approval:run-1:call-1', runId: 'run-1' });
    const view = open(waitingOn('tool-approval', approval.id), { reviews: [approval] });
    stub?.on('bureau.reviews.resolve', () => {
      throw new StubFault('EngineFailure', 500, 'The Bureau broke.');
    });

    await fireEvent.click(await view.findByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(view.container.querySelector('.ib-run-wait__note')).not.toBeNull());
    expect(view.getByRole('button', { name: 'Approve' })).not.toBeNull();
  });

  test('a decision sends the round of the approval shown, and one that changed is not decided (COR-1714)', async () => {
    const approval = toolApprovalFixture({ id: 'approval:run-1:call-1', runId: 'run-1', round: 1 });
    const view = open(waitingOn('tool-approval', approval.id), { reviews: [approval] });
    stub?.on('bureau.reviews.resolve', () => {
      throw new StubFault('Conflict', 409, 'The review moved on.', {
        reason: 'REVIEW_ROUND_CHANGED: now at round 2',
      });
    });
    const reads = stub?.callsTo('bureau.reviews.get').length ?? 0;

    await fireEvent.click(await view.findByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(stub?.callsTo('bureau.reviews.resolve')).toHaveLength(1));
    expect(stub?.callsTo('bureau.reviews.resolve')[0]?.params).toMatchObject({
      id: approval.id,
      decision: 'approve',
      round: 1,
    });
    await waitFor(() =>
      expect(view.container.querySelector('.ib-run-wait__note')?.textContent).toContain(
        REVIEWS_COPY.roundChanged.title,
      ),
    );
    expect(view.container.textContent).toContain(REVIEWS_COPY.roundChanged.message);
    await waitFor(() => expect(stub?.callsTo('bureau.reviews.get').length).toBeGreaterThan(reads));
  });

  test('a review that is no longer pending, or that the Bureau lost, is not a wait to answer', async () => {
    const resolved = open(waitingOn('human-wait', 'human-wait:run-1:environment:0'), {
      reviews: [
        humanWaitFixture({
          id: 'human-wait:run-1:environment:0',
          runId: 'run-1',
          status: 'approved',
        }),
      ],
    });
    expect(await resolved.findByText(TASK_COPY.waitGone)).not.toBeNull();
    cleanup();
    stub?.restore();

    const lost = open(waitingOn('human-wait', 'human-wait:run-1:environment:0'));
    expect(await lost.findByText(TASK_COPY.waitGone)).not.toBeNull();
  });

  test('a review the Bureau cannot read says the wait could not be read', async () => {
    const view = open(waitingOn('human-wait', 'human-wait:run-1:environment:0'));
    stub?.on('bureau.reviews.get', () => {
      throw new StubFault('EngineFailure', 500, 'The Bureau broke.');
    });

    expect(await view.findByText(TASK_COPY.waitLoadFailed)).not.toBeNull();
  });
});
