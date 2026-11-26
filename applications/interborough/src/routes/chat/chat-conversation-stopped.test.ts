/**
 * A chat opened on a run that failed (COR-2014): the status beside the title reads Failed, the
 * rail shows the call the run ended on as interrupted in words that follow what its tool may do, the
 * status line says so in danger text with a Retry beside it, and Retry runs the turn again as a new
 * turn after the failed attempt, which stays on record with its status line (row 20b), while the
 * interrupted tool goes back through its approval (row 20c).
 */
import { quietFor } from '@lostgradient/testing/wait-until';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { router } from '../../lib/router.svelte.ts';
import ChatConversation from './chat-conversation.svelte';
import SessionSwitch from './chat-session-switch.test-harness.svelte';
import ChatToasts from './chat-toasts.test-harness.svelte';
import { bureau, CONTEXT, landAt } from './pages.test-support.ts';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const mount = (props: Record<string, unknown>) =>
  render(ChatToasts, { props: { page: ChatConversation, pageProps: props } } as never);

const sse = (events: readonly unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

const task = {
  id: 'task-1',
  contextId: 'session-1',
  agentName: 'assistant',
  owner: 'owner',
  actor: null,
  kind: 'chat',
  origin: { kind: 'chat' },
  status: 'failed',
  finishReason: null,
  statusMessage: 'The model provider dropped the connection.',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:01.000Z',
  cleanup: null,
  openWaits: [],
};

/** The retry's run, which finished. */
const retried = {
  ...task,
  id: 'task-2',
  status: 'completed',
  statusMessage: null,
  createdAt: '2026-11-01T00:01:00.000Z',
  updatedAt: '2026-11-01T00:01:01.000Z',
};

const catalogEntry = (name: string, title: string, tier: 'read-only' | 'dangerous') => ({
  name,
  description: title,
  shortDescription: null,
  title,
  inputSchema: null,
  tier,
  defaultApproval: 'ask',
  source: 'host',
  plugin: null,
  skill: null,
  users: [],
});

const catalog = (tier: 'read-only' | 'dangerous', lookup: boolean) => ({
  models: [],
  tools: [
    catalogEntry('issue-refund', 'Issue refund', tier),
    ...(lookup ? [catalogEntry('lookup-order', 'Lookup order', 'read-only')] : []),
  ],
});

/** A refund that ran to completion, then a read-only lookup the run stopped on. */
const REFUND_THEN_LOOKUP_THREAD: Served['thread'] = [
  { id: 'u1', role: 'user', content: 'Please refund order 4471, it arrived damaged.' },
  {
    id: 'a1',
    role: 'assistant',
    content: '',
    toolCalls: [
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'issue-refund', arguments: '{"orderId":"4471"}' },
      },
    ],
  },
  { id: 'a1:result:call-1', role: 'tool', toolCallId: 'call-1', content: 'Refunded $42.00' },
  {
    id: 'a2',
    role: 'assistant',
    content: '',
    toolCalls: [
      {
        id: 'call-2',
        type: 'function',
        function: { name: 'lookup-order', arguments: '{"orderId":"4471"}' },
      },
    ],
  },
];

/** What the stubbed Bureau was asked while a chat was open, and the thread it holds. */
type Served = {
  calls: { method: string; params: Record<string, unknown> }[];
  readonly started: string[];
  /** Answers the held setting change as refused; set once the change is asked for. */
  releaseSteer?: () => void;
  thread: {
    id: string;
    role: string;
    content: string;
    toolCalls?: unknown[];
    toolCallId?: string;
  }[];
};

/**
 * A chat whose last run stopped on a call of `issue-refund` that has no answer. The stubbed Bureau
 * holds the thread, which the retry's start adds the person's message to, and answers the retry's
 * run with the thread it holds; once that run has started, it is the chat's last run.
 */
