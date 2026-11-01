/**
 * The approval row of the conversation page: it asks in one row, offers to allow the tool for the
 * rest of the chat, sends that as the Bureau's `remember` on the review the person was shown, and
 * reads a refused call as Denied. The header title shows the Markdown it was given.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { toolApprovalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import { StubFault } from '../../lib/bureau-stub.test-support.ts';
import ChatConversation from './chat-conversation.svelte';
import ChatToasts from './chat-toasts.test-harness.svelte';
import { bureau, CONTEXT, landAt } from './pages.test-support.ts';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const sse = (events: readonly unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

const APPROVAL = {
  id: 'approval:native-1:call-refund',
  reason: 'tool-approval',
  toolCallId: 'call-refund',
  message: 'Refund order-1001?',
};

/** A run that calls `issue-refund` and stops on the approval for it. */
function approvalRun(url: string, init?: RequestInit): Response | undefined {
  if (url.endsWith('/messages')) return Response.json({ threadId: 'session-1', messages: [] });
  if (url.includes('/threads/')) {
    return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
  }
  if (!url.includes('/agents/')) return undefined;
  const input: { runId: string } = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
  return sse([
    { type: 'RUN_STARTED', threadId: 'session-1', runId: input.runId },
    { type: 'TOOL_CALL_START', toolCallId: 'call-refund', toolCallName: 'issue-refund' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'call-refund', delta: '{"cents":4200}' },
    { type: 'TOOL_CALL_END', toolCallId: 'call-refund' },
    {
      type: 'TOOL_CALL_RESULT',
      messageId: 'result-1',
      toolCallId: 'call-refund',
      content: 'requires approval',
      role: 'tool',
    },
    {
      type: 'RUN_FINISHED',
      threadId: 'session-1',
      runId: input.runId,
      outcome: { type: 'interrupt', interrupts: [APPROVAL] },
    },
  ]);
}

const pendingApproval = (round = 2) =>
  toolApprovalFixture({
    sessionId: 'session-1',
    round,
    approval: { ...toolApprovalFixture().approval, callId: 'call-refund' },
  });

function mount(title = 'Plan the week') {
  return render(ChatToasts, {
    props: {
      page: ChatConversation,
      pageProps: { sessionId: 'session-1', title, agentName: 'assistant' },
    },
  } as never);
}

async function askForApproval(container: HTMLElement): Promise<void> {
  const box = container.querySelector('textarea');
  if (box === null) throw new Error('The composer did not render.');
  await fireEvent.input(box, { target: { value: 'Refund it' } });
  await fireEvent.keyDown(box, { key: 'Enter' });
  await waitFor(() => expect(container.querySelector('.ib-decision')).not.toBeNull());
}

