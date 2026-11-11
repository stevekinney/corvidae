/**
 * The approval row of the conversation page: it asks in one row, offers to allow the tool for the
 * rest of the chat, sends that as the resume Approve sends with `remember`, and says when the grant
 * did not loosen the tool. The header title shows the Markdown it was given.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { ConnectionMonitor } from '../../app/connection.svelte.ts';
import { CHAT_COPY } from '../../app/copy.ts';
import { toolApprovalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import ChatConversation from './chat-conversation.svelte';
import ChatToasts from './chat-toasts.test-harness.svelte';
import { bureau, CONTEXT, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';

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
  await waitFor(() => expect(container.querySelector('[data-approval-decision]')).not.toBeNull());
}

describe('an approval in the chat', () => {
  test('is the shared approval row: Input, a note, Allow for the rest of this chat, Deny and Approve', async () => {
    restore = bureau(
      { 'bureau.contexts.get': () => CONTEXT, 'bureau.reviews.list': () => ({ reviews: [] }) },
      approvalRun,
    ).restore;
    landAt('/chats/session-1');
    const { container, findByRole } = mount();

    await askForApproval(container);

    expect(container.querySelectorAll('[data-approval-decision]')).toHaveLength(1);
    for (const name of ['Input', 'Add a note', 'Deny', 'Approve']) {
      expect(await findByRole('button', { name: new RegExp(`^${name}`) })).not.toBeNull();
    }
    expect(
      await findByRole('checkbox', { name: /^Allow .* for the rest of this chat$/ }),
    ).not.toBeNull();
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
        await view.findByRole('checkbox', { name: /^Allow .* for the rest of this chat$/ }),
      );
      await fireEvent.click(await view.findByRole('button', { name: 'Approve' }));
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
            payload: { decision: 'approve', remember: true, decisionSurface: 'chat' },
            metadata: { '@lostgradient/bureau': { round: 2 } },
          },
        ],
      ]);
      expect(served.calls.filter((call) => call.method === 'bureau.reviews.resolve')).toEqual([]);
    });

    test('says the permission was saved but the agent will still ask when it did not loosen the tool', async () => {
      const { findByText } = await allowed([settled({ loosened: false })]);

      expect(await findByText(/Approved, but it will ask again/)).not.toBeNull();
      expect(await findByText(/still ask before using issue-refund again/)).not.toBeNull();
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

  test('shows what the call was given under Input, and hides it again', async () => {
    restore = bureau(
      { 'bureau.contexts.get': () => CONTEXT, 'bureau.reviews.list': () => ({ reviews: [] }) },
      approvalRun,
    ).restore;
    landAt('/chats/session-1');
    const { container, findByRole } = mount();
    await askForApproval(container);
    const toggle = await findByRole('button', { name: /^Input/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    await fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-approval-decision]')?.textContent).toContain('4200');
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  test('sends a refusal with the note the person left, as the reason the agent reads', async () => {
    const resumes: unknown[] = [];
    restore = bureau(
      { 'bureau.contexts.get': () => CONTEXT, 'bureau.reviews.list': () => ({ reviews: [] }) },
      (url, init) => {
        const body: { runId: string; resume?: unknown } = JSON.parse(
          typeof init?.body === 'string' ? init.body : '{}',
        );
        if (url.includes('/agents/') && body.resume !== undefined) {
          resumes.push(body.resume);
          return sse([
            { type: 'RUN_STARTED', threadId: 'session-1', runId: body.runId },
            { type: 'RUN_FINISHED', threadId: 'session-1', runId: body.runId },
          ]);
        }
        return approvalRun(url, init);
      },
    ).restore;
    landAt('/chats/session-1');
    const { container, findByRole, findByLabelText } = mount();
    await askForApproval(container);

    await fireEvent.click(await findByRole('button', { name: 'Add a note' }));
    await fireEvent.input(await findByLabelText(/^Note/), {
      target: { value: 'Check the carrier’s claim first.' },
    });
    await fireEvent.click(await findByRole('button', { name: 'Deny' }));

    await waitFor(() => expect(resumes).toHaveLength(1));
    expect(resumes[0]).toMatchObject([
      {
        interruptId: APPROVAL.id,
        // The chat says the decision was made here (COR-2292).
        payload: {
          decision: 'deny',
          reason: 'Check the carrier’s claim first.',
          decisionSurface: 'chat',
        },
      },
    ]);
  });
});

describe('an approval raised after the person answered a question', () => {
  test('is decided in its row, and the decision continues the run', async () => {
    type Body = { resume?: Array<{ interruptId: string; payload: unknown }> };
    const bodies: Body[] = [];
    restore = bureau(
      { 'bureau.contexts.get': () => CONTEXT, 'bureau.reviews.list': () => ({ reviews: [] }) },
      (url, init) => {
        if (url.endsWith('/messages'))
          return Response.json({ threadId: 'session-1', messages: [] });
        if (url.includes('/threads/')) {
          return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
        }
        if (!url.includes('/agents/')) return undefined;
        bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
        const run = `run-${bodies.length}`;
        if (bodies.length === 1) {
          return sse([
            { type: 'RUN_STARTED', threadId: 'session-1', runId: run },
            {
              type: 'RUN_FINISHED',
              threadId: 'session-1',
              runId: run,
              outcome: {
                type: 'interrupt',
                interrupts: [
                  {
                    id: 'human-wait:native-1:environment:0',
                    reason: 'human-wait',
                    message: 'Which environment?',
                  },
                ],
              },
            },
          ]);
        }
        if (bodies.length === 2) {
          return sse([
            { type: 'RUN_STARTED', threadId: 'session-1', runId: run },
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
              runId: run,
              outcome: { type: 'interrupt', interrupts: [APPROVAL] },
            },
          ]);
        }
        return sse([
          { type: 'RUN_STARTED', threadId: 'session-1', runId: run },
          { type: 'RUN_FINISHED', threadId: 'session-1', runId: run },
        ]);
      },
    ).restore;
    landAt('/chats/session-1');
    const { container } = mount();
    const box = container.querySelector('textarea');
    if (box === null) throw new Error('The composer did not render.');
    await fireEvent.input(box, { target: { value: 'Ship it' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(bodies).toHaveLength(1));
    await waitFor(() => expect(container.textContent).toContain('Which environment?'));
    await fireEvent.input(box, { target: { value: 'staging' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(container.querySelector('[data-approval-decision]')).not.toBeNull());

    const approve = [
      ...(container.querySelector('[data-approval-decision]')?.querySelectorAll('button') ?? []),
    ].find((button) => button.textContent?.trim() === 'Approve');
    if (approve === undefined) throw new Error('The approval has no Approve.');
    await fireEvent.click(approve);

    await waitFor(() => expect(bodies).toHaveLength(3));
    expect(bodies[2]?.resume?.[0]).toMatchObject({
      interruptId: APPROVAL.id,
      payload: { decision: 'approve', decisionSurface: 'chat' },
    });
  });
});

describe('an approval while Interborough cannot be reached (design rows 16y, 16z)', () => {
  test('keeps its question and input at full contrast and turns only Deny and Approve off, each with the reason as its description', async () => {
    restore = bureau(
      { 'bureau.contexts.get': () => CONTEXT, 'bureau.reviews.list': () => ({ reviews: [] }) },
      approvalRun,
    ).restore;
    landAt('/chats/session-1');
    const monitor = new ConnectionMonitor({
      probe: async () => {
        throw new TypeError('Failed to fetch');
      },
      probeDelayMs: () => 60_000,
      browserOffline: false,
    });
    try {
      const { container, findByRole } = render(QueryPage, {
        props: {
          page: ChatConversation,
          pageProps: { sessionId: 'session-1', title: 'Plan the week', agentName: 'assistant' },
          connection: monitor,
        },
      } as never);
      await askForApproval(container);
      monitor.reportUnreachable();

      const approve = await findByRole('button', { name: 'Approve' });
      const deny = await findByRole('button', { name: 'Deny' });
      await waitFor(() => expect(approve.getAttribute('aria-disabled')).toBe('true'));
      for (const button of [approve, deny]) {
        // Off with aria-disabled, never the disabled property, so the control stays focusable.
        expect(button.hasAttribute('disabled')).toBe(false);
        expect(button.getAttribute('aria-disabled')).toBe('true');
        const reason = document.getElementById(button.getAttribute('aria-describedby') ?? '');
        expect(reason?.textContent).toContain(CHAT_COPY.approval.unreachable);
      }
      expect(container.querySelector('[data-approval-decision]')?.textContent).toContain(
        CHAT_COPY.approval.unreachable,
      );
      // What does not change anything stays available, and nothing is dimmed.
      const input = await findByRole('button', { name: /^Input/ });
      const note = await findByRole('button', { name: 'Add a note' });
      expect(input.hasAttribute('disabled')).toBe(false);
      expect(note.hasAttribute('aria-disabled')).toBe(false);
      expect(container.querySelector('[style*="opacity"]')).toBeNull();
    } finally {
      cleanup();
      monitor.dispose();
    }
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
