/**
 * The conversation page's composer, over a stubbed Bureau: its placeholder and hint, Stop in Send's
 * place with the steering line while the chat works, answer mode while a question waits, and the
 * blocked row that replaces the text box when no provider is connected, when the host stopped the
 * chat, and when the agent's plugin is disabled.
 */
import { quietFor } from '@lostgradient/testing/wait-until';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { ConnectionMonitor } from '../../app/connection.svelte.ts';
import { CHAT_COPY } from '../../app/copy/chat.ts';
import { restartProbing } from '../../app/restart/host-restart-flow.svelte.ts';
import type { ProvidersSnapshot } from '../../lib/host-providers.ts';
import { createQueryClient } from '../../lib/query.ts';
import { router } from '../../lib/router.svelte.ts';
import { installFakePluginHost } from '../settings/plugins/plugins-host.test-support.ts';
import ChatConversation from './chat-conversation.svelte';
import { AGENT, bureau, CONTEXT, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const COPY = CHAT_COPY.composer;
const SONNET = { provider: 'anthropic', model: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' };
const RUNNER = {
  ...AGENT,
  name: 'tool-runner',
  displayName: 'Tool runner',
  media: { modalities: {}, mimeFamilies: [], mediaLimits: [] },
};
const TURNS = [
  { id: 'u1', role: 'user', content: 'Question' },
  { id: 'a1', role: 'assistant', content: 'Answer' },
];

const provider = (hasKey: boolean, connected = hasKey) =>
  Response.json({
    configurationRevision: null,
    providers: [{ name: 'anthropic', configured: true, hasKey, connected }],
    catalog: [],
    models: [],
  } satisfies ProvidersSnapshot);

/** The stream the page joins: closed at once for an idle chat, held open for a run that is going. */
function thread(running: boolean) {
  return (url: string): Response | undefined => {
    if (url.endsWith('/messages')) return Response.json({ threadId: 'session-1', messages: TURNS });
    if (url.endsWith('/host/providers')) return undefined;
    if (!url.includes('/threads/')) return undefined;
    const frames = running
      ? [
          { type: 'RUN_STARTED', threadId: 'session-1', runId: 'run-1' },
          { type: 'MESSAGES_SNAPSHOT', messages: TURNS },
        ]
      : [{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }];
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const frame of frames) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
          }
          if (!running) controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
}

type Answers = Record<string, (params: Record<string, unknown>) => unknown>;

function serve(
  answers: Answers = {},
  options: {
    running?: boolean;
    hasKey?: boolean;
    /** Whether the provider can be called; its key when left out. A keyless provider is `true` with no key. */
    connected?: boolean;
    agent?: typeof RUNNER;
  } = {},
) {
  const running = options.running ?? false;
  const handler = thread(running);
  const served = bureau(
    {
      'bureau.agents.list': () => ({ agents: [options.agent ?? RUNNER, AGENT] }),
      'bureau.agents.models': () => ({ selectable: true, models: [SONNET], default: SONNET }),
      'bureau.contexts.get': () => ({ ...CONTEXT, agentName: 'tool-runner', configVersion: 1 }),
      'bureau.contexts.window': () => ({
        maxTokens: 200_000,
        usedEstimated: 76_000,
        usedReported: null,
        categories: [],
      }),
      'bureau.tasks.list': () => ({ tasks: [], nextOffset: null }),
      ...answers,
    },
    (url) =>
      url.endsWith('/host/providers')
        ? provider(options.hasKey ?? true, options.connected)
        : handler(url),
  );
  restore = served.restore;
  landAt('/chats/session-1');
  return served;
}

function mount(agentName = 'tool-runner', isNew = false) {
  return render(QueryPage, {
    props: {
      page: ChatConversation,
      pageProps: { sessionId: 'session-1', title: 'Plan the week', agentName, isNew },
      client: createQueryClient(),
    },
  } as never);
}

const row = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-chat-composer-status="blocked"]');
const status = (container: HTMLElement) =>
  container.querySelector('.chat-input-status')?.textContent?.trim();
const composer = (container: HTMLElement) =>
  container.querySelector<HTMLTextAreaElement>('textarea.chat-input-editor');

