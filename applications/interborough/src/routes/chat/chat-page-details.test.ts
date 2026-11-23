/**
 * An open chat's page under the top bar (COR-2016, design rows 16a, 16u, 16v): the breadcrumb reads
 * "Chat ›" and then a button naming the chat, which opens the details popover with the session, its
 * agent, when it started and what it ran with. The popover is the page's own, drawn by the top bar.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';

import { readyAgent } from '../../lib/bureau-stub.test-support.ts';
import { clockTime, dayAndTime } from '../../lib/format/clock.ts';
import { router } from '../../lib/router.svelte.ts';
import Harness from './chat-page.test-harness.svelte';
import { AGENT, bureau, CONTEXT, landAt } from './pages.test-support.ts';

let restore: (() => void) | undefined;
afterEach(() => {
  setSystemTime();
  cleanup();
  restore?.();
  restore = undefined;
});

const sse = (events: readonly unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

const TOOL_RUNNER = { ...AGENT, name: 'tool-runner', displayName: 'tool-runner' };
const SONNET = {
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  displayName: 'Claude Sonnet 5.5',
};

/** The Bureau with one chat on Tool runner, started and last active at the given moments. */
function serve(context: Record<string, unknown> = {}) {
  restore = bureau(
    {
      'bureau.contexts.get': () => ({
        ...CONTEXT,
        agentName: 'tool-runner',
        title: 'Please refund order 4471, it arrived damaged.',
        effort: 'medium',
        ...context,
      }),
      'bureau.agents.list': () => ({ agents: [TOOL_RUNNER] }),
      'bureau.agents.models': () => ({
        selectable: true,
        models: [SONNET],
        default: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      }),
    },
    (url) => {
      if (url.endsWith('/messages')) return Response.json({ threadId: 'session-1', messages: [] });
      if (url.includes('/threads/')) {
        return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
      }
      return undefined;
    },
  ).restore;
}

function mount(props: Record<string, unknown> = {}) {
  return render(Harness, {
    props: { sessionId: 'session-1', title: null, agentName: 'tool-runner', ...props },
  } as never);
}

const TITLE = 'Please refund order 4471, it arrived damaged.';

describe('the breadcrumb of an open chat', () => {
  test('reads Chat, then a button naming the chat that opens its details (16a)', async () => {
    serve();
    landAt('/chats/session-1');
    const { findByRole, getByRole } = mount();

    const trigger = await findByRole('button', { name: TITLE });
    expect(trigger.closest('nav')?.getAttribute('aria-label')).toBe('Breadcrumb');
    expect(trigger.getAttribute('aria-current')).toBe('page');
    expect(
      within(getByRole('navigation', { name: 'Breadcrumb' })).getAllByRole('listitem')[0]
        ?.textContent,
    ).toContain('Chat');
    expect(getByRole('navigation', { name: 'Breadcrumb' }).textContent).not.toContain('session-1');
  });

  test('is the page’s own title until the Bureau has read the chat, never the identifier', async () => {
    serve();
    landAt('/chats/session-1');
    const { findByRole } = mount({ title: 'Plan the week' });

    expect(await findByRole('button', { name: /Plan the week|Please refund/ })).not.toBeNull();
  });

  test('is a plain name, without a button, on a new chat', async () => {
    serve();
    landAt('/chats/new');
    const { getByRole, queryByRole } = mount({ isNew: true });

    expect(getByRole('navigation', { name: 'Breadcrumb' }).textContent).toContain('New chat');
    expect(queryByRole('button', { name: 'New chat' })).toBeNull();
  });
});