describe('an approval in the chat', () => {
  test('is one row that offers Allow for the rest of this chat beside Deny and Approve', async () => {
    restore = bureau(
      { 'bureau.contexts.get': () => CONTEXT, 'bureau.reviews.list': () => ({ reviews: [] }) },
      approvalRun,
    ).restore;
    landAt('/chats/session-1');
    const { container, findByRole } = mount();

    await askForApproval(container);

    expect(container.querySelectorAll('.ib-decision__row')).toHaveLength(1);
    for (const name of ['Show input', 'Allow for the rest of this chat', 'Deny', 'Approve']) {
      expect(await findByRole('button', { name })).not.toBeNull();
    }
  });

  test('sends remember on the review and its round when allowed for the rest of the chat', async () => {
    const served = bureau(
      {
        'bureau.contexts.get': () => CONTEXT,
        'bureau.reviews.list': () => ({ reviews: [pendingApproval()] }),
        'bureau.reviews.resolve': (params) => ({
          id: String(params['id']),
          kind: 'tool-approval',
          decision: 'approve',
          receipt: 'applied',
          remembered: true,
        }),
      },
      approvalRun,
    );
    restore = served.restore;
    landAt('/chats/session-1');
    const { container, findByRole } = mount();
    await askForApproval(container);

    const allow = await findByRole('button', { name: 'Allow for the rest of this chat' });
    // The grant is made on the Bureau's review, so it waits for the pending reviews to be read.
    await waitFor(() => expect((allow as HTMLButtonElement).disabled).toBe(false));
    await fireEvent.click(allow);

    await waitFor(() =>
      expect(served.calls.filter((call) => call.method === 'bureau.reviews.resolve')).toEqual([
        {
          method: 'bureau.reviews.resolve',
          params: { id: pendingApproval().id, decision: 'approve', round: 2, remember: true },
        },
      ]),
    );
  });

  test('makes the grant on this chat’s review when another chat’s pending review has the same call', async () => {
    const served = bureau(
      {
        'bureau.contexts.get': () => CONTEXT,
        'bureau.reviews.list': () => ({
          reviews: [
            // Another chat's review comes first and carries the same call identifier.
            toolApprovalFixture({
              id: 'approval:run-9:call-refund',
              sessionId: 'session-9',
              round: 7,
              approval: { ...toolApprovalFixture().approval, callId: 'call-refund' },
            }),
            pendingApproval(),
          ],
        }),
        'bureau.reviews.resolve': (params) => ({
          id: String(params['id']),
          kind: 'tool-approval',
          decision: 'approve',
          receipt: 'applied',
          remembered: true,
        }),
      },
      approvalRun,
    );
    restore = served.restore;
    landAt('/chats/session-1');
    const { container, findByRole } = mount();
    await askForApproval(container);
    const allow = await findByRole('button', { name: 'Allow for the rest of this chat' });
    await waitFor(() => expect((allow as HTMLButtonElement).disabled).toBe(false));

    await fireEvent.click(allow);

    await waitFor(() =>
      expect(
        served.calls
          .filter((call) => call.method === 'bureau.reviews.resolve')
          .map((c) => c.params),
      ).toEqual([{ id: pendingApproval().id, decision: 'approve', round: 2, remember: true }]),
    );
  });

  test('says so when the Bureau approved the call but did not keep the grant', async () => {
    restore = bureau(
      {
        'bureau.contexts.get': () => CONTEXT,
        'bureau.reviews.list': () => ({ reviews: [pendingApproval()] }),
        'bureau.reviews.resolve': (params) => ({
          id: String(params['id']),
          kind: 'tool-approval',
          decision: 'approve',
          receipt: 'applied',
          remembered: false,
        }),
      },
      approvalRun,
    ).restore;
    landAt('/chats/session-1');
    const { container, findByRole, findByText } = mount();
    await askForApproval(container);
    const allow = await findByRole('button', { name: 'Allow for the rest of this chat' });
    await waitFor(() => expect((allow as HTMLButtonElement).disabled).toBe(false));

    await fireEvent.click(allow);

    expect(await findByText(/Approved, but not remembered/)).not.toBeNull();
  });

  describe('when the Bureau does not take the grant as asked', () => {
    /** Opens the waiting chat, with the review resolving as `resolve` says, and presses the grant. */
    async function allowWith(resolve: (params: Record<string, unknown>) => unknown) {
      restore = bureau(
        {
          'bureau.contexts.get': () => CONTEXT,
          'bureau.reviews.list': () => ({ reviews: [pendingApproval()] }),
          'bureau.reviews.resolve': resolve,
        },
        approvalRun,
      ).restore;
      landAt('/chats/session-1');
      const view = mount();
      await askForApproval(view.container);
      const allow = await view.findByRole('button', { name: 'Allow for the rest of this chat' });
      await waitFor(() => expect((allow as HTMLButtonElement).disabled).toBe(false));
      await fireEvent.click(allow);
      return view;
    }

    test('says the approval was gated again when the Bureau answers superseded', async () => {
      const { findByText } = await allowWith((params) => ({
        id: String(params['id']),
        kind: 'tool-approval',
        decision: 'approve',
        receipt: 'superseded',
      }));

      expect(await findByText(/gated again/)).not.toBeNull();
    });

    test('says the decision took effect when only its outcome could not be written', async () => {
      const { findByText } = await allowWith(() => {
        throw new StubFault('Conflict', 409, 'The decision was recorded.', {
          reason: 'APPROVAL_OUTCOME_NOT_WRITTEN: not written',
        });
      });

      expect(await findByText(/outcome could not be written/)).not.toBeNull();
    });

    test('says the review changed, and that nothing was decided, when its round moved', async () => {
      const { findByText } = await allowWith(() => {
        throw new StubFault('Conflict', 409, 'The review moved on.', {
          reason: 'REVIEW_ROUND_CHANGED: now at round 3',
        });
      });

      expect(await findByText(/changed while you read it/)).not.toBeNull();
    });

    test('says the decision was not recorded for any other failure, and lets it be tried again', async () => {
      const { findByText, findByRole } = await allowWith(() => {
        throw new StubFault('EngineFailure', 500, 'The Bureau broke.');
      });

      expect(await findByText(/The decision was not recorded/)).not.toBeNull();
      const allow = await findByRole('button', { name: 'Allow for the rest of this chat' });
      await waitFor(() => expect((allow as HTMLButtonElement).disabled).toBe(false));
    });
  });

  test('shows what the call was given under Show input, and hides it again', async () => {
    restore = bureau(
      { 'bureau.contexts.get': () => CONTEXT, 'bureau.reviews.list': () => ({ reviews: [] }) },
      approvalRun,
    ).restore;
    landAt('/chats/session-1');
    const { container, findByRole, queryByRole } = mount();
    await askForApproval(container);
    expect(container.querySelector('.ib-decision__input')).toBeNull();

    await fireEvent.click(await findByRole('button', { name: 'Show input' }));

    expect(container.querySelector('.ib-decision__input')?.textContent).toContain('cents');
    expect(container.querySelector('.ib-decision__input')?.textContent).toContain('4200');
    await fireEvent.click(await findByRole('button', { name: 'Hide input' }));
    expect(container.querySelector('.ib-decision__input')).toBeNull();
    expect(queryByRole('button', { name: 'Show input' })).not.toBeNull();
  });
});

describe('the header title', () => {
  test('draws the Markdown it was given and leaves the characters of anything else', async () => {
    restore = bureau({ 'bureau.contexts.get': () => CONTEXT }, (url) => {
      if (url.endsWith('/messages')) return Response.json({ threadId: 'session-1', messages: [] });
      if (url.includes('/threads/')) {
        return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
      }
      return undefined;
    }).restore;
    landAt('/chats/session-1');
    const { findByTestId } = mount('Plan **the week** with `refund` <b>x</b>');

    const header = await findByTestId('chat-header');
    const heading = header.querySelector('h1');
    expect(heading?.querySelector('strong')?.textContent).toBe('the week');
    expect(heading?.querySelector('code')?.textContent).toBe('refund');
    expect(heading?.textContent).toBe('Plan the week with refund <b>x</b>');
    expect(heading?.querySelector('b')).toBeNull();
  });
});