function open(
  tier: 'read-only' | 'dangerous',
  options: {
    readonly permissionMode?: string;
    readonly steer?: 'accepted' | 'rejected' | 'held';
    readonly served?: Partial<Served>;
    readonly thread?: Served['thread'];
    readonly lookup?: boolean;
  } = {},
): { served: Served; view: ReturnType<typeof mount> } {
  const served: Served = {
    calls: [],
    started: options.served?.started ?? [],
    thread: [
      ...(options.thread ?? [
        { id: 'u1', role: 'user', content: 'Please refund order 4471, it arrived damaged.' },
        {
          id: 'a1',
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'issue-refund', arguments: '{"orderId":"4471"}' },
            },
          ],
        },
      ]),
    ],
  };
  const stub = bureau(
    {
      'bureau.contexts.get': () => ({
        ...CONTEXT,
        ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
      }),
      'bureau.tasks.list': () => ({
        tasks: served.started.length === 0 ? [task] : [retried, task],
        nextPageToken: null,
      }),
      'bureau.agents.catalog': () => catalog(tier, options.lookup === true),
      'bureau.contexts.forgetgrants': () => ({ forgotten: ['default:issue-refund@1.0.0'] }),
      'bureau.contexts.steer': () =>
        options.steer === 'held'
          ? new Promise((resolve) => {
              served.releaseSteer = () =>
                resolve({ outcome: 'rejected', failure: { reason: 'policy-denied' } });
            })
          : options.steer === 'rejected'
            ? { outcome: 'rejected', failure: { reason: 'policy-denied' } }
            : { outcome: 'accepted' },
    },
    (url, init) => {
      if (url.endsWith('/messages')) {
        return Response.json({ threadId: 'session-1', messages: served.thread });
      }
      if (url.includes('/threads/')) {
        return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
      }
      if (url.includes('/agents/')) {
        const sent = typeof init?.body === 'string' ? init.body : '';
        served.started.push(sent);
        // The rows the start sends that the thread does not hold yet: the person's new message.
        const held = new Set(served.thread.map((row) => row.id));
        const added = ((JSON.parse(sent) as { messages?: Served['thread'] }).messages ?? []).filter(
          (row) => !held.has(row.id) && row.role === 'user',
        );
        const reply = { id: 'run-2:step:0', role: 'assistant', content: 'Refunded.' };
        served.thread = [...served.thread, ...added, reply];
        return sse([
          { type: 'RUN_STARTED', threadId: 'session-1', runId: 'run-2' },
          { type: 'MESSAGES_SNAPSHOT', messages: served.thread },
          {
            type: 'RUN_FINISHED',
            threadId: 'session-1',
            runId: 'run-2',
            outcome: { type: 'success' },
          },
        ]);
      }
      return undefined;
    },
  );
  restore = stub.restore;
  served.calls = stub.calls;
  landAt('/chats/session-1');
  return {
    served,
    view:
      options.steer === 'held'
        ? (render(SessionSwitch, {
            props: {
              page: ChatConversation,
              sessionId: 'session-1',
              pageProps: { title: 'Refund', agentName: 'assistant' },
            },
          } as never) as ReturnType<typeof mount>)
        : mount({ sessionId: 'session-1', title: 'Refund', agentName: 'assistant' }),
  };
}

