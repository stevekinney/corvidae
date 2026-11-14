/**
 * A new chat started from the Workflows page ("Ask an agent to write one"), and the first message of
 * a new chat while it is being started, over a stubbed Bureau (COR-2016, design rows 24b, 24d, 24e,
 * 24f, 24g, 24h and 24i of PageNewChat). A chat from Workflows carries a chip above the composer,
 * holds the start of a request in the box, draws no sentence and no suggestions, and with no agent
 * that can create workflows says so once in the blocked row and lets the person take their text to
 * another agent. A first message that is on its way leaves the greeting up and the typed text in the
 * box, with Send reading "Starting chat…", until the run has begun.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { ConnectionMonitor } from '../../app/connection.svelte.ts';
import { CHAT_COPY } from '../../app/copy/chat.ts';
import type { ProvidersSnapshot } from '../../lib/host-providers.ts';
import { createQueryClient } from '../../lib/query.ts';
import ChatConversation from './chat-conversation.svelte';
import { chooseOption } from './listbox.test-support.ts';
import { AGENT, bureau, CONTEXT, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';

const MEDIA = { modalities: {}, mimeFamilies: [], mediaLimits: [] };
const AUTHOR = {
  ...AGENT,
  name: 'workflow-author',
  displayName: 'Workflow author',
  description: 'Drafts a workflow from a description, and asks before it creates the file.',
  media: MEDIA,
  tools: ['bureau:workflows-create'],
  examples: ['Help me build a workflow that…'],
};
const RUNNER = {
  ...AGENT,
  name: 'tool-runner',
  displayName: 'Tool runner',
  description: 'Looks an order up, then asks for approval to refund it.',
  media: MEDIA,
  tools: ['lookup-order'],
};
const SAMPLE_MODEL = {
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  displayName: 'Claude Sonnet 5',
};

let restore: (() => void) | undefined;
const originalRectangle = HTMLElement.prototype.getBoundingClientRect;
const originalResizeObserver = globalThis.ResizeObserver;

beforeEach(() => {
  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    return { width: 900, height: 0 } as DOMRect;
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

const encoder = new TextEncoder();
const frame = (event: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

const provider = (hasKey: boolean, connected = hasKey) =>
  Response.json({
    configurationRevision: null,
    providers: [{ name: 'anthropic', configured: true, hasKey, connected }],
    catalog: [],
    models: [],
  } satisfies ProvidersSnapshot);

/** What a run's stream says at its start, and how it ends. */
type Run = { readonly threadId: string; readonly runId: string };

interface Served {
  /** Lets the held run begin: the stream says it started and finishes. */
  readonly start: () => void;
  /** Fails the held run before it began: the host refuses it, or with `'network'` does not answer at all. */
  readonly fail: (kind?: 'refused' | 'network') => void;
  /** Lets the next run begin again, after a failure. */
  readonly recover: () => void;
  readonly runs: () => number;
}