describe('the live composer', () => {
  test('is addressed to the agent by its name, with the hint under it and a quiet disabled Send', async () => {
    serve();
    const { container } = mount();

    await waitFor(() => expect(composer(container)?.placeholder).toBe('Message Tool runner…'));
    expect(container.querySelector('.chat-input-hint')?.textContent).toBe(
      'Enter to send. Shift and Enter for a new line.',
    );
    const send = container.querySelector<HTMLButtonElement>('[data-chat-send]')!;
    expect(send.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(send.disabled).toBe(true);
    expect(row(container)).toBeNull();
  });

  test('keeps Stop in Send’s place while the chat works, and says a message now steers the run', async () => {
    serve({}, { running: true });
    const { container } = mount();

    await waitFor(() =>
      expect(container.querySelector('button[aria-label="Stop generating"]')).not.toBeNull(),
    );
    expect(container.querySelector('button[aria-label="Send message"]')).toBeNull();
    await waitFor(() => expect(status(container)).toBe('A message now steers the run.'));
    expect(container.querySelector('.chat-input-hint')).toBeNull();
  });
});

describe('a blocked composer', () => {
  test('keeps a chat with messages readable with no provider, and Chat replaces only the text box with the Connect provider row (COR-2285 V4)', async () => {
    serve({}, { hasKey: false, connected: false });
    const { container } = mount();

    await waitFor(() => expect(row(container)).not.toBeNull());
    expect(row(container)?.textContent).toContain('Connect a model provider');
    const buttons = [...row(container)!.querySelectorAll('a, button')];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Connect provider']);
    expect(buttons[0]?.getAttribute('data-cinder-variant')).toBe('primary');
    expect(composer(container)).toBeNull();
    // The transcript is still there, and nothing stands in its place.
    expect(container.querySelector('[data-chat-availability]')).toBeNull();
    expect(container.querySelector<HTMLElement>('.chat-timeline')?.style.display).not.toBe('none');
    await fireEvent.click(buttons[0] as HTMLElement);
    expect(router.pathname).toBe('/settings/models');
  });

  test('replaces the text box with one row while the server does not answer, with no second retry', async () => {
    serve();
    const monitor = new ConnectionMonitor({ probe: () => new Promise<never>(() => undefined) });
    monitor.reportUnreachable();
    try {
      const { container } = render(QueryPage, {
        props: {
          page: ChatConversation,
          pageProps: { sessionId: 'session-1', title: 'Plan the week', agentName: 'tool-runner' },
          client: createQueryClient(),
          connection: monitor,
        },
      } as never);

      await waitFor(() => expect(row(container)).not.toBeNull());
      expect(row(container)?.textContent).toContain(COPY.unreachable);
      expect(composer(container)).toBeNull();
      expect([...row(container)!.querySelectorAll('a, button')]).toEqual([]);
    } finally {
      monitor.dispose();
    }
  });

  test('on a new chat with no provider is Chat’s Connect a model provider state, in place of the welcome and the composer (COR-2285 V4)', async () => {
    serve({}, { hasKey: false, connected: false });
    const { container } = mount('tool-runner', true);

    await waitFor(() =>
      expect(container.querySelector('[data-chat-availability="unconfigured"]')).not.toBeNull(),
    );
    const state = container.querySelector<HTMLElement>('[data-chat-availability="unconfigured"]')!;
    expect(state.textContent).toContain('Connect a model provider');
    const connect = [...state.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Connect provider',
    );
    expect(connect?.getAttribute('data-cinder-variant')).toBe('primary');
    expect(container.querySelector<HTMLElement>('.chat-input-wrapper')?.style.display).toBe('none');
    expect(row(container)).toBeNull();
  });

  test('leaves a scripted agent’s composer alone, since it needs no provider', async () => {
    serve(
      {
        'bureau.agents.models': () => ({ selectable: false, models: [], default: null }),
        'bureau.agents.list': () => ({ agents: [{ ...AGENT, media: null }] }),
        'bureau.contexts.get': () => ({ ...CONTEXT, configVersion: 1 }),
      },
      { hasKey: false, connected: false },
    );
    const { container } = mount('assistant');

    await waitFor(() => expect(composer(container)?.placeholder).toBe('Message Assistant…'));
    // Give the provider answer time to arrive: the row never appears.
    await waitFor(() => expect(container.querySelector('#weft-chat-permission')).not.toBeNull());
    expect(row(container)).toBeNull();
  });

  test('is not drawn once a provider holds a key', async () => {
    serve({}, { hasKey: true, connected: true });
    const { container } = mount();

    await waitFor(() => expect(composer(container)).not.toBeNull());
    expect(row(container)).toBeNull();
  });

  test('is not drawn when the only provider is keyless, which is connected with no key saved (COR-2414)', async () => {
    serve({}, { hasKey: false, connected: true });
    const { container } = mount();

    await waitFor(() => expect(composer(container)).not.toBeNull());
    // The provider answer is read in a later turn: a reader that took the keyless provider for
    // none would have replaced the composer with the blocked row by now.
    await quietFor(100);
    expect(composer(container)).not.toBeNull();
    expect(row(container)).toBeNull();
    expect(container.textContent).not.toContain(COPY.noProvider);
  });

  test('says the host stopped a chat when it restarted, with a New chat link', async () => {
    serve({
      'bureau.contexts.get': () => ({
        ...CONTEXT,
        agentName: 'tool-runner',
        configVersion: 1,
        endReason: 'host-stopped',
      }),
    });
    const { container } = mount();

    await waitFor(() => expect(row(container)?.textContent).toContain(COPY.ended));
    const link = row(container)!.querySelector('a')!;
    expect(link.textContent?.trim()).toBe(COPY.newChat);
    expect(link.getAttribute('href')).toBe('/chats/new');
    expect(composer(container)).toBeNull();
  });

  test('names the agent and its disabled plugin once, and Enable and restart opens a confirmation that names the effect on running work', async () => {
    serve({
      'bureau.agents.definitions.get': () => ({
        id: 'demo:release-helper',
        source: 'code',
        state: 'unavailable',
        unavailable: { code: 'plugin-disabled', message: 'Plugin Demo is disabled' },
        name: 'Release helper',
        description: null,
        a2a: false,
        hash: null,
        problem: null,
        definition: null,
        codeDefinition: null,
      }),
      'bureau.contexts.get': () => ({
        ...CONTEXT,
        agentName: 'demo:release-helper',
        configVersion: 1,
      }),
    });
    const { container, findByRole } = mount('demo:release-helper');

    await waitFor(() =>
      expect(row(container)?.textContent).toContain(
        'Release helper isn’t available. Enable the Demo plugin to continue.',
      ),
    );
    expect(composer(container)).toBeNull();

    await fireEvent.click(await findByRole('button', { name: COPY.enableAndRestart }));

    const dialog = await findByRole('dialog');
    expect(dialog.textContent).toContain('Enable the Demo plugin and restart?');
    expect(dialog.textContent).toContain(
      'Running work picks up where it stopped; reviews stay waiting.',
    );
    // The composer stays read-only until the person confirms.
    expect(composer(container)).toBeNull();
  });

  test('Enable and restart keeps the conversation on screen under the shared restart banner, which offers Retry now once the host stopped answering', async () => {
    const probing = { ...restartProbing };
    restartProbing.delayMs = 0;
    restartProbing.retryDelayMs = () => 60_000;
    serve({
      'bureau.agents.definitions.get': () => ({
        id: 'demo:release-helper',
        source: 'code',
        state: 'unavailable',
        unavailable: { code: 'plugin-disabled', message: 'Plugin Demo is disabled' },
        name: 'Release helper',
        description: null,
        a2a: false,
        hash: null,
        problem: null,
        definition: null,
        codeDefinition: null,
      }),
      'bureau.contexts.get': () => ({
        ...CONTEXT,
        agentName: 'demo:release-helper',
        configVersion: 1,
      }),
    });
    const host = installFakePluginHost([{ name: 'demo', enabled: false, contributions: [] }], {
      downFor: 1,
    });
    try {
      const { container, findByRole, findByTestId } = mount('demo:release-helper');
      await fireEvent.click(await findByRole('button', { name: COPY.enableAndRestart }));
      const dialog = await findByRole('dialog');
      await fireEvent.click(
        [...dialog.querySelectorAll('button')].find(
          (button) => button.textContent?.trim() === CHAT_COPY.composer.enableDialog.confirm,
        )!,
      );

      const banner = await findByTestId('chat-restart-banner');
      await waitFor(() => expect(banner.textContent).toContain('Retry now'));
      expect(container.querySelector('.weft-chat-surface')).not.toBeNull();
    } finally {
      host.restore();
      Object.assign(restartProbing, probing);
    }
  });
});
