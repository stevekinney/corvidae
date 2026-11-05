/**
 * The composer of a new chat, over a stubbed Bureau: the agent select at the top of the surface,
 * the choices made before the chat has a session (applied once the first message has started it),
 * the one Settings control a narrow composer folds them into, the formatting row, and the blocked
 * row of a chat started from Workflows that has no agent to write with.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { CHAT_COPY } from '../../app/copy.ts';
import { createQueryClient } from '../../lib/query.ts';
import ChatConversation from './chat-conversation.svelte';
import { chooseOption, optionLabels } from './listbox.test-support.ts';
import { AGENT, bureau, CONTEXT, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';

const SONNET = { provider: 'anthropic', model: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' };
const HAIKU = { provider: 'anthropic', model: 'claude-haiku-5', displayName: 'Claude Haiku 5' };
const RUNNER = {
  ...AGENT,
  name: 'tool-runner',
  displayName: 'Tool runner',
  media: { modalities: {}, mimeFamilies: [], mediaLimits: [] },
};

let restore: (() => void) | undefined;
let composerWidth = 900;
const originalRectangle = HTMLElement.prototype.getBoundingClientRect;
const originalResizeObserver = globalThis.ResizeObserver;

beforeEach(() => {
  composerWidth = 900;
  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    return { width: composerWidth, height: 0 } as DOMRect;
  };
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
  HTMLElement.prototype.getBoundingClientRect = originalRectangle;
  globalThis.ResizeObserver = originalResizeObserver;
});

const sse = (events: readonly unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

const provider = (hasKey: boolean) =>
  Response.json({
    providers: [{ name: 'anthropic', configured: true, hasKey }],
    catalog: [],
    models: [],
  });

interface Served {
  readonly steers: Array<Record<string, unknown>>;
  readonly runs: string[];
}

/** A Bureau with Tool runner (a model agent) and Assistant (scripted), and a first run that finishes. */
function serve(options: { hasKey?: boolean } = {}): Served {
  const steers: Array<Record<string, unknown>> = [];
  const runs: string[] = [];
  let version = 0;
  const served = bureau(
    {
      'bureau.agents.list': () => ({ agents: [RUNNER, AGENT] }),
      'bureau.agents.models': () => ({
        selectable: true,
        models: [SONNET, HAIKU],
        default: SONNET,
      }),
      'bureau.contexts.get': () => ({
        ...CONTEXT,
        id: 'thread-1',
        agentName: 'tool-runner',
        configVersion: version,
      }),
      'bureau.contexts.window': () => ({
        maxTokens: 200_000,
        usedEstimated: 76_000,
        usedReported: null,
        categories: [],
      }),
      'bureau.contexts.steer': (params) => {
        steers.push(params);
        version += 1;
        return { outcome: 'accepted', command: {} };
      },
      'bureau.tasks.list': () => ({ tasks: [], nextOffset: null }),
    },
    (url, init) => {
      if (url.endsWith('/host/providers')) return provider(options.hasKey ?? true);
      if (!url.includes('/ag-ui/agents/')) return undefined;
      runs.push(url);
      const input: { threadId: string; runId: string } = JSON.parse(
        typeof init?.body === 'string' ? init.body : '{}',
      );
      return sse([
        { type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId },
        { type: 'TEXT_MESSAGE_START', messageId: 'reply', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'reply', delta: 'Hi.' },
        { type: 'TEXT_MESSAGE_END', messageId: 'reply' },
        {
          type: 'RUN_FINISHED',
          threadId: input.threadId,
          runId: input.runId,
          outcome: { type: 'success' },
        },
      ]);
    },
  );
  restore = served.restore;
  return { steers, runs };
}

function mount(props: Record<string, unknown> = {}) {
  return render(QueryPage, {
    props: {
      page: ChatConversation,
      pageProps: {
        sessionId: 'thread-1',
        title: null,
        agentName: 'tool-runner',
        isNew: true,
        ...props,
      },
      client: createQueryClient(),
    },
  } as never);
}

