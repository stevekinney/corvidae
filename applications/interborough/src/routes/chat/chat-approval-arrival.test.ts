/**
 * Opening a chat that is waiting on an approval (COR-2016, design row 16m): the approval's row
 * scrolls into view and takes focus, and nothing is answered. An approval that arrives while the
 * person is in the conversation never takes their focus.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { quietFor } from '@lostgradient/testing/wait-until';

import { toolApprovalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import ChatConversation from './chat-conversation.svelte';
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

/**
 * What the Bureau streams to a page that attaches to a run parked on an approval: the thread as a
 * snapshot, then the call that asked and the stop on it.
 */
const PARKED = [
  { type: 'RUN_STARTED', threadId: 'session-1', runId: 'native-1' },
  {
    type: 'MESSAGES_SNAPSHOT',
    messages: [{ id: 'user-1', role: 'user', content: 'Please refund order 1001.' }],
  },
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
    runId: 'native-1',
    outcome: { type: 'interrupt', interrupts: [APPROVAL] },
  },
];

function serve(attach: () => Response, answers: Array<unknown> = []) {
  const served = bureau(
    {
      'bureau.contexts.get': () => CONTEXT,
      'bureau.reviews.list': () => ({
        reviews: [
          toolApprovalFixture({
            sessionId: 'session-1',
            approval: { ...toolApprovalFixture().approval, callId: 'call-refund' },
          }),
        ],
      }),
      'bureau.reviews.resolve': (params) => {
        answers.push(params);
        return {};
      },
    },
    (url) => {
      if (url.endsWith('/messages')) return Response.json({ threadId: 'session-1', messages: [] });
      if (url.includes('/threads/')) return attach();
      return undefined;
    },
  );
  restore = served.restore;
  return served;
}

const mount = () =>
  render(QueryPage, {
    props: {
      page: ChatConversation,
      pageProps: { sessionId: 'session-1', title: 'Refund', agentName: 'assistant' },
    },
  } as never);

describe('a chat that opens on an approval', () => {
  test('scrolls the approval into view and focuses it, without answering it', async () => {
    const scrolled: Element[] = [];
    const scroll = spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (
      this: Element,
    ) {
      scrolled.push(this);
    });
    const answers: unknown[] = [];
    serve(() => sse(PARKED), answers);
    landAt('/chats/session-1');
    const { container } = mount();

    // The row is drawn again when the joined run's state arrives, so the focus is read on the row
    // that is on the page once it settles, not on the first one drawn.
    const row = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('[data-approval-decision]');
      if (found === null) throw new Error('The approval did not render.');
      if (document.activeElement !== found) throw new Error('The approval has not taken focus.');
      return found;
    });
    // Where the transcript rests is Chat's: the row never scrolls the page itself.
    expect(scrolled).toEqual([]);
    // Cinder's approval row is an article named by the question it asks.
    expect(row.tagName).toBe('ARTICLE');
    const titleId = row.getAttribute('aria-labelledby');
    expect(titleId === null ? null : document.getElementById(titleId)?.textContent).toContain(
      'Refund order-1001?',
    );
    expect(row.getAttribute('tabindex')).toBe('-1');
    // The row is the focus, not a choice in it: Enter answers nothing.
    expect(row.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(row);
    expect(answers).toEqual([]);
    scroll.mockRestore();
  });

  test('takes focus back from the transcript, where Chat parks it when the focused row is drawn again', async () => {
    serve(() => sse(PARKED));
    landAt('/chats/session-1');
    const { container } = mount();

    await waitFor(() => {
      const found = container.querySelector<HTMLElement>('[data-approval-decision]');
      if (found === null || document.activeElement !== found) throw new Error('Not focused yet.');
    });
    // Chat parks focus on its transcript when the row that held it is removed.
    const transcript = container.querySelector<HTMLElement>('.chat-timeline')!;
    transcript.focus();
    expect(document.activeElement).toBe(transcript);

    await waitFor(() => {
      const found = container.querySelector<HTMLElement>('[data-approval-decision]');
      if (found === null || document.activeElement !== found) {
        throw new Error('The approval has not taken focus back from the transcript.');
      }
    });
  });

  test('leaves focus where the person put it, outside the rows', async () => {
    serve(() => sse(PARKED));
    landAt('/chats/session-1');
    const { container } = mount();

    await waitFor(() => {
      const found = container.querySelector<HTMLElement>('[data-approval-decision]');
      if (found === null || document.activeElement !== found) throw new Error('Not focused yet.');
    });
    const box = container.querySelector<HTMLTextAreaElement>('textarea')!;
    box.focus();
    await quietFor(250);
    expect(document.activeElement).toBe(box);
  });

  test('keeps the row out of the Tab order, so only the opening brings focus to it', async () => {
    serve(() => sse(PARKED));
    landAt('/chats/session-1');
    const { container } = mount();

    const row = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('[data-approval-decision]');
      if (found === null) throw new Error('The approval did not render.');
      return found;
    });
    expect(row.tabIndex).toBe(-1);
    // Its buttons still take Tab, and the Deny and Approve in it are the person's to press.
    await fireEvent.keyDown(row, { key: 'Tab' });
    expect(row.querySelectorAll('button:not([disabled])').length).toBeGreaterThan(0);
  });

  test('leaves focus alone when the chat opens with nothing waiting', async () => {
    serve(() => sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]));
    landAt('/chats/session-1');
    const { container, findByRole } = mount();

    await findByRole('heading', { level: 1 });
    await waitFor(() => expect(container.querySelector('textarea')).not.toBeNull());
    expect(container.querySelector('[data-approval-decision]')).toBeNull();
    expect(document.activeElement?.hasAttribute('data-approval-decision')).toBe(false);
  });

  test('never takes focus for an approval that arrives while the person is in the conversation', async () => {
    const started = sse([
      { type: 'RUN_STARTED', threadId: 'session-1', runId: 'native-1' },
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
        runId: 'native-1',
        outcome: { type: 'interrupt', interrupts: [APPROVAL] },
      },
    ]);
    restore = bureau(
      {
        'bureau.contexts.get': () => CONTEXT,
        'bureau.reviews.list': () => ({ reviews: [] }),
      },
      (url) => {
        if (url.endsWith('/messages')) {
          return Response.json({ threadId: 'session-1', messages: [] });
        }
        if (url.includes('/threads/')) {
          return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
        }
        return url.includes('/agents/') ? started : undefined;
      },
    ).restore;
    landAt('/chats/session-1');
    const { container } = mount();

    const box = await waitFor(() => {
      const found = container.querySelector('textarea');
      if (found === null) throw new Error('The composer did not render.');
      return found;
    });
    await fireEvent.input(box, { target: { value: 'Refund it' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    const row = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('[data-approval-decision]');
      if (found === null) throw new Error('The approval did not render.');
      return found;
    });

    await quietFor(250);
    expect(document.activeElement === row).toBe(false);
  });
});