describe('the details popover (16u, 16v)', () => {
  // The popover is positioned by the browser, so in a test it is still marked hidden to assistive
  // technology; the queries read it as it is.
  async function open() {
    const view = mount();
    const trigger = await view.findByRole('button', { name: TITLE });
    await fireEvent.click(trigger);
    const details = await view.findByTestId('chat-details');
    return { ...view, details };
  }

  /** Each row of the popover as "Label: value". */
  const rows = (details: HTMLElement): string[] =>
    [...details.querySelectorAll('.weft-chat-details__row')].map(
      (row) =>
        `${row.querySelector('dt')?.textContent?.trim() ?? ''}: ${row.querySelector('dd')?.textContent?.trim() ?? ''}`,
    );

  test('lists the agent as a link by name alone, when it started and was last active, and copies the session ID from the bottom (16d, 16e)', async () => {
    // Midday in the host's zone, so both moments fall on today whatever the hour the suite runs at
    // (COR-2374: run just after midnight, the start fell on yesterday and the day was named again).
    setSystemTime(new Date(2026, 10, 12, 12, 0));
    const started = Date.now() - 16 * 60_000;
    const active = Date.now() - 1 * 60_000;
    serve({
      createdAt: new Date(started).toISOString(),
      updatedAt: new Date(active).toISOString(),
    });
    landAt('/chats/session-1');
    const { details } = await open();

    const agent = within(details).getByRole('link', { name: 'Tool runner', hidden: true });
    expect(agent.getAttribute('href')).toBe('/agents/tool-runner');
    // No machine identifier beside a name, and the session's identifier is not a row.
    expect(details.querySelectorAll('code')).toHaveLength(0);
    expect(details.textContent).not.toContain('tool-runner');
    expect(details.textContent).not.toContain('session-1');
    expect(details.textContent).not.toContain(String.fromCodePoint(0xb7));
    expect(rows(details).slice(0, 3)).toEqual([
      'Agent: Tool runner',
      `Started: ${dayAndTime(started, Date.now())}`,
      `Last active: ${clockTime(active)}`,
    ]);
    expect(details.textContent).toContain('Today, ');
    // The copy action is the popover's last control.
    const buttons = within(details).getAllByRole('button', { hidden: true });
    expect(buttons.at(-1)?.textContent).toContain('Copy session ID');
  });

  test('says no last active time when it reads the same as the start (16e)', async () => {
    setSystemTime(new Date(2026, 10, 12, 12, 0));
    const started = new Date(2026, 10, 12, 6, 29, 5).getTime();
    serve({
      createdAt: new Date(started).toISOString(),
      updatedAt: new Date(started + 20_000).toISOString(),
    });
    landAt('/chats/session-1');
    const { details } = await open();

    expect(rows(details)).toContain(`Started: ${dayAndTime(started, Date.now())}`);
    expect(details.textContent).not.toContain('Last active');
  });

  test('names both days when the chat started before midnight and was last active after it', async () => {
    setSystemTime(new Date(2026, 10, 12, 0, 1, 15));
    const started = new Date(2026, 10, 11, 23, 45).getTime();
    const active = new Date(2026, 10, 12, 0, 0).getTime();
    serve({
      createdAt: new Date(started).toISOString(),
      updatedAt: new Date(active).toISOString(),
    });
    landAt('/chats/session-1');
    const { details } = await open();

    expect(rows(details)).toContain(`Started: Yesterday, ${clockTime(started)}`);
    expect(rows(details)).toContain(`Last active: Today, ${clockTime(active)}`);
  });

  test('names the day again when the chat was last active on a later day', async () => {
    serve({
      createdAt: '2026-10-19T08:00:00.000Z',
      updatedAt: '2026-10-21T09:00:00.000Z',
    });
    landAt('/chats/session-1');
    const { details } = await open();

    expect(rows(details)).toContain(
      `Started: ${dayAndTime(Date.parse('2026-10-19T08:00:00.000Z'), Date.now())}`,
    );
    expect(rows(details)).toContain(
      `Last active: ${dayAndTime(Date.parse('2026-10-21T09:00:00.000Z'), Date.now())}`,
    );
  });

  test('lists the settings plainly, with no As run heading and the model by its name alone (16d, 16f)', async () => {
    serve();
    landAt('/chats/session-1');
    const { details } = await open();

    expect(details.textContent).not.toContain('As run');
    expect(rows(within(details).getByTestId('chat-details-settings'))).toEqual([
      'Model: Claude Sonnet 5.5',
      'Effort: Medium',
      'Permissions: On changes asks',
    ]);
  });

  test('says what an unset effort resolves to: the agent’s own effort (16f)', async () => {
    restore = bureau(
      {
        'bureau.contexts.get': () => ({
          ...CONTEXT,
          agentName: 'tool-runner',
          title: TITLE,
          effort: null,
          model: { provider: 'anthropic', model: 'claude-haiku-5-5' },
        }),
        'bureau.agents.list': () => ({ agents: [TOOL_RUNNER] }),
        'bureau.agents.models': () => ({ selectable: true, models: [SONNET], default: null }),
        'bureau.agents.definitions.get': () => {
          const ready = readyAgent({ id: 'tool-runner' });
          return { ...ready, definition: { ...ready.definition!, effort: 'medium' } };
        },
      },
      (url) => {
        if (url.endsWith('/messages'))
          return Response.json({ threadId: 'session-1', messages: [] });
        if (url.includes('/threads/')) {
          return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
        }
        return undefined;
      },
    ).restore;
    landAt('/chats/session-1');
    const { details } = await open();

    const settings = within(details).getByTestId('chat-details-settings');
    await waitFor(() => expect(rows(settings)).toContain('Effort: Medium, the agent’s default'));
    // The chat's own model shows, in the product's name when the agent does not list it.
    expect(rows(settings)).toContain('Model: Claude Haiku 5.5');
  });

  test('says the agent’s default for an unset effort while the agent cannot be read (16f)', async () => {
    serve({ effort: null });
    landAt('/chats/session-1');
    const { details } = await open();

    const settings = within(details).getByTestId('chat-details-settings');
    await waitFor(() => expect(rows(settings)).toContain('Effort: The agent’s default'));
  });

  test('names the model that wrote the latest reply when neither the chat nor its agent names one', async () => {
    // The agent lists a model and names no default, and the chat was never switched.
    restore = bureau(
      {
        'bureau.contexts.get': () => ({
          ...CONTEXT,
          agentName: 'tool-runner',
          title: TITLE,
          effort: 'medium',
        }),
        'bureau.agents.list': () => ({ agents: [TOOL_RUNNER] }),
        'bureau.agents.models': () => ({
          selectable: true,
          models: [{ ...SONNET, displayName: 'claude-sonnet-5-5' }],
          default: null,
        }),
      },
      (url) => {
        if (url.endsWith('/messages')) {
          return Response.json({
            threadId: 'session-1',
            messages: [
              { id: 'u1', role: 'user', content: 'Hello' },
              {
                id: 'a1',
                role: 'assistant',
                content: 'Hi.',
                metadata: {
                  'bureau:replyModel': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
                },
              },
            ],
          });
        }
        if (url.includes('/threads/')) {
          return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
        }
        return undefined;
      },
    ).restore;
    landAt('/chats/session-1');
    const { details } = await open();

    const settings = within(details).getByTestId('chat-details-settings');
    await waitFor(() => expect(rows(settings)).toContain('Model: Claude Sonnet 5.5'));
  });

  test('opens the agent’s page once, without leaving the application', async () => {
    serve();
    landAt('/chats/session-1');
    const { details } = await open();
    const before = window.history.length;

    await fireEvent.click(within(details).getByRole('link', { name: 'Tool runner', hidden: true }));

    expect(router.pathname).toBe('/agents/tool-runner');
    expect(window.history.length - before).toBe(1);
  });

  test('leaves the settings out until the session has been read', async () => {
    restore = bureau({ 'bureau.contexts.get': () => new Promise(() => undefined) }, (url) => {
      if (url.endsWith('/messages')) return Response.json({ threadId: 's', messages: [] });
      if (url.includes('/threads/')) {
        return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
      }
      return undefined;
    }).restore;
    landAt('/chats/session-1');
    const view = mount({ title: 'Plan the week' });
    await fireEvent.click(await view.findByRole('button', { name: 'Plan the week' }));
    const details = await view.findByTestId('chat-details');

    expect(
      within(details).getByRole('button', { name: 'Copy session ID', hidden: true }),
    ).not.toBeNull();
    // The session is never answered, so there is nothing to wait for: the settings are absent.
    expect(within(details).queryByTestId('chat-details-settings')).toBeNull();
  });
});