const footer = (container: HTMLElement) => container.querySelector('.chat-input-footer-left')!;
const editor = (container: HTMLElement) =>
  container.querySelector<HTMLTextAreaElement>('textarea.chat-input-editor');

describe('a new chat with a model agent and a provider', () => {
  test('puts the agent at the top, and Model, Effort and Permissions in the control row', async () => {
    serve();
    landAt('/chats/new?agent=tool-runner');
    const { container } = mount();

    await waitFor(() => expect(footer(container).querySelector('#weft-chat-model')).not.toBeNull());
    expect(footer(container).querySelector('#weft-chat-effort')).not.toBeNull();
    expect(footer(container).querySelector('#weft-chat-permission')).not.toBeNull();
    const agent = container.querySelector<HTMLElement>('.chat-input-header #weft-chat-agent')!;
    expect(agent.getAttribute('data-cinder-variant')).toBe('ghost');
    expect(agent.textContent).toContain('Tool runner');
    // The avatar spells the agent's identifier.
    expect(agent.querySelector('.ib-agent-select__avatar')?.textContent?.trim()).toBe('TR');
    expect(editor(container)?.placeholder).toBe('Message Tool runner…');
  });

  test('draws the formatting row, which the composer shows only while it has focus', async () => {
    serve();
    landAt('/chats/new?agent=tool-runner');
    const { container } = mount();

    await waitFor(() => expect(editor(container)).not.toBeNull());
    expect(container.querySelector('.chat-input-format [role="toolbar"]')).not.toBeNull();
    expect(container.querySelector('.chat-input-format-hint')?.textContent).toBe(
      '⌘B bold · ⌘I italic · ⌘E code · ⌘⇧K link',
    );
  });

  test('keeps the choices until the first message, then applies each under the revision the last left', async () => {
    const { steers, runs } = serve();
    landAt('/chats/new?agent=tool-runner');
    const { container } = mount();
    await waitFor(() =>
      expect(footer(container).querySelector('#weft-chat-effort')).not.toBeNull(),
    );

    await chooseOption(container, 'High', 'weft-chat-effort');
    await chooseOption(container, 'Always asks', 'weft-chat-permission');
    await chooseOption(container, 'Claude Haiku 5', 'weft-chat-model');

    // Nothing is steered while there is no session, and the controls show what was chosen.
    expect(steers).toEqual([]);
    expect(container.querySelector('#weft-chat-effort')?.textContent).toContain('High');
    expect(container.querySelector('#weft-chat-permission')?.textContent).toContain('Always asks');
    expect(container.querySelector('#weft-chat-model')?.textContent).toContain('Claude Haiku 5');

    const box = editor(container)!;
    await fireEvent.input(box, { target: { value: 'Please refund order 4471.' } });
    await fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(steers).toHaveLength(3));
    expect(runs).toHaveLength(1);
    expect(steers.map((steer) => steer['expectedRevision'])).toEqual([0, 1, 2]);
    expect(steers[0]).toMatchObject({ contextId: 'thread-1', override: HAIKU_NAME });
    expect(steers[1]).toMatchObject({ effort: 'high' });
    expect(steers[2]).toMatchObject({ permissionMode: 'always' });
  });

  test('applies nothing when nothing was chosen', async () => {
    const { steers, runs } = serve();
    landAt('/chats/new?agent=tool-runner');
    const { container } = mount();
    await waitFor(() => expect(editor(container)).not.toBeNull());

    const box = editor(container)!;
    await fireEvent.input(box, { target: { value: 'Hello' } });
    await fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(runs).toHaveLength(1));
    expect(steers).toEqual([]);
  });
});

const HAIKU_NAME = { provider: HAIKU.provider, model: HAIKU.model };

