/**
 * The chat's states on the ChatStates board (COR-2016, design rows 19b, 19c, 19h, 19k, 19p, 20f and
 * 20h): a chat the server ended keeps what arrived and says why under it; a waiting approval stays
 * answerable with no provider, and says the run continues once one is connected; an approval of an
 * agent a disabled plugin holds back reads Unavailable with its reason and no buttons; a reply that
 * failed partway keeps its text with the status line and Retry; a turn that ends on a tool call
 * closes with the run's end state. Every record is the one a capture serves
 * (`fixtures/chat-states.ts`).
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import type { QueryClient } from '@tanstack/svelte-query';
import {
  approvalBatchMessages,
  billingThreadWithPartialReply,
  ENDED_PARTIAL_REPLY,
  endedOnToolCallMessages,
  FAILED_PARTWAY_CAUSE,
  failedPartwayMessages,
  HELD_BY_PLUGIN_REASON,
  heldByPluginMessages,
  tasksOf,
} from '../../../fixtures/chat-states.ts';
import { CHAT_COPY } from '../../app/copy/chat.ts';
import { StubFault } from '../../lib/bureau-stub.test-support.ts';
import type { ProvidersSnapshot } from '../../lib/host-providers.ts';
import { createQueryClient, queryKeys } from '../../lib/query.ts';
import ChatConversation from './chat-conversation.svelte';
import ChatToasts from './chat-toasts.test-harness.svelte';
import { AGENT, bureau, CONTEXT, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const RUNNER = {
  ...AGENT,
  name: 'tool-runner',
  displayName: 'tool-runner',
  media: { modalities: {}, mimeFamilies: [], mediaLimits: [] },
};
const SONNET = {
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  displayName: 'Claude Sonnet 5.5',
};

const provider = (hasKey: boolean, connected = hasKey) =>
  Response.json({
    configurationRevision: null,
    providers: [{ name: 'anthropic', configured: true, hasKey, connected }],
    catalog: [],
    models: [],
  } satisfies ProvidersSnapshot);

type Answers = Record<string, (params: Record<string, unknown>) => unknown>;

/** Serves a chat whose thread is `messages`; a thread with no run to join answers the way a finished one does. */
function serve(
  messages: readonly Record<string, unknown>[],
  options: {
    hasKey?: boolean;
    /** Whether the provider can be called; its key when left out. */
    connected?: boolean;
    context?: Record<string, unknown>;
    answers?: Answers;
  } = {},
) {
  const served = bureau(
    {
      'bureau.agents.list': () => ({ agents: [RUNNER, AGENT] }),
      'bureau.agents.models': () => ({ selectable: true, models: [SONNET], default: SONNET }),
      'bureau.contexts.get': () => ({
        ...CONTEXT,
        agentName: 'tool-runner',
        configVersion: 1,
        ...options.context,
      }),
      'bureau.contexts.window': () => ({
        maxTokens: 200_000,
        usedEstimated: 76_000,
        usedReported: null,
        categories: [],
      }),
      'bureau.tasks.list': () => ({ tasks: [], nextPageToken: null }),
      'bureau.reviews.list': () => ({ reviews: [] }),
      ...options.answers,
    },
    (url) => {
      if (url.endsWith('/host/providers'))
        return provider(options.hasKey ?? true, options.connected);
      if (url.endsWith('/messages')) return Response.json({ threadId: 'session-1', messages });
      if (!url.includes('/threads/')) return undefined;
      return new Response(
        `data: ${JSON.stringify({ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  );
  restore = served.restore;
  landAt('/chats/session-1');
  return served;
}

function mount(agentName = 'tool-runner') {
  return render(QueryPage, {
    props: {
      page: ChatConversation,
      pageProps: { sessionId: 'session-1', title: 'Plan the week', agentName },
      client: createQueryClient(),
    },
  } as never);
}

const notes = (container: HTMLElement) => [...container.querySelectorAll('.chat-note')];

describe('a chat the server ended when it restarted (19b, 19c)', () => {
  const BILLING = [{ id: 'user-1', role: 'user', content: 'Rename the billing tables' }] as Record<
    string,
    unknown
  >[];
  const ended = { endReason: 'host-stopped' };
  const canceled = (): unknown => ({
    tasks: [
      {
        ...tasksOf('failed-partway')[0],
        id: 'run-billing',
        contextId: 'session-1',
        status: 'canceled',
        finishReason: 'aborted',
        statusMessage: null,
      },
    ],
    nextPageToken: null,
  });

  // The design review of 38cbd2dec, note 2: the ended chat kept the old status line while every
  // other stop is Chat's alert on the turn. It is that alert, saying why, with no actions.
  test('keeps the partial reply and says under it, in the turn’s alert, that the server restarted and the chat cannot continue', async () => {
    serve(billingThreadWithPartialReply(BILLING), {
      context: ended,
      answers: { 'bureau.tasks.list': canceled },
    });
    const { container, findByText } = mount();

    expect(await findByText(ENDED_PARTIAL_REPLY)).not.toBeNull();
    const alert = () => container.querySelector('.chat-turn-outcome[data-kind="stopped"]');
    await waitFor(() => expect(alert() === null).toBe(false));
    expect(alert()?.querySelector('.chat-turn-stop-reason')?.textContent?.trim()).toBe(
      CHAT_COPY.stopLine.ended,
    );
    expect(alert()?.querySelector('svg.lucide-info')).not.toBeNull();
    // It replaces the plain "Stopped" line the canceled run left, and offers no way to go on.
    expect(notes(container)).toHaveLength(0);
    expect(container.textContent).not.toContain('The run was stopped.');
    expect(alert()?.querySelector('button')).toBeNull();
  });

  test('draws no strip of runs: the alert already says why', async () => {
    serve(billingThreadWithPartialReply(BILLING), {
      context: ended,
      answers: { 'bureau.tasks.list': canceled },
    });
    const { container, findByText } = mount();

    await findByText(ENDED_PARTIAL_REPLY);
    await waitFor(() =>
      expect(container.querySelector('.chat-turn-outcome[data-kind="stopped"]') === null).toBe(
        false,
      ),
    );
    expect(container.querySelector('.weft-chat-strip')).toBeNull();
  });
});

// COR-2438 AC1, COR-2440 AC2 (board row A3): approvals that wait together in one turn are one
// bordered group of compact rows under how many wait, each deciding its own approval.
describe('a turn that waits on several approvals at once (A3)', () => {
  const groupOf = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('.cinder-approval-group');
  const rowsOf = (container: HTMLElement) =>
    [...(groupOf(container)?.querySelectorAll<HTMLElement>('[data-approval-row]') ?? [])].map(
      (row) => row.querySelector('.cinder-approval-card')?.getAttribute('data-cinder-layout'),
    );

  test('draws two waiting approvals as one group of compact rows, each with its own Approve', async () => {
    serve(approvalBatchMessages(false), { context: { activity: 'awaiting-input' } });
    const { container } = mount();

    await waitFor(() => expect(groupOf(container) === null).toBe(false));
    expect(groupOf(container)?.textContent).toContain('2 approvals waiting');
    expect(rowsOf(container)).toEqual(['row', 'row']);
    expect(within(groupOf(container)!).getAllByRole('button', { name: 'Approve' })).toHaveLength(2);
    // No approval of the batch is drawn on its own under its call as well.
    expect(container.querySelector('[data-cinder-layout="decision"]')).toBeNull();
  });

  test('keeps a decided approval as a receipt row among the two still waiting', async () => {
    serve(approvalBatchMessages(true), { context: { activity: 'awaiting-input' } });
    const { container } = mount();

    await waitFor(() => expect(groupOf(container) === null).toBe(false));
    expect(groupOf(container)?.textContent).toContain('2 approvals waiting');
    expect(rowsOf(container)).toEqual(['row', 'row', 'row']);
    expect(within(groupOf(container)!).getAllByRole('button', { name: 'Approve' })).toHaveLength(2);
  });
});

describe('a chat waiting on an approval with no provider connected (19h)', () => {
  const messages = heldByPluginMessages();

  test('keeps Approve and Deny enabled, and leaves the Connect prompt to the blocked row alone (COR-2327 N4)', async () => {
    serve(messages, { hasKey: false, connected: false });
    const { container, findByRole } = mount();

    const approve = await findByRole('button', { name: 'Approve' });
    expect(approve.getAttribute('aria-disabled')).not.toBe('true');
    expect((approve as HTMLButtonElement).disabled).toBe(false);
    const deny = await findByRole('button', { name: 'Deny' });
    expect(deny.getAttribute('aria-disabled')).not.toBe('true');
    // The composer's blocked row says Connect a model provider, with the way to connect one, so
    // the approval does not say it again.
    await waitFor(() =>
      expect(
        container.querySelector('[data-chat-composer-status="blocked"]')?.textContent,
      ).toContain('Connect a model provider'),
    );
    expect(container.querySelector('.weft-chat-approval__provider-note')).toBeNull();
    expect(container.textContent).not.toContain('continues once a provider is connected');
  });

  test('says nothing about a provider when one is connected', async () => {
    serve(messages, { hasKey: true, connected: true });
    const { container, findByRole } = mount();

    await findByRole('button', { name: 'Approve' });
    expect(container.querySelector('.weft-chat-approval__provider-note')).toBeNull();
  });
});

describe('an approval of an agent a disabled plugin holds back (19k, 20f)', () => {
  const unavailable = {
    'bureau.agents.definitions.get': () => ({
      id: 'demo:release-helper',
      source: 'code',
      state: 'unavailable',
      unavailable: { code: 'plugin-disabled', message: 'Plugin Demo is disabled' },
      name: 'release-helper',
      description: null,
      a2a: false,
      hash: null,
      problem: null,
      definition: null,
      codeDefinition: null,
    }),
  };

  test('reads Unavailable with its reason, the input, and no Deny or Approve', async () => {
    serve(heldByPluginMessages(), {
      context: { agentName: 'demo:release-helper' },
      answers: unavailable,
    });
    const { container, findByText, queryByRole } = mount('demo:release-helper');

    expect(await findByText(HELD_BY_PLUGIN_REASON)).not.toBeNull();
    const card = container.querySelector('.cinder-approval-card')!;
    expect(card.getAttribute('data-cinder-state')).toBe('unavailable');
    expect(card.querySelector('.cinder-approval-card__state-word')?.textContent?.trim()).toBe(
      'Unavailable',
    );
    expect(queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(queryByRole('button', { name: 'Deny' })).toBeNull();
    // The composer is the one blocked row that names the agent and the plugin.
    await waitFor(() =>
      expect(
        container.querySelector('[data-chat-composer-status="blocked"]')?.textContent,
      ).toContain('Release helper isn’t available. Enable the Demo plugin to continue.'),
    );
  });

  test('says nothing of a provider under an approval nobody can answer', async () => {
    serve(heldByPluginMessages(), {
      hasKey: false,
      connected: false,
      context: { agentName: 'demo:release-helper' },
      answers: unavailable,
    });
    const { container, findByText } = mount('demo:release-helper');

    await findByText(HELD_BY_PLUGIN_REASON);
    expect(container.querySelector('.weft-chat-approval__provider-note')).toBeNull();
  });
});

describe('a reply that failed partway (19p)', () => {
  test('keeps the partial text, then the failed turn’s alert with its cause and Retry, and reads Failed', async () => {
    serve(failedPartwayMessages(), {
      answers: {
        'bureau.tasks.list': () => ({
          tasks: tasksOf('failed-partway').map((task) => ({ ...task, contextId: 'session-1' })),
          nextPageToken: null,
        }),
      },
    });
    const { container, findByText, findByRole } = mount();

    expect(await findByText(/I can refund the full amount to the$/)).not.toBeNull();
    // COR-2437: the run's failure is the turn's own state, so Chat draws it on the turn, and the
    // status line that said it is not drawn a second time.
    const alert = await findByText(
      `The reply stopped partway: ${FAILED_PARTWAY_CAUSE.replace(/\.$/, '').replace(/^T/, 't')}.`,
      { exact: false },
    );
    expect(alert.closest('.chat-turn-outcome')?.getAttribute('data-kind')).toBe('failed');
    expect(container.querySelector('.chat-note[data-failed]') === null).toBe(true);
    expect(await findByRole('button', { name: 'Retry' })).not.toBeNull();
    // The provider dropped the connection (finish reason `error`): the turn can go on (COR-2437).
    expect(await findByRole('button', { name: 'Continue' })).not.toBeNull();
    await waitFor(() =>
      expect(container.querySelector('[data-testid="chat-header"]')?.textContent).toContain(
        'Failed',
      ),
    );
  });
});

describe('a reply the person stopped (COR-2437)', () => {
  const BILLING = [{ id: 'user-1', role: 'user', content: 'Rename the billing tables' }] as Record<
    string,
    unknown
  >[];
  const canceled = (): unknown => ({
    tasks: [
      {
        ...tasksOf('failed-partway')[0],
        id: 'run-billing',
        contextId: 'session-1',
        status: 'canceled',
        finishReason: 'aborted',
        statusMessage: null,
      },
    ],
    nextPageToken: null,
  });

  test('is Stopped on the turn with Discard and Continue, Continue last, and no status line under it', async () => {
    serve(billingThreadWithPartialReply(BILLING), { answers: { 'bureau.tasks.list': canceled } });
    const { container, findByText, findByRole } = mount();

    expect(await findByText(ENDED_PARTIAL_REPLY)).not.toBeNull();
    const discard = await findByRole('button', { name: 'Discard' });
    const outcome = discard.closest('.chat-turn-outcome');
    expect(outcome?.getAttribute('data-kind')).toBe('stopped');
    expect(
      [...(outcome?.querySelectorAll('button') ?? [])].map((button) => button.textContent?.trim()),
    ).toEqual(['Discard', 'Continue']);
    expect(container.textContent).not.toContain('The run was stopped.');
  });

  // AC3 (COR-2437): Continue goes on from the stopped reply through the Bureau, by its run, with
  // no message from the person, and the page joins the run that goes on.
  test('Continue resumes the turn through the Bureau by its run, and the turn reads on from the partial reply', async () => {
    const thread = billingThreadWithPartialReply(BILLING);
    const CONTINUED = 'the payments table, and every query still reads them.';
    const served = serve(thread, {
      answers: {
        'bureau.tasks.list': canceled,
        'bureau.contexts.resumeturn': (params) => {
          // The continuation run went on and finished: the thread read again holds its reply. Its
          // hidden continuation row is never served (the AG-UI messages leave hidden rows out).
          thread.push({ id: 'run-continued:step:0', role: 'assistant', content: CONTINUED });
          return { contextId: 'session-1', runId: 'run-continued', resumedRunId: params['runId'] };
        },
      },
    });
    const { container, findByText, findByRole } = mount();
    expect(await findByText(ENDED_PARTIAL_REPLY)).not.toBeNull();

    await fireEvent.click(await findByRole('button', { name: 'Continue' }));

    expect(await findByText(CONTINUED)).not.toBeNull();
    const call = served.calls.find((entry) => entry.method === 'bureau.contexts.resumeturn');
    expect(call?.params).toMatchObject({ contextId: 'session-1', runId: 'run-billing' });
    expect(String(call?.params['commandId'])).toMatch(/^resume:/);
    // No message of the person's was sent, and the partial reply stays.
    expect(served.calls.some((entry) => entry.method === 'bureau.contexts.input')).toBe(false);
    expect(container.textContent).toContain(ENDED_PARTIAL_REPLY);
  });

  test('Discard removes the reply through the Bureau by its run, and the turn reads as the person’s message alone', async () => {
    const thread = billingThreadWithPartialReply(BILLING);
    const served = serve(thread, {
      answers: {
        'bureau.tasks.list': canceled,
        'bureau.contexts.discardturn': (params) => {
          // The Bureau removed the run's rows: the thread read again holds the person's message.
          thread.splice(BILLING.length);
          return { contextId: 'session-1', runId: params['runId'], removed: 1, revision: 4 };
        },
      },
    });
    const { container, findByText, findByRole } = mount();
    expect(await findByText(ENDED_PARTIAL_REPLY)).not.toBeNull();

    await fireEvent.click(await findByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(container.textContent?.includes(ENDED_PARTIAL_REPLY)).toBe(false));
    const call = served.calls.find((entry) => entry.method === 'bureau.contexts.discardturn');
    expect(call?.params).toMatchObject({ contextId: 'session-1', runId: 'run-billing' });
    expect(String(call?.params['commandId'])).toMatch(/^discard:/);
    expect(container.textContent).toContain('Rename the billing tables');
    expect(container.querySelector('.chat-turn-outcome') === null).toBe(true);
    // The run's task still says it was stopped, so the person's message keeps the plain line that
    // says so, which tells why it has no reply, and offers nothing more to do.
    expect(
      notes(container).map((note) => note.textContent?.replaceAll(/\s+/g, ' ').trim()),
    ).toEqual(['Stopped The run was stopped.']);
    expect(notes(container)[0]?.querySelector('button') === null).toBe(true);
  });
});

// COR-2437 review: a command the Bureau answered as in doubt stays in doubt for as long as it is
// sent again, so the page sends a new one; it keeps a command only after a definite refusal of it.
describe('the command a Discard or a Continue is sent under', () => {
  const BILLING = [{ id: 'user-1', role: 'user', content: 'Rename the billing tables' }] as Record<
    string,
    unknown
  >[];
  const canceled = (): unknown => ({
    tasks: [
      {
        ...tasksOf('failed-partway')[0],
        id: 'run-billing',
        contextId: 'session-1',
        status: 'canceled',
        finishReason: 'aborted',
        statusMessage: null,
      },
    ],
    nextPageToken: null,
  });

  for (const [method, button] of [
    ['bureau.contexts.discardturn', 'Discard'],
    ['bureau.contexts.resumeturn', 'Continue'],
  ] as const) {
    test(`${button} sends a new command after an answer of in doubt, and the same one after a definite refusal`, async () => {
      const answers = [
        new StubFault('Conflict', 409, 'in doubt', { reason: 'command-in-doubt' }),
        new StubFault('Conflict', 409, 'refused', { reason: 'history-changed' }),
        new StubFault('Conflict', 409, 'refused', { reason: 'history-changed' }),
      ];
      const served = serve(billingThreadWithPartialReply(BILLING), {
        answers: {
          'bureau.tasks.list': canceled,
          [method]: () => {
            throw answers.shift() ?? new Error('no more answers');
          },
        },
      });
      // A refused Discard or Continue says so in a toast, so the shell's toast host is beside it.
      const { findByRole } = render(ChatToasts, {
        props: {
          page: ChatConversation,
          pageProps: { sessionId: 'session-1', title: 'Plan the week', agentName: 'tool-runner' },
          client: createQueryClient(),
        },
      } as never);
      const commands = () =>
        served.calls
          .filter((entry) => entry.method === method)
          .map((entry) => String(entry.params['commandId']));

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await fireEvent.click(await findByRole('button', { name: button }));
        await waitFor(() => expect(commands().length).toBe(attempt));
      }

      const [first, second, third] = commands();
      expect(second).not.toBe(first);
      expect(third).toBe(second);
    });
  }
});

describe('an existing chat with no message yet (COR-2285 V1)', () => {
  const withExamples = {
    'bureau.agents.list': () => ({
      agents: [
        { ...RUNNER, description: 'Runs the tools you name.', examples: ['List the tools'] },
        AGENT,
      ],
    }),
  };

  test('is Chat’s first-use state with the agent’s description and its prompts, which send', async () => {
    serve([], { answers: withExamples });
    const { container, findByRole, findByText } = mount();

    await findByRole('heading', { level: 2, name: CHAT_COPY.emptyTranscript.title });
    expect(await findByText('Runs the tools you name.')).not.toBeNull();
    const prompts = await findByRole('group', { name: 'Suggested prompts' });
    const prompt = within(prompts).getByRole('button', { name: 'List the tools' });

    await fireEvent.click(prompt);

    // The prompt is sent as the person's first message: it is on its row, and the box stays empty.
    await waitFor(() =>
      expect(container.querySelector('[data-message-role="user"]')?.textContent).toContain(
        'List the tools',
      ),
    );
    expect(container.querySelector('.chat-empty')).toBeNull();
    expect(container.querySelector('textarea')?.value).toBe('');
  });

  test('with no provider is Chat’s Connect a model provider state, and offers no prompt (V4)', async () => {
    serve([], { hasKey: false, answers: withExamples });
    const { container, findByRole } = mount();

    const state = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('[data-chat-availability="unconfigured"]');
      if (found === null) throw new Error('The unconfigured state is not drawn yet.');
      return found;
    });
    expect(state.textContent).toContain('Connect a model provider');
    // One person runs Interborough: there is no admin to wait for (COR-2327 N1).
    expect(state.textContent).toContain(CHAT_COPY.composer.unconfiguredDescription);
    expect(state.textContent).not.toContain('admin');
    expect(await findByRole('button', { name: 'Connect provider' })).not.toBeNull();
    expect(container.querySelector('[aria-label="Suggested prompts"]')).toBeNull();
  });
});

describe('a chat whose history has not arrived yet (COR-2327 B3)', () => {
  const withExamples = {
    'bureau.agents.list': () => ({
      agents: [
        { ...RUNNER, description: 'Runs the tools you name.', examples: ['List the tools'] },
        AGENT,
      ],
    }),
  };

  /** Serves the chat as `serve` does, with its history held until `release` is called. */
  function serveHeld(messages: readonly Record<string, unknown>[], hasKey: boolean) {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const served = bureau(
      {
        'bureau.agents.list': withExamples['bureau.agents.list'],
        'bureau.agents.models': () => ({ selectable: true, models: [SONNET], default: SONNET }),
        'bureau.contexts.get': () => ({ ...CONTEXT, agentName: 'tool-runner', configVersion: 1 }),
        'bureau.contexts.window': () => ({
          maxTokens: 200_000,
          usedEstimated: 76_000,
          usedReported: null,
          categories: [],
        }),
        'bureau.tasks.list': () => ({ tasks: [], nextPageToken: null }),
        'bureau.reviews.list': () => ({ reviews: [] }),
      },
      (url) => {
        if (url.endsWith('/host/providers')) return provider(hasKey);
        if (url.endsWith('/messages')) {
          return held.then(() => Response.json({ threadId: 'session-1', messages }));
        }
        if (!url.includes('/threads/')) return undefined;
        return new Response(
          `data: ${JSON.stringify({ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    );
    restore = served.restore;
    landAt('/chats/session-1');
    return { ...served, release: () => release() };
  }

  /** Mounts the chat with a query client the test can read. */
  function mountWithClient() {
    const client = createQueryClient();
    const view = render(QueryPage, {
      props: {
        page: ChatConversation,
        pageProps: { sessionId: 'session-1', title: 'Plan the week', agentName: 'tool-runner' },
        client,
      },
    } as never);
    return { ...view, client };
  }

  /**
   * Waits until the page holds the agents (with their prompts) and the providers, so every empty
   * state could show, and the transcript is drawn loading.
   */
  async function settledAround(client: QueryClient, container: HTMLElement) {
    await waitFor(() => {
      expect(client.getQueryState(queryKeys.agents.list())?.status).toBe('success');
      expect(client.getQueryState(queryKeys.hostProviders())?.status).toBe('success');
      expect(container.querySelector('[data-chat-availability="loading"]')).not.toBeNull();
    });
  }

  for (const hasKey of [true, false]) {
    test(`shows the transcript loading, with no empty state and no prompt, while it is read (provider ${hasKey ? 'connected' : 'missing'})`, async () => {
      const served = serveHeld(heldByPluginMessages(), hasKey);
      const { container, queryByRole, findByRole, client } = mountWithClient();

      await settledAround(client, container);
      expect(container.querySelector('.chat-empty')).toBeNull();
      expect(container.querySelector('[data-chat-availability="unconfigured"]')).toBeNull();
      expect(container.textContent).not.toContain(CHAT_COPY.emptyTranscript.title);
      expect(container.textContent).not.toContain('Connect a model provider');
      expect(queryByRole('button', { name: 'List the tools' })).toBeNull();
      expect(container.querySelector('[aria-label="Suggested prompts"]')).toBeNull();
      // The editor stays, for what the person types while the chat is read.
      expect(container.querySelector('textarea')).not.toBeNull();

      served.release();

      // The history arrives: the waiting approval is on screen, and the loading state is gone.
      expect(await findByRole('button', { name: 'Approve' })).not.toBeNull();
      await waitFor(() =>
        expect(container.querySelector('[data-chat-availability="loading"]') === null).toBe(true),
      );
      expect(container.querySelector('.chat-empty')).toBeNull();
      expect(served.calls.length).toBeGreaterThan(0);
    });
  }

  test('a first read that fails says so with Reconnect, keeps the composer, and offers no prompt', async () => {
    restore = bureau(
      {
        'bureau.agents.list': withExamples['bureau.agents.list'],
        'bureau.agents.models': () => ({ selectable: true, models: [SONNET], default: SONNET }),
        'bureau.contexts.get': () => ({ ...CONTEXT, agentName: 'tool-runner', configVersion: 1 }),
        'bureau.contexts.window': () => ({
          maxTokens: 200_000,
          usedEstimated: 76_000,
          usedReported: null,
          categories: [],
        }),
        'bureau.tasks.list': () => ({ tasks: [], nextPageToken: null }),
        'bureau.reviews.list': () => ({ reviews: [] }),
      },
      (url) => {
        if (url.endsWith('/host/providers')) return provider(true);
        // The thread cannot be read, in a way a retry cannot change: the session gives up at once.
        if (url.includes('/threads/')) return new Response('', { status: 403 });
        return undefined;
      },
    ).restore;
    landAt('/chats/session-1');
    const { container, findByRole, client } = mountWithClient();

    expect(await findByRole('button', { name: CHAT_COPY.disconnected.reconnect })).not.toBeNull();
    await waitFor(() =>
      expect(client.getQueryState(queryKeys.agents.list())?.status).toBe('success'),
    );
    // The read settled, though it failed: no skeleton behind the alert, and the composer stays.
    expect(container.querySelector('[data-chat-availability="loading"]') === null).toBe(true);
    expect(container.querySelector('textarea')).not.toBeNull();
    // The chat may hold history the page could not read, so nothing offers to send a prompt.
    expect(container.querySelector('[aria-label="Suggested prompts"]')).toBeNull();
  });

  test('a first read that fails offers no prompt while it is tried again, and offers them once a retry reads the empty thread', async () => {
    let failedReads = 0;
    restore = bureau(
      {
        'bureau.agents.list': withExamples['bureau.agents.list'],
        'bureau.agents.models': () => ({ selectable: true, models: [SONNET], default: SONNET }),
        'bureau.contexts.get': () => ({ ...CONTEXT, agentName: 'tool-runner', configVersion: 1 }),
        'bureau.contexts.window': () => ({
          maxTokens: 200_000,
          usedEstimated: 76_000,
          usedReported: null,
          categories: [],
        }),
        'bureau.tasks.list': () => ({ tasks: [], nextPageToken: null }),
        'bureau.reviews.list': () => ({ reviews: [] }),
      },
      (url) => {
        if (url.endsWith('/host/providers')) return provider(true);
        if (url.endsWith('/messages'))
          return Response.json({ threadId: 'session-1', messages: [] });
        if (!url.includes('/threads/')) return undefined;
        // The first read cannot reach the server; the retry that follows can.
        if (failedReads === 0) {
          failedReads += 1;
          throw new TypeError('Failed to fetch');
        }
        return new Response(
          `data: ${JSON.stringify({ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    ).restore;
    landAt('/chats/session-1');
    const { container, findByText, findByRole, client } = mountWithClient();

    expect(await findByText('Failed to fetch')).not.toBeNull();
    await waitFor(() =>
      expect(client.getQueryState(queryKeys.agents.list())?.status).toBe('success'),
    );
    // The read failed and is being tried again: the chat may hold history, so no prompt is offered.
    expect(container.querySelector('[aria-label="Suggested prompts"]')).toBeNull();

    // The retry reads the thread, which is empty: now the first-use prompts are offered.
    expect(await findByRole('group', { name: 'Suggested prompts' })).not.toBeNull();
  });

  test('an empty thread is the first-use state once its read has settled', async () => {
    const served = serveHeld([], true);
    const { container, findByRole, client } = mountWithClient();

    await settledAround(client, container);
    expect(container.querySelector('[aria-label="Suggested prompts"]')).toBeNull();

    served.release();

    await findByRole('heading', { level: 2, name: CHAT_COPY.emptyTranscript.title });
    expect(await findByRole('group', { name: 'Suggested prompts' })).not.toBeNull();
  });
});

describe('a turn that ends on a tool call (20h)', () => {
  test('closes the rail with the run finished and no reply, and reads Done', async () => {
    serve(endedOnToolCallMessages(), {
      answers: {
        'bureau.tasks.list': () => ({
          tasks: tasksOf('ended-on-tool-call').map((task) => ({
            ...task,
            contextId: 'session-1',
          })),
          nextPageToken: null,
        }),
      },
    });
    const { container, findByText } = mount();

    expect(await findByText(CHAT_COPY.tools.runFinishedNoReply)).not.toBeNull();
    await waitFor(() =>
      expect(container.querySelector('[data-testid="chat-header"]')?.textContent).toContain('Done'),
    );
    expect(container.querySelector('.chat-note[data-failed]')).toBeNull();
  });
});