describe('the details popover, copying and an unset model', () => {
  async function open() {
    const view = mount();
    await fireEvent.click(await view.findByRole('button', { name: TITLE }));
    return { ...view, details: await view.findByTestId('chat-details') };
  }

  test('copies the session ID and says it was copied', async () => {
    serve();
    landAt('/chats/session-1');
    const written: string[] = [];
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });
    try {
      const { details } = await open();
      await fireEvent.click(
        within(details).getByRole('button', { name: 'Copy session ID', hidden: true }),
      );

      await waitFor(() => expect(written).toEqual(['session-1']));
      await waitFor(() => expect(details.textContent).toContain('Session ID copied'));
    } finally {
      if (original === undefined) Reflect.deleteProperty(navigator, 'clipboard');
      else Object.defineProperty(navigator, 'clipboard', original);
    }
  });

  test('says Agent default for a model neither the chat nor its agent names', async () => {
    restore = bureau(
      {
        'bureau.contexts.get': () => ({
          ...CONTEXT,
          agentName: 'tool-runner',
          title: TITLE,
          effort: 'medium',
        }),
        'bureau.agents.list': () => ({ agents: [TOOL_RUNNER] }),
        'bureau.agents.models': () => ({ selectable: true, models: [], default: null }),
      },
      (url) => {
        if (url.endsWith('/messages')) {
          return Response.json({ threadId: 'session-1', messages: [] });
        }
        if (url.includes('/threads/')) {
          return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
        }
        return undefined;
      },
    ).restore;
    landAt('/chats/session-1');
    const { details } = await open();

    const settings = within(details).getByTestId('chat-details-settings');
    expect(settings.textContent).toContain('Agent default');
  });
});

describe('the top bar under an open chat', () => {
  test('keeps search and quick settings live beside the breadcrumb', async () => {
    serve();
    landAt('/chats/session-1');
    const { findByRole } = mount();

    await findByRole('button', { name: TITLE });
    const search = await findByRole('button', { name: /Search everything/ });
    await fireEvent.click(search);
    const settings = await findByRole('button', { name: 'Quick settings' });
    await fireEvent.click(settings);

    expect(settings.getAttribute('aria-expanded')).toBe('true');
  });
});