describe('a new chat with a scripted agent', () => {
  test('offers Permissions only, and the agent select lists every agent with its sentence', async () => {
    serve();
    landAt('/chats/new?agent=assistant');
    const { container } = mount({ agentName: 'assistant' });

    await waitFor(() =>
      expect(footer(container).querySelector('#weft-chat-permission')).not.toBeNull(),
    );
    await waitFor(() =>
      expect(container.querySelector('#weft-chat-agent')?.textContent).toContain('Assistant'),
    );
    expect(footer(container).querySelector('#weft-chat-model')).toBeNull();
    expect(footer(container).querySelector('#weft-chat-effort')).toBeNull();
    expect(await optionLabels(container, 'weft-chat-agent')).toEqual(['Tool runner', 'Assistant']);
  });

  test('says an agent that runs on a model needs a provider, while none is connected', async () => {
    serve({ hasKey: false });
    landAt('/chats/new?agent=assistant');
    const { container } = mount({ agentName: 'assistant' });
    await waitFor(() =>
      expect(container.querySelector('#weft-chat-agent')?.textContent).toContain('Assistant'),
    );

    await fireEvent.click(container.querySelector('#weft-chat-agent')!);
    await waitFor(() =>
      expect(
        [...document.body.querySelectorAll('.cinder-select__option-note')].map(
          (note) => note.textContent,
        ),
      ).toEqual([CHAT_COPY.agentSelect.needsProvider]),
    );
  });
});

describe('a narrow composer', () => {
  test('folds Model, Effort and Permissions into one Settings control that holds the same selects', async () => {
    serve();
    composerWidth = 340;
    landAt('/chats/new?agent=tool-runner');
    const { container, findByRole } = mount();

    const settings = await findByRole('button', {
      name: 'Settings: Model, Effort and Permissions',
    });
    expect(settings.textContent?.trim()).toBe('Settings');
    // The row holds attach and the one control: the three selects are not beside it.
    expect(footer(container).querySelector('#weft-chat-model')).toBeNull();
    expect(footer(container).querySelector('#weft-chat-effort')).toBeNull();
    expect(footer(container).querySelector('#weft-chat-permission')).toBeNull();

    await fireEvent.click(settings);
    await waitFor(() =>
      expect(document.body.querySelector('[data-testid="composer-settings-panel"]')).not.toBeNull(),
    );
    const panel = document.body.querySelector('[data-testid="composer-settings-panel"]')!;
    expect(panel.querySelector('#weft-chat-model')).not.toBeNull();
    expect(panel.querySelector('#weft-chat-effort')).not.toBeNull();
    expect(panel.querySelector('#weft-chat-permission')).not.toBeNull();
    // Each is rendered once, never also in the row.
    expect(document.querySelectorAll('#weft-chat-model')).toHaveLength(1);
  });

  test('a wide composer has no Settings control', async () => {
    serve();
    landAt('/chats/new?agent=tool-runner');
    const { container, queryByRole } = mount();
    await waitFor(() => expect(footer(container).querySelector('#weft-chat-model')).not.toBeNull());
    expect(queryByRole('button', { name: /^Settings/ })).toBeNull();
  });
});

describe('a chat started from Workflows with no agent that can create workflows', () => {
  test('says so once, in the blocked row, with a link to Agents, and keeps what was typed', async () => {
    serve();
    landAt('/chats/new?agent=tool-runner');
    const view = mount();
    await waitFor(() => expect(editor(view.container)).not.toBeNull());
    await fireEvent.input(editor(view.container)!, {
      target: { value: 'Help me build a workflow that…' },
    });

    await view.rerender({
      page: ChatConversation,
      pageProps: {
        sessionId: 'thread-1',
        title: null,
        agentName: 'tool-runner',
        isNew: true,
        noWorkflowAgent: true,
      },
      client: createQueryClient(),
    } as never);

    const row = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>(
        '[data-chat-composer-status="blocked"]',
      );
      if (found === null) throw new Error('The blocked row did not appear.');
      return found;
    });
    expect(row.textContent).toContain(CHAT_COPY.composer.noWorkflowAgent);
    const link = row.querySelector('a')!;
    expect(link.textContent?.trim()).toBe('Open Agents');
    expect(link.getAttribute('href')).toBe('/agents');
    expect(editor(view.container)).toBeNull();
  });
});
