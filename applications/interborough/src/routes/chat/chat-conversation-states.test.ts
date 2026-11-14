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
import type { ProvidersSnapshot } from '../../lib/host-providers.ts';
import { createQueryClient, queryKeys } from '../../lib/query.ts';
import ChatConversation from './chat-conversation.svelte';
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

const provider = (hasKey: boolean) =>
  Response.json({
    configurationRevision: null,
    providers: [{ name: 'anthropic', configured: true, hasKey }],
    catalog: [],
    models: [],
  } satisfies ProvidersSnapshot);

type Answers = Record<string, (params: Record<string, unknown>) => unknown>;

/** Serves a chat whose thread is `messages`; a thread with no run to join answers the way a finished one does. */
function serve(
  messages: readonly Record<string, unknown>[],
  options: { hasKey?: boolean; context?: Record<string, unknown>; answers?: Answers } = {},
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
      if (url.endsWith('/host/providers')) return provider(options.hasKey ?? true);
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

  test('keeps the partial reply and says under it that the server restarted and the chat cannot continue, with an info glyph', async () => {
    serve(billingThreadWithPartialReply(BILLING), {
      context: ended,
      answers: { 'bureau.tasks.list': canceled },
    });
    const { container, findByText } = mount();

    expect(await findByText(ENDED_PARTIAL_REPLY)).not.toBeNull();
    await waitFor(() =>
      expect(container.querySelector('.chat-note[data-notice]')?.textContent?.trim()).toBe(
        CHAT_COPY.stopLine.ended,
      ),
    );
    const line = container.querySelector('.chat-note[data-notice]')!;
    expect(line.querySelector('svg.lucide-info')).not.toBeNull();
    // It replaces the plain "Stopped" line the canceled run left, and offers no Retry.
    expect(notes(container)).toHaveLength(1);
    expect(container.textContent).not.toContain('The run was stopped.');
    expect(line.querySelector('button')).toBeNull();
  });

  test('draws no strip of runs: the status line already says why', async () => {
    serve(billingThreadWithPartialReply(BILLING), {
      context: ended,
      answers: { 'bureau.tasks.list': canceled },
    });
    const { container, findByText } = mount();

    await findByText(ENDED_PARTIAL_REPLY);
    await waitFor(() => expect(container.querySelector('.chat-note[data-notice]')).not.toBeNull());
    expect(container.querySelector('.weft-chat-strip')).toBeNull();
  });
});

describe('a chat waiting on an approval with no provider connected (19h)', () => {
  const messages = heldByPluginMessages();

  test('keeps Approve and Deny enabled, and leaves the Connect prompt to the blocked row alone (COR-2327 N4)', async () => {
    serve(messages, { hasKey: false });
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
    serve(messages, { hasKey: true });
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
      context: { agentName: 'demo:release-helper' },
      answers: unavailable,
    });
    const { container, findByText } = mount('demo:release-helper');

    await findByText(HELD_BY_PLUGIN_REASON);
    expect(container.querySelector('.weft-chat-approval__provider-note')).toBeNull();
  });
});

describe('a reply that failed partway (19p)', () => {
  test('keeps the partial text, then the status line with Retry, and reads Failed', async () => {
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
    const line = await findByText(
      `The reply stopped partway: ${FAILED_PARTWAY_CAUSE.replace(/\.$/, '').replace(/^T/, 't')}.`,
    );
    expect(line.closest('.chat-note')?.hasAttribute('data-failed')).toBe(true);
    expect(await findByRole('button', { name: 'Retry' })).not.toBeNull();
    await waitFor(() =>
      expect(container.querySelector('[data-testid="chat-header"]')?.textContent).toContain(
        'Failed',
      ),
    );
  });
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