/** A Bureau with the given agents, whose first run is held until the test lets it begin or fail. */
function serve(
  options: {
    agents?: readonly Record<string, unknown>[];
    hasKey?: boolean;
    /** Whether the provider can be called; its key when left out. */
    connected?: boolean;
  } = {},
): Served {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let held: Run | undefined;
  let count = 0;
  let failing: 'refused' | 'network' | undefined;
  const served = bureau(
    {
      'bureau.agents.list': () => ({ agents: options.agents ?? [AUTHOR, RUNNER, AGENT] }),
      'bureau.agents.models': () => ({
        selectable: true,
        models: [SAMPLE_MODEL],
        default: SAMPLE_MODEL,
      }),
      'bureau.contexts.get': () => ({ ...CONTEXT, id: 'thread-1', agentName: 'workflow-author' }),
      'bureau.contexts.window': () => ({
        maxTokens: 200_000,
        usedEstimated: 0,
        usedReported: null,
        categories: [],
      }),
      'bureau.tasks.list': () => ({ tasks: [], nextOffset: null }),
    },
    (url, init) => {
      if (url.endsWith('/host/providers'))
        return provider(options.hasKey ?? true, options.connected);
      if (!url.includes('/ag-ui/agents/')) return undefined;
      count += 1;
      const input: { threadId: string; runId: string } = JSON.parse(
        typeof init?.body === 'string' ? init.body : '{}',
      );
      held = { threadId: input.threadId, runId: input.runId };
      if (failing === 'network') throw new TypeError('Failed to fetch');
      if (failing === 'refused') return new Response('down', { status: 503 });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(next) {
            controller = next;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  );
  restore = served.restore;
  return {
    runs: () => count,
    fail: (kind = 'refused') => {
      failing = kind;
    },
    recover: () => {
      failing = undefined;
    },
    start: () => {
      if (held === undefined || controller === undefined) throw new Error('No run is held.');
      controller.enqueue(frame({ type: 'RUN_STARTED', ...held }));
      controller.enqueue(
        frame({ type: 'TEXT_MESSAGE_START', messageId: 'reply', role: 'assistant' }),
      );
      controller.enqueue(frame({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'reply', delta: 'Hi.' }));
      controller.enqueue(frame({ type: 'TEXT_MESSAGE_END', messageId: 'reply' }));
      controller.enqueue(frame({ type: 'RUN_FINISHED', ...held, outcome: { type: 'success' } }));
      controller.close();
    },
  };
}

function mount(props: Record<string, unknown> = {}) {
  const { connection, ...pageProps } = props as { connection?: ConnectionMonitor };
  return render(QueryPage, {
    props: {
      page: ChatConversation,
      pageProps: {
        sessionId: 'thread-1',
        title: null,
        agentName: 'workflow-author',
        isNew: true,
        fromWorkflows: true,
        ...pageProps,
      },
      client: createQueryClient(),
      ...(connection === undefined ? {} : { connection }),
    },
  } as never);
}

const editor = (container: HTMLElement) =>
  container.querySelector<HTMLTextAreaElement>('textarea.chat-input-editor');
const chip = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="new-chat-source"]');
const blocked = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-chat-composer-status="blocked"]');
const send = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('button[data-chat-send]');

/** Send is icon-only, so the starting word is its accessible name. */
const sendName = (container: HTMLElement) => send(container)?.getAttribute('aria-label') ?? '';

/** Waits for the composer's box to be drawn. */
async function box(container: HTMLElement): Promise<HTMLTextAreaElement> {
  return waitFor(() => {
    const found = editor(container);
    if (found === null) throw new Error('The composer has no box yet.');
    return found;
  });
}

const PREFILL = 'Help me build a workflow that ';

