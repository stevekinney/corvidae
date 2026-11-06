/**
 * An approval decided on another page while its chat is open (COR-2016, design rows 18i, 18j and,
 * for the denied note, 18f and 18g): the open chat updates in place. The approval's row collapses to
 * who decided, where and when, with no Deny or Approve left; the rail row says the same in its own
 * words; and a polite live region announces it once. A decision made in this chat is not "elsewhere".
 */
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, jest, test } from 'bun:test';

import { toolApprovalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import { settle, until } from '../../lib/fake-timers.test-support.ts';
import ChatConversation from './chat-conversation.svelte';
import { bureau, CONTEXT, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  jest.useRealTimers();
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
  message: 'Refund order 4471 for $42.00?',
  metadata: { '@lostgradient/bureau': { kind: 'tool-approval', round: 0 } },
};

/** What the Bureau streams to a page that attaches to a run parked on the refund's approval. */
const PARKED = [
  { type: 'RUN_STARTED', threadId: 'session-1', runId: 'native-1' },
  {
    type: 'MESSAGES_SNAPSHOT',
    messages: [{ id: 'user-1', role: 'user', content: 'Please refund order 4471.' }],
  },
  { type: 'TOOL_CALL_START', toolCallId: 'call-refund', toolCallName: 'issue-refund' },
  { type: 'TOOL_CALL_ARGS', toolCallId: 'call-refund', delta: '{"orderId":4471,"cents":4200}' },
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

/** The thread once the refund is decided: the Bureau replaced the waiting row with the outcome. */
function decidedThread(decision: Record<string, unknown>, content: unknown) {
  return [
    { id: 'user-1', role: 'user', content: 'Please refund order 4471.' },
    {
      id: 'assistant-1',
      role: 'assistant',
      toolCalls: [
        {
          id: 'call-refund',
          type: 'function',
          function: { name: 'issue-refund', arguments: '{"orderId":4471,"cents":4200}' },
        },
      ],
    },
    {
      id: 'result-1',
      role: 'tool',
      toolCallId: 'call-refund',
      content: JSON.stringify(content),
      metadata: { approvalDecision: decision },
    },
  ];
}

const APPROVED = {
  decision: 'approve',
  decidedBy: 'anonymous:local',
  decidedAt: '2026-11-02T16:46:00.000Z',
  asked: 'Refund order 4471 for $42.00',
};

function serve(thread: () => readonly unknown[] | undefined) {
  const served = bureau(
    {
      'bureau.contexts.get': () => CONTEXT,
      'bureau.reviews.list': () => ({
        reviews:
          thread() === undefined
            ? [
                toolApprovalFixture({
                  sessionId: 'session-1',
                  approval: { ...toolApprovalFixture().approval, callId: 'call-refund' },
                }),
              ]
            : [],
      }),
    },
    (url) => {
      const decided = thread();
      if (url.endsWith('/messages')) {
        return Response.json({ threadId: 'session-1', messages: decided ?? [] });
      }
      if (url.includes('/threads/')) {
        return decided === undefined
          ? sse(PARKED)
          : sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
      }
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

/** Opens the chat on the waiting approval, then lets the poll that finds it decided run. */
async function decidedAway(thread: readonly unknown[]) {
  let decided: readonly unknown[] | undefined;
  serve(() => decided);
  landAt('/chats/session-1');
  jest.useFakeTimers();
  const view = mount();
  await until(() =>
    expect(view.container.querySelector('[data-approval-decision]')).not.toBeNull(),
  );
  decided = thread;
  jest.advanceTimersByTime(3_000);
  await settle(20);
  return view;
}

describe('an approval decided on another page', () => {
  test('collapses to who decided, where and when, with no Deny or Approve, and says so once', async () => {
    const { container, queryByRole, getByTestId } = await decidedAway(
      decidedThread(APPROVED, { refunded: 4200 }),
    );

    await until(() => expect(container.querySelector('[data-approval-decision]')).toBeNull());
    const row = container.querySelector('.cinder-approval-card--row');
    expect(row?.querySelector('h4')?.textContent).toBe('Refund order 4471 for $42.00?');
    expect(
      row?.querySelector('.cinder-approval-card__outcome')?.textContent?.replace(/\s+/g, ' '),
    ).toMatch(/^\s*Approved by you in Reviews\s*·\s*\d{1,2}:\d{2} [AP]M\s*$/);
    expect(queryByRole('button', { name: 'Deny' })).toBeNull();
    expect(queryByRole('button', { name: 'Approve' })).toBeNull();
    // The rail row speaks for the same decision in its own words.
    expect(container.querySelector('.cinder-tool-call-rail__item')?.textContent).toMatch(
      /Approved by you in Reviews \d{1,2}:\d{2} [AP]M/,
    );
    const live = getByTestId('chat-decision-announcement');
    expect(live.getAttribute('role')).toBe('status');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent?.trim()).toBe('Approved in Reviews. Refund order 4471 for $42.00.');
  });

  test('says a refusal the same way, with the note the agent was given as the reason', async () => {
    const { container, getByTestId } = await decidedAway(
      decidedThread(
        {
          ...APPROVED,
          decision: 'deny',
          reason: 'Check the carrier’s claim first.',
        },
        'Tool call denied: Check the carrier’s claim first.',
      ),
    );

    await until(() => expect(getByTestId('chat-decision-announcement').textContent).not.toBe(''));
    expect(getByTestId('chat-decision-announcement').textContent?.trim()).toBe(
      'Denied in Reviews. Refund order 4471 for $42.00.',
    );
    const row = container.querySelector('.cinder-approval-card--row');
    expect(row?.textContent).toContain('Denied by you in Reviews');
    expect(row?.querySelector('.cinder-approval-card__decision-note')?.textContent).toContain(
      'Check the carrier’s claim first.',
    );
  });

  test('announces nothing when the thread carries no record that a person decided it', async () => {
    const { container, getByTestId } = await decidedAway(
      decidedThread({}, { refunded: 4200 }).map((row) =>
        row.role === 'tool' ? { ...row, metadata: {} } : row,
      ),
    );

    await until(() => expect(container.querySelector('[data-approval-decision]')).toBeNull());
    expect(getByTestId('chat-decision-announcement').textContent?.trim()).toBe('');
    expect(container.querySelector('.cinder-approval-card--row')).toBeNull();
  });
});
