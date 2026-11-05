/**
 * The conversation page's composer controls for the chat's settings, over a stubbed Bureau: the
 * model, effort and permission mode are ghost selects on the composer's control row, each is
 * changed from there, the line under the composer says when a change takes effect, and the
 * context meter and the header's ring read `bureau.contexts.window`.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import { CHAT_COPY } from '../../app/copy.ts';
import { createQueryClient } from '../../lib/query.ts';
import type { Principal } from '../../lib/scopes.svelte.ts';
import ChatConversation from './chat-conversation.svelte';
import {
  chooseOption,
  optionDescriptions,
  shownLabel,
  shownPrefix,
} from './listbox.test-support.ts';
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

function mount(principal?: Principal) {
  return render(QueryPage, {
    props: {
      page: ChatConversation,
      pageProps: { sessionId: 'session-1', title: 'Plan the week', agentName: 'assistant' },
      client: createQueryClient(),
      ...(principal === undefined ? {} : { principal }),
    },
  } as never);
}

const control = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLButtonElement>(`[role="combobox"]#${id}`);
const shown = (container: HTMLElement, id: string) =>
  control(container, id) === null ? undefined : shownLabel(container, id);
const hint = (container: HTMLElement) =>
  container.querySelector('.chat-input-hint')?.textContent?.trim() ?? '';
const note = (container: HTMLElement) =>
  container.querySelector('.chat-input-status')?.textContent?.trim() ?? '';

describe('the composer’s settings', () => {
  test('always shows the model, the effort and the permission mode the chat runs with, named before their values', async () => {
    serve();
    const { container } = mount();

    await waitFor(() => expect(shown(container, 'weft-chat-model')).toBe('Claude Sonnet 5'));
    expect(shown(container, 'weft-chat-effort')).toBe(SETTINGS.agentDefault);
    expect(shown(container, 'weft-chat-permission')).toBe('On changes asks');
    expect(shownPrefix(container, 'weft-chat-model')).toBe('Model');
    expect(shownPrefix(container, 'weft-chat-effort')).toBe('Effort');
    expect(shownPrefix(container, 'weft-chat-permission')).toBe('Permissions');
    for (const id of ['weft-chat-model', 'weft-chat-effort', 'weft-chat-permission']) {
      expect(
        control(container, id)
          ?.closest('.cinder-select-field')
          ?.getAttribute('data-cinder-variant'),
      ).toBe('ghost');
    }
  });

  test('puts them in the composer’s control row, before the meter and Send', async () => {
    serve();
    const { container } = mount();
    await waitFor(() => expect(shown(container, 'weft-chat-model')).toBe('Claude Sonnet 5'));

    const left = container.querySelector('.chat-input-footer-left')!;
    for (const id of ['weft-chat-model', 'weft-chat-effort', 'weft-chat-permission']) {
      expect(left.contains(control(container, id))).toBe(true);
    }
    expect(
      container.querySelector('.chat-input-settings, [data-testid="chat-settings"]'),
    ).toBeNull();
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

    await waitFor(() => expect(shown(container, 'weft-chat-model')).toBe('Claude Haiku 4.5'));
    expect(shown(container, 'weft-chat-effort')).toBe('Extra high');
    expect(shown(container, 'weft-chat-permission')).toBe('Read-only');
  });

  test('shows the model of an agent that allows one though it offers no choice, and none for an agent that names no model', async () => {
    serve({
      'bureau.agents.models': () => ({ selectable: true, models: [SONNET], default: SONNET }),
    });
    const { container } = mount();

    await waitFor(() => expect(shown(container, 'weft-chat-model')).toBe('Claude Sonnet 5'));
    expect(control(container, 'weft-chat-model')?.disabled).toBe(true);
    cleanup();
    restore?.();

    // An agent that names no model has none to show: its composer holds Permissions only.
    serve({ 'bureau.agents.models': () => ({ selectable: true, models: [], default: null }) });
    const other = mount();
    await waitFor(() => expect(control(other.container, 'weft-chat-permission')).not.toBeNull());
    await waitFor(() => expect(control(other.container, 'weft-chat-model')).toBeNull());
  });

  test('says what each permission mode means, as the Bureau defines it, under its option', async () => {
    serve();
    const { container } = mount();
    await waitFor(() => expect(shown(container, 'weft-chat-permission')).toBe('On changes asks'));

    expect(await optionDescriptions(container, 'weft-chat-permission')).toEqual(
      SETTINGS.permissionOptions.map((option) => option.description),
    );
  });

  test('says nothing under the composer of a setting the chat has not changed', async () => {
    serve();
    const { container } = mount();
    await waitFor(() => expect(shown(container, 'weft-chat-permission')).toBe('On changes asks'));

    expect(note(container)).toBe('');
    expect(hint(container)).toBe('Enter to send · Shift and Enter for a new line');
  });

  test('holds no field: the header has the title and the ring', async () => {
    serve();
    const { container, findByRole } = mount();

    const heading = await findByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Plan the week');
    const header = container.querySelector('[data-testid="chat-header"]');
    expect(header?.querySelector('input, select')).toBeNull();
    expect(container.querySelector('[data-testid="chat-settings"]')).toBeNull();
  });

  test('draws a scripted agent’s composer with Permissions only', async () => {
    serve({
      'bureau.agents.models': () => ({ selectable: false, models: [], default: null }),
      'bureau.agents.list': () => ({ agents: [{ ...AGENT, media: null }] }),
    });
    const { container } = mount();

    // Until the agent is read, the composer cannot tell a scripted agent from a model's.
    await waitFor(() => expect(control(container, 'weft-chat-model')).toBeNull());
    expect(control(container, 'weft-chat-effort')).toBeNull();
    expect(control(container, 'weft-chat-permission')).not.toBeNull();
  });
});

describe('the context meter', () => {
  test('reads how full the window is, named Context 42%, with the tokens behind it as a tooltip', async () => {
    serve();
    const { container } = mount();

    const meter = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('.weft-context-meter [role="meter"]');
      if (found === null) throw new Error('The meter did not render.');
      return found;
    });
    expect(meter.getAttribute('aria-label')).toBe('Context 42%');
    expect(container.querySelector('.weft-context-meter__reading')?.textContent).toBe('42%');
    expect(container.querySelector('.chat-input-footer-right .weft-context-meter')).not.toBeNull();
    expect(document.body.textContent).toContain('84K of 200K tokens');
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
    await waitFor(() => expect(shown(container, 'weft-chat-model')).toBe('Claude Sonnet 5'));
    const windowReads = () =>
      served.calls.filter((call) => call.method === 'bureau.contexts.window').length;
    const before = windowReads();

    await chooseOption(container, 'Claude Haiku 4.5', 'weft-chat-model');

    await waitFor(() => expect(windowReads()).toBeGreaterThan(before));
    await waitFor(() => expect(shown(container, 'weft-chat-model')).toBe('Claude Haiku 4.5'));
  });
});

describe('changing a setting from the composer', () => {
  const PERMISSION_LABELS: Record<string, string> = Object.fromEntries(
    SETTINGS.permissionOptions.map((option) => [option.value, option.label]),
  );

  async function changePermission(container: HTMLElement, value: string): Promise<void> {
    await waitFor(() => expect(control(container, 'weft-chat-permission')?.disabled).toBe(false));
    await chooseOption(container, PERMISSION_LABELS[value] ?? value, 'weft-chat-permission');
  }

  async function changeEffort(container: HTMLElement, label: string): Promise<void> {
    await waitFor(() => expect(control(container, 'weft-chat-effort')?.disabled).toBe(false));
    await chooseOption(container, label, 'weft-chat-effort');
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
    await waitFor(() => expect(shown(container, 'weft-chat-permission')).toBe('On changes asks'));

    await changePermission(container, 'read-only');

    await waitFor(() => expect(shown(container, 'weft-chat-permission')).toBe('Read-only'));
    const steer = served.calls.find((call) => call.method === 'bureau.contexts.steer');
    expect(steer?.params).toMatchObject({
      contextId: 'session-1',
      permissionMode: 'read-only',
      expectedRevision: 1,
    });
  });

  test('says an idle chat takes a change for its next run', async () => {
    serve({ 'bureau.contexts.steer': () => ({ outcome: 'accepted', command: {} }) });
    const { container } = mount();

    await changePermission(container, 'always');

    await waitFor(() =>
      expect(note(container)).toBe(SETTINGS.applies.nextRun('Permissions', 'Always asks')),
    );
  });

  test('says a running chat takes a mode from its next tool call, and an effort or model from its next step', async () => {
    serve({ 'bureau.contexts.steer': () => ({ outcome: 'accepted', command: {} }) }, true);
    const { container } = mount();
    await waitFor(() =>
      expect(container.querySelector('[aria-label="Stop generating"]') === null).toBe(false),
    );
    await tick();

    await changePermission(container, 'always');
    await waitFor(() =>
      expect(note(container)).toBe(SETTINGS.applies.toolCall('Permissions', 'Always asks')),
    );

    await changeEffort(container, 'High');
    await waitFor(() => expect(note(container)).toBe(SETTINGS.applies.step('Effort', 'High')));
  });

  describe('a run parked on an approval or a question', () => {
    // It streams nothing, but the Bureau's reading of the chat says it is waiting, and it resumes
    // into the same run, which reads the mode at each tool call and the model and effort at each step.
    const parked = () => ({
      'bureau.contexts.get': () => ({ ...CONTEXT, configVersion: 1, activity: 'awaiting-input' }),
      'bureau.contexts.steer': () => ({ outcome: 'accepted', command: {} }),
    });

    test('takes a mode from its next tool call', async () => {
      serve(parked());
      const { container } = mount();

      await changePermission(container, 'allow-all');

      await waitFor(() =>
        expect(note(container)).toBe(SETTINGS.applies.toolCall('Permissions', 'Allow all')),
      );
    });

    test('takes an effort from its next step', async () => {
      serve(parked());
      const { container } = mount();

      await changeEffort(container, 'High');

      await waitFor(() => expect(note(container)).toBe(SETTINGS.applies.step('Effort', 'High')));
    });

    test('takes a model from its next step', async () => {
      serve(parked());
      const { container } = mount();
      await waitFor(() => expect(shown(container, 'weft-chat-model')).toBe('Claude Sonnet 5'));

      await chooseOption(container, 'Claude Haiku 4.5', 'weft-chat-model');

      await waitFor(() =>
        expect(note(container)).toBe(SETTINGS.applies.step('Model', 'Claude Haiku 4.5')),
      );
    });
  });

  describe('a chat another principal started', () => {
    const local = {
      scopes: [],
      subject: 'anonymous:local',
      unauthenticatedAccess: 'warn',
    } as const;

    test('holds the three controls, with the reason', async () => {
      serve({
        'bureau.contexts.get': () => ({ ...CONTEXT, owner: 'api-key:other', configVersion: 1 }),
      });
      const { container } = mount(local);
      await waitFor(() => expect(shown(container, 'weft-chat-model')).toBe('Claude Sonnet 5'));

      for (const id of ['weft-chat-model', 'weft-chat-effort', 'weft-chat-permission']) {
        expect(control(container, id)?.disabled).toBe(true);
        expect(control(container, id)?.title).toBe(SETTINGS.notYours);
      }
    });

    test('leaves them to the person whose chat it is', async () => {
      serve();
      const { container } = mount(local);

      await waitFor(() => expect(control(container, 'weft-chat-permission')?.disabled).toBe(false));
      expect(control(container, 'weft-chat-permission')?.title).toBe('');
    });
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
    expect(hint(container)).toBe('Enter to send · Shift and Enter for a new line');
  });
});
