/**
 * The conversation page's header and composer controls for the chat's settings, over a stubbed
 * Bureau: the model, effort and permission mode are always shown, each is changed from the
 * composer, the note says when a change takes effect, and the context-window ring reads
 * `bureau.contexts.window`.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import { CHAT_COPY } from '../../app/copy.ts';
import { createQueryClient } from '../../lib/query.ts';
import ChatConversation from './chat-conversation.svelte';
import { AGENT, bureau, CONTEXT, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const SETTINGS = CHAT_COPY.settings;
const SONNET = { provider: 'anthropic', model: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' };
const HAIKU = { provider: 'anthropic', model: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5' };
const WINDOW = {
  maxTokens: 200_000,
  usedEstimated: 84_000,
  usedReported: null,
  categories: [
    { name: 'system', tokens: 4_000 },
    { name: 'tools', tokens: 10_000 },
    { name: 'messages', tokens: 70_000 },
    { name: 'memory', tokens: 0 },
    { name: 'attachments', tokens: 0 },
  ],
};
const TURNS = [
  { id: 'u1', role: 'user', content: 'Question' },
  { id: 'a1', role: 'assistant', content: 'Answer' },
];

type Answers = Record<string, (params: Record<string, unknown>) => unknown>;

/** The stream the page joins: closed at once for an idle chat, held open for a run that is going. */
function thread(running: boolean): (url: string) => Response | undefined {
  return (url) => {
    if (url.endsWith('/messages')) return Response.json({ threadId: 'session-1', messages: TURNS });
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

function serve(answers: Answers = {}, running = false) {
  const served = bureau(
    {
      'bureau.agents.list': () => ({ agents: [AGENT] }),
      'bureau.agents.models': () => ({
        selectable: true,
        models: [SONNET, HAIKU],
        default: SONNET,
      }),
      'bureau.contexts.get': () => ({ ...CONTEXT, configVersion: 1 }),
      'bureau.contexts.window': () => WINDOW,
      'bureau.tasks.list': () => ({ tasks: [], nextOffset: null }),
      ...answers,
    },
    thread(running),
  );
  restore = served.restore;
  landAt('/chats/session-1');
  return served;
}

function mount() {
  return render(QueryPage, {
    props: {
      page: ChatConversation,
      pageProps: { sessionId: 'session-1', title: 'Plan the week', agentName: 'assistant' },
      client: createQueryClient(),
    },
  } as never);
}

const control = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLSelectElement>(`#${id}`);
const shown = (container: HTMLElement, setting: string) =>
  container.querySelector(`[data-setting="${setting}"]`)?.textContent;
const note = (container: HTMLElement) =>
  container.querySelector('[data-testid="chat-settings-note"]')?.textContent?.trim();

describe('the header', () => {
  test('always shows the model, the effort and the permission mode the chat runs with', async () => {
    serve();
    const { container } = mount();

    await waitFor(() => expect(shown(container, 'model')).toBe('Claude Sonnet 5'));
    expect(shown(container, 'effort')).toBe(SETTINGS.agentDefault);
    expect(shown(container, 'permission')).toBe('Ask on changes');
  });

  test('shows the model and the settings the chat was steered to', async () => {
    serve({
      'bureau.contexts.get': () => ({
        ...CONTEXT,
        model: { provider: 'anthropic', model: 'claude-haiku-4-5' },
        effort: 'xhigh',
        permissionMode: 'read-only',
        configVersion: 5,
      }),
    });
    const { container } = mount();

    await waitFor(() => expect(shown(container, 'model')).toBe('Claude Haiku 4.5'));
    expect(shown(container, 'effort')).toBe('Extra high');
    expect(shown(container, 'permission')).toBe('Read-only');
  });

  test('shows the model of an agent that allows one, or names none, though it offers no choice', async () => {
    serve({
      'bureau.agents.models': () => ({ selectable: true, models: [SONNET], default: SONNET }),
    });
    const { container } = mount();

    await waitFor(() => expect(shown(container, 'model')).toBe('Claude Sonnet 5'));
    expect(control(container, 'weft-chat-model')?.disabled).toBe(true);
    cleanup();
    restore?.();

    serve({ 'bureau.agents.models': () => ({ selectable: true, models: [], default: null }) });
    const other = mount();
    await waitFor(() => expect(shown(other.container, 'model')).toBe(SETTINGS.agentDefault));
  });

  test('says what a permission mode other than the default means, as the Bureau defines it', async () => {
    serve({
      'bureau.contexts.get': () => ({ ...CONTEXT, permissionMode: 'allow-all', configVersion: 2 }),
    });
    const { container } = mount();

    await waitFor(() =>
      expect(container.querySelector('[data-testid="permission-description"]')).not.toBeNull(),
    );
    expect(note(container)).toBe(SETTINGS.permissionDescriptions['allow-all']);
    expect(note(container)).toContain('always ask still asks');
    expect(note(container)).toContain('child agent keeps its own stricter mode');
  });

  test('says nothing of the default mode', async () => {
    serve();
    const { container } = mount();
    await waitFor(() => expect(shown(container, 'permission')).toBe('Ask on changes'));

    expect(note(container)).toBe('');
  });

  test('holds no field: the controls are in the composer, and the header has the title and the ring', async () => {
    serve();
    const { container, findByRole } = mount();

    const heading = await findByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Plan the week');
    const header = container.querySelector('[data-testid="chat-header"]');
    expect(header?.querySelector('input, select')).toBeNull();
  });
});

describe('the context-window ring', () => {
  test('reads how full the window is, and opens to what fills it', async () => {
    const served = serve();
    const { container, findByTestId } = mount();

    const ring = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('.weft-context-ring');
      if (found === null) throw new Error('The ring did not render.');
      return found;
    });
    expect(ring.textContent).toContain('42%');
    expect(served.calls.find((call) => call.method === 'bureau.contexts.window')?.params).toEqual({
      contextId: 'session-1',
    });

    await fireEvent.click(ring);
    const panel = await findByTestId('context-window');
    expect(panel.querySelectorAll('[data-category]')).toHaveLength(5);
  });

  test('says the window is unavailable when the Bureau cannot measure it', async () => {
    serve({
      'bureau.contexts.window': () => {
        throw new Error('no');
      },
    });
    const { findByText } = mount();

    expect(await findByText(CHAT_COPY.contextWindow.unavailable)).not.toBeNull();
  });

  test('reads the window again when the model is switched, since a model has a window of its own', async () => {
    let switched = false;
    const served = serve({
      'bureau.contexts.get': () => ({
        ...CONTEXT,
        model: switched ? { provider: 'anthropic', model: 'claude-haiku-4-5' } : null,
        configVersion: switched ? 2 : 1,
      }),
      'bureau.contexts.steer': () => {
        switched = true;
        return { outcome: 'accepted', command: {} };
      },
    });
    const { container } = mount();
    await waitFor(() => expect(control(container, 'weft-chat-model')?.options.length).toBe(2));
    const windowReads = () =>
      served.calls.filter((call) => call.method === 'bureau.contexts.window').length;
    const before = windowReads();
    const model = control(container, 'weft-chat-model');
    const haiku = [...(model?.options ?? [])].find((option) => option.value.endsWith('haiku-4-5'));
    if (model === null || haiku === undefined) throw new Error('The model picker did not render.');

    await fireEvent.change(model, { target: { value: haiku.value } });

    await waitFor(() => expect(windowReads()).toBeGreaterThan(before));
    await waitFor(() => expect(shown(container, 'model')).toBe('Claude Haiku 4.5'));
  });
});

