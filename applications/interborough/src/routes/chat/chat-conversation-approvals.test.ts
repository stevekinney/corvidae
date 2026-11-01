/**
 * The approval row of the conversation page: it asks in one row, offers to allow the tool for the
 * rest of the chat, sends that as the resume Approve sends with `remember`, and says when the grant
 * did not loosen the tool. The header title shows the Markdown it was given.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { toolApprovalFixture } from '../../lib/bureau-fixtures.test-support.ts';
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
  metadata: { '@lostgradient/bureau': { kind: 'tool-approval', round: 2 } },
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

  describe('when allowed for the rest of the chat (COR-1990)', () => {
    const settled = (fields: Record<string, unknown> = {}) => ({
      type: 'CUSTOM',
      name: 'bureau.tool-grant-settled',
      value: {
        interruptId: APPROVAL.id,
        toolCallId: 'call-refund',
        toolName: 'issue-refund',
        runId: 'native-1',
        remembered: true,
        loosened: true,
        ...fields,
      },
    });

    /** A start stops on the approval at round 2; a resume answers with `continuation`. */
    function allowRun(continuation: readonly unknown[], resumes: unknown[]) {
      return (url: string, init?: RequestInit): Response | undefined => {
        const body: { runId: string; resume?: unknown } = JSON.parse(
          typeof init?.body === 'string' ? init.body : '{}',
        );
        if (url.includes('/agents/') && body.resume !== undefined) {
          resumes.push(body.resume);
          return sse([
            { type: 'RUN_STARTED', threadId: 'session-1', runId: body.runId },
            ...continuation,
            { type: 'RUN_FINISHED', threadId: 'session-1', runId: body.runId },
          ]);
        }
        return approvalRun(url, init);
      };
    }

    async function allowed(continuation: readonly unknown[]) {
      const resumes: unknown[] = [];
      const served = bureau(
        {
          'bureau.contexts.get': () => CONTEXT,
          'bureau.reviews.list': () => ({ reviews: [pendingApproval()] }),
        },
        allowRun(continuation, resumes),
      );
      restore = served.restore;
      landAt('/chats/session-1');
      const view = mount();
      await askForApproval(view.container);
      await fireEvent.click(
        await view.findByRole('button', { name: 'Allow for the rest of this chat' }),
      );
      return { ...view, served, resumes };
    }

    test('sends the resume Approve sends, with remember and the round, and the turn continues', async () => {
      const { findByText, served, resumes } = await allowed([
        { type: 'TEXT_MESSAGE_START', messageId: 'reply-2', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'reply-2', delta: 'Refunded order-1001.' },
        { type: 'TEXT_MESSAGE_END', messageId: 'reply-2' },
        settled(),
      ]);

      expect(await findByText(/Refunded order-1001\./)).not.toBeNull();
      expect(resumes).toEqual([
        [
          {
            interruptId: APPROVAL.id,
            status: 'resolved',
            payload: { decision: 'approve', remember: true },
            metadata: { '@lostgradient/bureau': { round: 2 } },
          },
        ],
      ]);
      expect(served.calls.filter((call) => call.method === 'bureau.reviews.resolve')).toEqual([]);
    });

    test('says the grant was kept but the tool will ask again when it did not loosen it', async () => {
      const { findByText } = await allowed([settled({ loosened: false })]);

      expect(await findByText(/Approved, but it will ask again/)).not.toBeNull();
      expect(await findByText(/issue-refund always asks/)).not.toBeNull();
    });

    test('says the approval was not remembered when the Bureau did not store the grant', async () => {
      const { findByText } = await allowed([settled({ remembered: false, loosened: false })]);

      expect(await findByText(/Approved, but not remembered/)).not.toBeNull();
    });

    test('says nothing when the grant loosened the tool', async () => {
      const { queryByText, resumes } = await allowed([settled()]);

      await waitFor(() => expect(resumes).toHaveLength(1));
      expect(queryByText(/Approved, but/)).toBeNull();
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