describe('a chat whose run failed on a call', () => {
  test('shows Failed beside the title', async () => {
    const { findByText } = open('dangerous').view;
    const status = await findByText('Failed');
    expect(status.closest('[data-testid="chat-header"]')).not.toBeNull();
    // A Badge, as on the tool-call row, never a dot and coloured words (COR-2438).
    expect(status.closest('.cinder-badge')?.getAttribute('data-cinder-variant')).toBe('danger');
    expect(
      status.closest('[data-testid="chat-header"]')?.querySelector('.cinder-status-dot'),
    ).toBeNull();
    // The title keeps one line, its full words in a tooltip.
    expect(
      status.closest('[data-testid="chat-header"]')?.getAttribute('data-cinder-title-lines'),
    ).toBe('1');
  });

  test('says the call may have run, and that Retry goes back through the approval, for a tool that changes things', async () => {
    const { container, findByText } = open('dangerous').view;
    const line = await findByText(/The reply stopped while Issue refund was running/);
    expect(line.textContent).toContain('the model provider dropped the connection');
    expect(line.textContent).toContain('Issue refund may have run.');
    expect(line.textContent).toContain('Retry goes back through the approval.');
    expect(line.textContent?.toLowerCase()).not.toContain('nothing was changed');
    await waitFor(() =>
      expect(
        container.querySelector('.cinder-tool-call-rail__item[data-cinder-status="interrupted"]')
          ?.textContent,
      ).toContain('Interrupted, may have run'),
    );
  });

  test('AC3 (COR-2533): the stop line links to the failed run’s explanation on the Run page, and the failed attempt keeps it after Retry', async () => {
    const { served, view } = open('dangerous');
    const { container, findByRole, findByText } = view;

    const link = await findByRole('link', { name: 'Why it failed' });
    expect(link.getAttribute('href')).toBe('/runs/task-1#failure-explanation');
    // On the status line of the run that failed, beside its Retry.
    expect(link.closest('.chat-note')?.textContent).toContain(
      'The reply stopped while Issue refund was running',
    );
    expect(link.closest('.chat-note')?.querySelector('button')?.textContent).toContain('Retry');
    // The link and Retry are one group with a Cinder space between them, never touching.
    const retryButton = link.closest('.chat-note')?.querySelector('button');
    const group = link.closest('.cinder-stack');
    expect(group).not.toBeNull();
    expect(group?.contains(retryButton ?? null)).toBe(true);
    expect(group?.getAttribute('style') ?? '').toContain('var(--cinder-space-3)');

    // Clicked, it navigates inside the app, to the section's fragment: the Run page scrolls to it.
    await fireEvent.click(link);
    expect(router.pathname).toBe('/runs/task-1');
    expect(router.hash).toBe('#failure-explanation');
    landAt('/chats/session-1');

    await fireEvent.click(await findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(served.started).toHaveLength(1));
    await findByText('Refunded.');
    // The failed attempt stays on record, with its line and its link, and no Retry.
    const links = [...container.querySelectorAll('a[data-chat-explain-link]')];
    expect(links.map((anchor) => anchor.getAttribute('href'))).toEqual([
      '/runs/task-1#failure-explanation',
    ]);
    expect(container.querySelector('.chat-note button')).toBeNull();
  });

  test('says the call did not finish and nothing was changed for a tool that only reads', async () => {
    const { container, findByText } = open('read-only').view;
    const line = await findByText(/The reply stopped while Issue refund was running/);
    expect(line.textContent).toContain('Issue refund didn’t finish and nothing was changed.');
    await waitFor(() =>
      expect(
        container.querySelector('.cinder-tool-call-rail__item[data-cinder-status="interrupted"]')
          ?.textContent,
      ).toContain('Interrupted, didn’t finish'),
    );
  });

  test('Retry sends a new turn after the failed attempt, which stays with its status line, and has the interrupted tool asked again', async () => {
    const { served, view } = open('dangerous');
    const { container, findByRole, findByText } = view;

    await fireEvent.click(await findByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(served.started).toHaveLength(1));
    const methods = served.calls.map((call) => call.method);
    const forget = served.calls.find((call) => call.method === 'bureau.contexts.forgetgrants');
    expect(forget?.params).toEqual({ contextId: 'session-1', tools: ['issue-refund'] });
    expect(methods.indexOf('bureau.contexts.forgetgrants')).toBeGreaterThan(-1);
    // The thread still holds the failed attempt, and the message is added again after it.
    expect(served.thread.map((row) => row.id).slice(0, 2)).toEqual(['u1', 'a1']);
    expect(served.thread.filter((row) => row.role === 'user')).toHaveLength(2);
    await findByText('Refunded.');
    // The failed attempt stays on record: its call reads as interrupted, its line is still there,
    // and only the last turn could offer Retry, which this one, finished, does not.
    const line = await findByText(/The reply stopped while Issue refund was running/);
    expect(line.textContent).toContain('Issue refund may have run.');
    expect(
      container.querySelectorAll('.cinder-tool-call-rail__item[data-cinder-status="interrupted"]')
        .length,
    ).toBe(1);
    const labels = [...container.querySelectorAll('button')].map((button) =>
      button.textContent?.trim(),
    );
    expect(labels).not.toContain('Retry');
    expect(container.querySelector('[data-testid="chat-header"]')?.textContent).not.toContain(
      'Failed',
    );
  });

  test('Retry on a chat set to Allow all sets it to On changes first, so the call asks again', async () => {
    const { served, view } = open('dangerous', { permissionMode: 'allow-all' });
    const { findByRole } = view;

    await fireEvent.click(await findByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(served.started).toHaveLength(1));
    const methods = served.calls.map((call) => call.method);
    expect(methods.indexOf('bureau.contexts.steer')).toBeGreaterThan(-1);
    expect(methods.indexOf('bureau.contexts.steer')).toBeLessThan(
      methods.indexOf('bureau.contexts.forgetgrants'),
    );
    const steer = served.calls.find((call) => call.method === 'bureau.contexts.steer');
    expect(steer?.params).toMatchObject({ contextId: 'session-1', permissionMode: 'on-changes' });
  });

  test('Retry on a chat set to Allow all changes no setting when the refund finished and the run stopped on a read-only lookup', async () => {
    const { served, view } = open('dangerous', {
      permissionMode: 'allow-all',
      thread: REFUND_THEN_LOOKUP_THREAD,
      lookup: true,
    });
    const { findByRole } = view;

    await fireEvent.click(await findByRole('button', { name: 'Retry' }));

    // The refund's result is on record for the agent to read, and the lookup only reads: no call
    // that may change things was interrupted, so there is nothing to ask again.
    await waitFor(() => expect(served.started).toHaveLength(1));
    expect(served.calls.some((call) => call.method === 'bureau.contexts.steer')).toBe(false);
    expect(served.calls.some((call) => call.method === 'bureau.contexts.forgetgrants')).toBe(false);
  });

  test('Retry on a chat not set to Allow all changes no setting', async () => {
    const { served, view } = open('dangerous');
    const { findByRole } = view;

    await fireEvent.click(await findByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(served.started).toHaveLength(1));
    expect(served.calls.some((call) => call.method === 'bureau.contexts.steer')).toBe(false);
  });

  test('Retry on a chat set to Allow all sends nothing when it cannot be set to On changes', async () => {
    const { served, view } = open('dangerous', { permissionMode: 'allow-all', steer: 'rejected' });
    const { findByRole, findByText } = view;

    await fireEvent.click(await findByRole('button', { name: 'Retry' }));

    await findByText('This chat cannot use that mode.');
    expect(served.calls.some((call) => call.method === 'bureau.contexts.forgetgrants')).toBe(false);
    expect(served.started).toEqual([]);
  });

  test('a refusal of that setting that arrives after the person moved to another chat says nothing there (COR-2725)', async () => {
    const { served, view } = open('dangerous', { permissionMode: 'allow-all', steer: 'held' });

    await fireEvent.click(await view.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(served.releaseSteer).toBeDefined());
    await view.rerender({ sessionId: 'session-2' } as never);
    served.releaseSteer?.();
    await quietFor(50);

    expect(document.body.textContent).not.toContain('This chat cannot use that mode.');
    expect(served.started).toEqual([]);
  });
});
