/**
 * A run's tool calls read the chat thread the run belongs to, and read it again when the run's
 * stream reports something and when the set of waits the run has changes.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { quietFor } from '@lostgradient/testing/wait-until';
import { RETRY_LABEL, TASK_COPY } from '../../../app/copy.ts';
import {
  humanWaitFixture,
  taskFixture,
  toolApprovalFixture,
} from '../../../lib/bureau-fixtures.test-support.ts';
import { createQueryClient } from '../../../lib/query.ts';
import { bureau, landAt } from '../../chat/pages.test-support.ts';
import QueryPage from '../../chat/query-page.test-harness.svelte';
import RunToolCalls from './run-tool-calls.svelte';
import Harness from './run-tool-calls.test-harness.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

/** Serves the chat thread, counting how many times it is read. */
function serve() {
  const reads = { thread: 0 };
  restore = bureau({ 'bureau.reviews.get': () => humanWaitFixture({ id: 'review-1' }) }, (url) => {
    if (!url.endsWith('/messages')) return undefined;
    reads.thread += 1;
    return Response.json({
      threadId: 'session-1',
      messages: [
        {
          id: 'run-1:step:0',
          role: 'assistant',
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'lookup-order', arguments: '{}' } },
          ],
        },
      ],
    });
  }).restore;
  return reads;
}

const WORKING = taskFixture({ id: 'run-1', contextId: 'session-1', status: 'working' });

describe('a run’s tool calls', () => {
  test('are read from the thread, and read again when the run’s stream reports something', async () => {
    const reads = serve();
    landAt('/runs/run-1');
    const view = render(Harness, { props: { task: WORKING } } as never);
    await waitFor(() => expect(view.container.textContent).toContain('lookup-order'));
    expect(reads.thread).toBe(1);

    // A call that starts or ends inside one status changes nothing the task's own fields show.
    await fireEvent.click(view.getByRole('button', { name: 'Report an event' }));
    await fireEvent.click(view.getByRole('button', { name: 'Report an event' }));

    // One read for a burst of elements, and the calls stay on screen while it is made.
    await waitFor(() => expect(reads.thread).toBe(2));
    await quietFor(400);
    expect(reads.thread).toBe(2);
    expect(view.container.textContent).toContain('lookup-order');
  });

  test('are keyed by the reviews of the waits, so a different wait of the same number is a different read', async () => {
    serve();
    landAt('/runs/run-1');
    const client = createQueryClient();
    const waiting = (reviewId: string) =>
      taskFixture({
        id: 'run-1',
        contextId: 'session-1',
        status: 'input-required',
        openWaits: [{ kind: 'human-wait', reviewId, signalName: 'environment' }],
      });
    const keys = () =>
      client
        .getQueryCache()
        .findAll({ queryKey: ['bureau-tasks', 'thread'] })
        .map((query) => query.queryKey);
    const view = render(QueryPage, {
      props: { page: RunToolCalls, pageProps: { task: waiting('review-1'), events: 0 }, client },
    } as never);
    await waitFor(() =>
      expect(keys()).toContainEqual([
        'bureau-tasks',
        'thread',
        'session-1',
        'input-required',
        ['review-1'],
      ]),
    );

    await view.rerender({
      page: RunToolCalls,
      pageProps: { task: waiting('review-2'), events: 0 },
      client,
    } as never);

    await waitFor(() =>
      expect(keys()).toContainEqual([
        'bureau-tasks',
        'thread',
        'session-1',
        'input-required',
        ['review-2'],
      ]),
    );
  });

  test('show a tool approval whose call is not in the thread, and an error with a retry when the thread could not be read', async () => {
    let failing = true;
    restore = bureau(
      { 'bureau.reviews.get': () => toolApprovalFixture({ id: 'review-1' }) },
      (url) => {
        if (!url.endsWith('/messages')) return undefined;
        if (failing) return new Response('broken', { status: 500 });
        return Response.json({
          threadId: 'session-1',
          messages: [
            {
              id: 'run-1:step:0',
              role: 'assistant',
              toolCalls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'issue-refund', arguments: '{}' },
                },
              ],
            },
            {
              id: 'run-1:step:0:result:call-1',
              role: 'tool',
              toolCallId: 'call-1',
              metadata: { 'conversationalist:toolResult': { outcome: 'action_required' } },
            },
          ],
        });
      },
    ).restore;
    landAt('/runs/run-1');
    const task = taskFixture({
      id: 'run-1',
      contextId: 'session-1',
      status: 'input-required',
      openWaits: [{ kind: 'tool-approval', reviewId: 'review-1', callId: 'call-1' }],
    });

    const view = render(Harness, { props: { task } } as never);

    // The thread failed, so the call has no row, and the decision is still there to make.
    await waitFor(() => expect(view.container.querySelectorAll('.ib-decision')).toHaveLength(1));
    await view.findByRole('heading', { level: 3, name: TASK_COPY.toolCallsLoadFailed.title });

    failing = false;
    await fireEvent.click(await view.findByRole('button', { name: RETRY_LABEL }));

    // The thread holds the call, and the decision sits under it: still one, not two.
    await waitFor(() => expect(view.container.textContent).toContain('issue-refund'));
    expect(view.container.querySelectorAll('.ib-decision')).toHaveLength(1);
  });
});