describe('a chat started from Workflows with an agent that can create workflows', () => {
  test('says where it came from in one chip above the composer, and nothing else about it (24d, 24e)', async () => {
    serve();
    landAt('/chats/new?from=workflows');
    const { container } = mount();
    const field = await box(container);

    expect(chip(container)?.textContent?.trim()).toBe('Starting from Workflows');
    // The chip is above the composer, outside its border.
    const form = container.querySelector('form.chat-input')!;
    expect(form.contains(chip(container))).toBe(false);
    expect(
      chip(container)!.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Workflow author's greeting is the only title, with no sentence, no suggestions and no list of
    // other agents under the composer.
    expect(container.querySelector('h1')?.textContent).toBe('What should Workflow author do?');
    expect(container.querySelector('.ib-new-chat__description')).toBeNull();
    expect(container.querySelector('[data-testid="new-chat-choices"]')).toBeNull();
    expect(field.placeholder).toBe('Message Workflow author…');
  });

  test('holds "Help me build a workflow that " in the box, editable, with the caret after it, and Send on (24f)', async () => {
    serve();
    landAt('/chats/new?from=workflows');
    const { container } = mount();
    const field = await box(container);

    await waitFor(() => expect(field.value).toBe(PREFILL));
    expect(PREFILL.endsWith(' ')).toBe(true);
    expect(PREFILL).not.toContain('…');
    expect(field.selectionStart).toBe(PREFILL.length);
    expect(field.selectionEnd).toBe(PREFILL.length);
    // Model, Effort and Permissions, and an enabled Send.
    await waitFor(() => expect(container.querySelector('#weft-chat-model')).not.toBeNull());
    expect(container.querySelector('#weft-chat-effort')).not.toBeNull();
    expect(container.querySelector('#weft-chat-permission')).not.toBeNull();
    expect(send(container)?.disabled).toBe(false);
    // It is editable.
    await fireEvent.input(field, {
      target: { value: `${PREFILL}sends me a summary every morning.` },
    });
    expect(field.value).toBe(`${PREFILL}sends me a summary every morning.`);
  });

  test('keeps the chip when the person takes their text to another agent, and does not fill the box again (24d)', async () => {
    serve();
    landAt('/chats/new?from=workflows');
    const { container } = mount();
    const field = await box(container);
    await waitFor(() => expect(field.value).toBe(PREFILL));
    await fireEvent.input(field, { target: { value: 'Rename the billing tables' } });

    await chooseOption(container, 'Tool runner', 'weft-chat-agent');

    await waitFor(() =>
      expect(container.querySelector('#weft-chat-agent')?.textContent).toContain('Tool runner'),
    );
    expect(chip(container)?.textContent?.trim()).toBe('Starting from Workflows');
    expect(editor(container)?.value).toBe('Rename the billing tables');
    expect(window.location.search).toBe('?agent=tool-runner&from=workflows');
  });
});

describe('a chat started from Workflows with no model provider', () => {
  test('is Chat’s Connect a model provider state, draws no banner, and holds the prefill back (COR-2285 V4)', async () => {
    serve({ hasKey: false, connected: false });
    landAt('/chats/new?from=workflows');
    const { container } = mount();

    await waitFor(() =>
      expect(container.querySelector('[data-chat-availability="unconfigured"]')).not.toBeNull(),
    );
    const state = container.querySelector<HTMLElement>('[data-chat-availability="unconfigured"]')!;
    expect(state.textContent).toContain('Connect a model provider');
    expect(blocked(container)).toBeNull();
    expect(container.querySelector('.cinder-banner')).toBeNull();
    // The composer is out of sight until a provider is connected, so nothing of the prefill shows.
    expect(container.querySelector<HTMLElement>('.chat-input-wrapper')?.style.display).toBe('none');
  });
});

describe('a chat started from Workflows when no agent can create workflows', () => {
  test('keeps the chip, reads "Choose an agent", and says why once, with no error in the greeting (24i)', async () => {
    serve({ agents: [RUNNER, AGENT] });
    landAt('/chats/new?from=workflows');
    const { container } = mount({ agentName: '' });
    const row = await waitFor(() => {
      const found = blocked(container);
      if (found === null) throw new Error('The blocked row did not appear.');
      return found;
    });

    expect(chip(container)?.textContent?.trim()).toBe('Starting from Workflows');
    expect(container.querySelector('#weft-chat-agent')?.textContent).toContain('Choose an agent');
    expect(row.textContent).toContain(CHAT_COPY.composer.noWorkflowAgent);
    const link = row.querySelector('a')!;
    expect(link.textContent?.trim()).toBe('Open Agents');
    expect(link.getAttribute('href')).toBe('/agents');
    // The greeting area carries no error and no visible title: the heading is for screen readers.
    expect(container.querySelector('.ib-new-chat__avatar')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    const heading = container.querySelector('h1')!;
    expect(heading.textContent).toBe(CHAT_COPY.newChatWelcome.chooseAgent);
    expect(heading.className).toContain('sr-only');
    expect(editor(container)).toBeNull();
  });

  test('lets the person choose another agent, whose composer takes the prefill (24i)', async () => {
    serve({ agents: [RUNNER, AGENT] });
    landAt('/chats/new?from=workflows');
    const { container } = mount({ agentName: '' });
    await waitFor(() => expect(blocked(container)).not.toBeNull());
    // The pill has nothing to list until the agents have been read, so it is asked until it opens.
    await waitFor(async () => {
      const pill = container.querySelector<HTMLElement>('#weft-chat-agent')!;
      if (pill.getAttribute('aria-expanded') !== 'true') await fireEvent.click(pill);
      expect(pill.getAttribute('aria-expanded')).toBe('true');
    });

    await chooseOption(container, 'Tool runner', 'weft-chat-agent');

    const field = await box(container);
    await waitFor(() => expect(field.value).toBe(PREFILL));
    expect(blocked(container)).toBeNull();
    expect(chip(container)?.textContent?.trim()).toBe('Starting from Workflows');
    expect(container.querySelector('h1')?.textContent).toBe('What should Tool runner do?');
  });
});

describe('the first message of a new chat', () => {
  test('is on its way: Send reads "Starting chat…", the greeting stays and the box keeps the typed text (24b)', async () => {
    const served = serve();
    landAt('/chats/new?agent=workflow-author');
    const { container } = mount({ fromWorkflows: false });
    const field = await box(container);
    await fireEvent.input(field, {
      target: { value: 'Please refund order 4471, it arrived damaged.' },
    });

    await fireEvent.submit(container.querySelector('form.chat-input')!);

    await waitFor(() => expect(sendName(container)).toBe('Starting chat…'));
    expect(send(container)?.disabled).toBe(true);
    expect(container.querySelector('.chat-input-spinner')).not.toBeNull();
    expect(editor(container)?.value).toBe('Please refund order 4471, it arrived damaged.');
    // The chat page has not opened: no row of the conversation, the greeting still the title, and
    // the Model, Effort and Permissions selects still shown.
    expect(container.querySelector('[data-role="user"], .chat-message--user')).toBeNull();
    expect(container.querySelector('h1')?.textContent).toBe('What should Workflow author do?');
    expect(container.querySelector('#weft-chat-model')).not.toBeNull();
    expect(container.querySelector('#weft-chat-permission')).not.toBeNull();
    expect(served.runs()).toBe(1);
    // Nothing is running yet to steer, the agent is fixed, and there is nothing else to start with.
    expect(container.textContent).not.toContain('A message now steers the run.');
    expect(container.querySelector('[data-testid="new-chat-choices"]')).toBeNull();
    expect(container.querySelector('#weft-chat-agent')?.hasAttribute('disabled')).toBe(true);

    served.start();

    // Once the run has begun the chat is open, and the box is empty.
    await waitFor(() => expect(container.textContent).toContain('Hi.'));
    expect(editor(container)?.value).toBe('');
    expect(sendName(container)).not.toBe('Starting chat…');
    expect(window.location.pathname).toBe('/chats/thread-1');
  });

  test('keeps what was typed after Send, while it was starting, when the run begins', async () => {
    const served = serve();
    landAt('/chats/new?agent=workflow-author');
    const { container } = mount({ fromWorkflows: false });
    const field = await box(container);
    await fireEvent.input(field, { target: { value: 'Please refund order 4471.' } });
    await fireEvent.submit(container.querySelector('form.chat-input')!);
    await waitFor(() => expect(sendName(container)).toBe('Starting chat…'));

    // The box stays editable while the chat starts, and the person goes on typing their next message.
    await fireEvent.input(editor(container)!, {
      target: { value: 'Please refund order 4471. Also email the customer.' },
    });
    served.start();

    await waitFor(() => expect(container.textContent).toContain('Hi.'));
    expect(sendName(container)).not.toBe('Starting chat…');
    expect(editor(container)?.value).toBe('Please refund order 4471. Also email the customer.');
  });

  test('empties the box when the run begins and the text is still what was sent', async () => {
    const served = serve();
    landAt('/chats/new?agent=workflow-author');
    const { container } = mount({ fromWorkflows: false });
    const field = await box(container);
    await fireEvent.input(field, { target: { value: 'Say hello' } });
    await fireEvent.submit(container.querySelector('form.chat-input')!);
    await waitFor(() => expect(sendName(container)).toBe('Starting chat…'));
    // Typing the same text again changes nothing about what the box holds.
    await fireEvent.input(editor(container)!, { target: { value: 'Say hello' } });

    served.start();

    await waitFor(() => expect(container.textContent).toContain('Hi.'));
    expect(editor(container)?.value).toBe('');
  });

  test('that could not be started keeps the typed text and leaves no row behind, so the next Send is the first (24r)', async () => {
    const served = serve();
    landAt('/chats/new?agent=workflow-author');
    const { container } = mount({ fromWorkflows: false });
    const field = await box(container);
    await fireEvent.input(field, { target: { value: 'Say hello' } });
    served.fail();

    await fireEvent.submit(container.querySelector('form.chat-input')!);

    await waitFor(() => expect(sendName(container)).not.toBe('Starting chat…'));
    await waitFor(() => expect(served.runs()).toBe(1));
    // The text is kept, no chat page opened, and nothing of the message is left in the conversation.
    expect(editor(container)?.value).toBe('Say hello');
    expect(window.location.pathname).toBe('/chats/new');
    expect(container.querySelector('[data-role="user"], .chat-message--user')).toBeNull();
    expect(send(container)?.disabled).toBe(false);
    // The failure is said under the composer, not in an alert above the page.
    expect(container.querySelector('[data-testid="new-chat-failure"]')).not.toBeNull();
    expect(container.querySelector('.cinder-alert')).toBeNull();
  });

  test('that got no answer says so under the composer with Retry, keeps the text, and Retry sends it again (24c, 24r)', async () => {
    const served = serve();
    landAt('/chats/new?agent=workflow-author');
    const { container, findByRole } = mount({ fromWorkflows: false });
    const field = await box(container);
    await fireEvent.input(field, {
      target: { value: 'Please refund order 4471, it arrived damaged.' },
    });
    served.fail('network');

    await fireEvent.submit(container.querySelector('form.chat-input')!);

    const line = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('[data-testid="new-chat-failure"]');
      if (found === null) throw new Error('The failure is not said yet.');
      return found;
    });
    expect(line.textContent?.replaceAll(/\s+/g, ' ').trim()).toBe(
      'Couldn’t start the chat. Interborough didn’t answer. Your text is kept. Retry',
    );
    expect(line.getAttribute('role')).toBe('alert');
    // The text stays, Send is enabled again, no chat page opened, and the Try row and the other
    // agents make way for the line.
    expect(editor(container)?.value).toBe('Please refund order 4471, it arrived damaged.');
    expect(send(container)?.disabled).toBe(false);
    expect(window.location.pathname).toBe('/chats/new');
    expect(container.querySelector('[data-testid="new-chat-choices"]')).toBeNull();
    expect(container.querySelector('h1')?.textContent).toBe('What should Workflow author do?');
    expect(served.runs()).toBe(1);

    // Retry sends the kept text as the first message again, and the line goes while it is on its way.
    served.recover();
    await fireEvent.click(await findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(served.runs()).toBe(2));
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="new-chat-failure"]')?.outerHTML ?? null,
      ).toBeNull(),
    );
    served.start();
    await waitFor(() => expect(container.textContent).toContain('Hi.'));
    expect(window.location.pathname).toBe('/chats/thread-1');
    expect(editor(container)?.value).toBe('');
  });

  test('draws no line of its own while Interborough cannot be reached: the shell’s banner says it (24s)', async () => {
    const served = serve();
    const connection = new ConnectionMonitor({
      probe: async () => {
        throw new TypeError('Failed to fetch');
      },
      probeDelayMs: () => 60_000,
      browserOffline: false,
    });
    try {
      landAt('/chats/new?agent=workflow-author');
      const { container } = mount({ fromWorkflows: false, connection });
      const field = await box(container);
      await fireEvent.input(field, { target: { value: 'Say hello' } });
      served.fail('network');

      await fireEvent.submit(container.querySelector('form.chat-input')!);

      // The first answer is the page's own line, until the monitor knows the server is down.
      await waitFor(() =>
        expect(container.querySelector('[data-testid="new-chat-failure"]')).not.toBeNull(),
      );
      connection.reportUnreachable();
      await waitFor(() =>
        expect(
          container.querySelector('[data-testid="new-chat-failure"]')?.outerHTML ?? null,
        ).toBeNull(),
      );
      // Nothing else of its own takes its place, and no chat page opened.
      expect(container.querySelector('.cinder-alert')).toBeNull();
      expect(window.location.pathname).toBe('/chats/new');
    } finally {
      connection.dispose();
    }
  });
});