describe('changing a setting from the composer', () => {
  async function changePermission(container: HTMLElement, value: string): Promise<void> {
    await waitFor(() => expect(control(container, 'weft-chat-permission')?.disabled).toBe(false));
    const select = control(container, 'weft-chat-permission');
    if (select === null) throw new Error('The permission select did not render.');
    await fireEvent.change(select, { target: { value } });
  }

  test('sets the permission mode with the revision it read, and shows it once the chat is read again', async () => {
    let mode = 'on-changes';
    const served = serve({
      'bureau.contexts.get': () => ({
        ...CONTEXT,
        permissionMode: mode,
        configVersion: mode === 'on-changes' ? 1 : 2,
      }),
      'bureau.contexts.steer': (params) => {
        mode = String(params['permissionMode']);
        return { outcome: 'accepted', command: {} };
      },
    });
    const { container } = mount();
    await waitFor(() => expect(shown(container, 'permission')).toBe('Ask on changes'));

    await changePermission(container, 'read-only');

    await waitFor(() => expect(shown(container, 'permission')).toBe('Read-only'));
    const steer = served.calls.find((call) => call.method === 'bureau.contexts.steer');
    expect(steer?.params).toMatchObject({
      contextId: 'session-1',
      permissionMode: 'read-only',
      expectedRevision: 1,
    });
    expect(control(container, 'weft-chat-permission')?.value).toBe('read-only');
  });

  test('says an idle chat takes a change for its next run', async () => {
    serve({ 'bureau.contexts.steer': () => ({ outcome: 'accepted', command: {} }) });
    const { container } = mount();

    await changePermission(container, 'always');

    await waitFor(() => expect(note(container)).toContain(SETTINGS.applies.nextRun));
  });

  test('says a running chat takes a mode from its next tool call, and an effort or model from its next step', async () => {
    serve({ 'bureau.contexts.steer': () => ({ outcome: 'accepted', command: {} }) }, true);
    const { container } = mount();
    await waitFor(() =>
      expect(container.querySelector('[aria-label="Stop generating"]') === null).toBe(false),
    );
    await tick();

    await changePermission(container, 'always');
    await waitFor(() => expect(note(container)).toContain(SETTINGS.applies.toolCall));

    await waitFor(() => expect(control(container, 'weft-chat-effort')?.disabled).toBe(false));
    const effort = control(container, 'weft-chat-effort');
    if (effort === null) throw new Error('The effort select did not render.');
    await fireEvent.change(effort, { target: { value: 'high' } });
    await waitFor(() => expect(note(container)).toContain(SETTINGS.applies.step));
    expect(note(container)).not.toContain(SETTINGS.applies.toolCall);
  });

  test('says nothing of when a change applies when the Bureau refused it', async () => {
    serve({
      'bureau.contexts.steer': () => ({
        outcome: 'rejected',
        failure: { failedAt: 'now', reason: 'policy-denied' },
      }),
    });
    const { container, findByText } = mount();

    await changePermission(container, 'always');

    expect(await findByText(SETTINGS.permissionNotices.denied)).not.toBeNull();
    expect(note(container)).toBe('');
  });
});
