/**
 * The conversation page, a run that waits on a question (COR-1857): the question is drawn in the
 * control its answer schema asks for and answered there, the number keys pick a choice, and a
 * question without a schema is answered in the composer.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { shortcuts } from '../../lib/shortcuts.ts';
import ChatConversation from './chat-conversation.svelte';
import { bureau, CONTEXT, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const sse = (events: readonly unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

function ask(answer: unknown) {
  return {
    id: 'human-wait:native-1:environment:0',
    reason: 'human-wait',
    message: 'Which environment should the release go to?',
    ...(answer === undefined
      ? {}
      : {
          responseSchema: {
            type: 'object',
            properties: { decision: { enum: ['approve', 'deny', 'reject'] }, answer },
            required: ['decision'],
          },
        }),
  };
}

type Body = {
  messages: unknown[];
  resume?: Array<{ interruptId: string; status: string; payload: unknown }>;
};

/** A Bureau whose first run parks on `wait` and whose second finishes; `calls` has what it was asked. */
function serve(wait: unknown, more: Record<string, () => unknown> = {}) {
  const bodies: Body[] = [];
  const served = bureau({ 'bureau.contexts.get': () => CONTEXT, ...more }, (url, init) => {
    if (url.endsWith('/messages')) return Response.json({ threadId: 'session-1', messages: [] });
    if (url.includes('/threads/')) {
      return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
    }
    if (!url.includes('/agents/')) return undefined;
    bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
    const first = bodies.length === 1;
    return sse([
      { type: 'RUN_STARTED', threadId: 'session-1', runId: `run-${bodies.length}` },
      {
        type: 'RUN_FINISHED',
        threadId: 'session-1',
        runId: `run-${bodies.length}`,
        outcome: first ? { type: 'interrupt', interrupts: [wait] } : { type: 'success' },
      },
    ]);
  });
  restore = served.restore;
  return { bodies, calls: served.calls };
}

async function open() {
  landAt('/chats/session-1');
  const view = render(QueryPage, {
    props: {
      page: ChatConversation,
      pageProps: { sessionId: 'session-1', title: 'Plan the week', agentName: 'assistant' },
    },
  } as never);
  await view.findByText('Plan the week');
  const box = view.container.querySelector('textarea');
  if (box === null) throw new Error('The composer did not render.');
  await fireEvent.input(box, { target: { value: 'Ship it' } });
  await fireEvent.keyDown(box, { key: 'Enter' });
  return view;
}

/** Presses `key` where the chat route is on screen, as the shell's key listener would. */
function press(key: string): boolean {
  return shortcuts.handleKey(
    { key, metaKey: false, ctrlKey: false, altKey: false, editable: false },
    { routePattern: '/chats/:chat', regions: [] },
    0,
  );
}

const CHOICES = { type: 'string', enum: ['staging', 'production'] };

describe('a question with choices', () => {
  test('draws them as buttons under the question, and the one pressed is the answer', async () => {
    const { bodies } = serve(ask(CHOICES));
    const { findByText, findByRole, queryByText } = await open();

    expect(await findByText('Which environment should the release go to?')).not.toBeNull();
    await fireEvent.click(await findByRole('button', { name: 'production' }));

    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]?.messages).toEqual([]);
    expect(bodies[1]?.resume).toEqual([
      {
        interruptId: 'human-wait:native-1:environment:0',
        status: 'resolved',
        payload: { decision: 'approve', answer: 'production' },
      },
    ]);
    await waitFor(() =>
      expect(
        queryByText('Which environment should the release go to?')?.textContent ?? null,
      ).toBeNull(),
    );
  });

  test('is picked with its number key, and a number with no choice does nothing', async () => {
    const { bodies } = serve(ask(CHOICES));
    const { findByRole, findByText } = await open();
    await findByRole('button', { name: 'staging' });
    expect(await findByText('Press 1 to 9 to pick a choice.')).not.toBeNull();

    expect(press('9')).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(press('1')).toBe(true);

    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]?.resume?.[0]?.payload).toEqual({ decision: 'approve', answer: 'staging' });
  });

  test('registers 1 to 9 for the chat route only, and takes them away when the page goes', async () => {
    serve(ask(CHOICES));
    const { unmount, findByRole } = await open();
    await findByRole('button', { name: 'staging' });

    const registered = () =>
      shortcuts
        .entries()
        .filter((entry) => entry.group === 'Chat')
        .map((entry) => ({ keys: entry.keys, scope: entry.scope }));
    expect(registered()).toEqual(
      Array.from({ length: 9 }, (_, index) => ({
        keys: [String(index + 1)],
        scope: { route: '/chats/:chat' },
      })),
    );

    unmount();

    expect(registered()).toEqual([]);
  });
});

describe('a question whose answer is a form', () => {
  test('is answered with the object the form was filled in with', async () => {
    const { bodies } = serve(
      ask({
        type: 'object',
        properties: { region: { type: 'string', title: 'Region' } },
        required: ['region'],
      }),
    );
    const { container, findByLabelText } = await open();

    await fireEvent.input(await findByLabelText(/Region/), { target: { value: 'eu' } });
    const question = container.querySelector<HTMLElement>('.weft-chat-question')!;
    await fireEvent.click(within(question).getByRole('button', { name: /submit/i }));

    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]?.resume?.[0]?.payload).toEqual({
      decision: 'approve',
      answer: { region: 'eu' },
    });
  });
});

describe('a question whose answer is a file', () => {
  test('uploads the file and answers with the asset it became', async () => {
    const { bodies, calls } = serve(
      ask({ type: 'string', contentMediaType: 'image/png', 'x-asset': true }),
      {
        'bureau.assets.uploads.create': () => ({ uploadId: 'upload-1' }),
        'bureau.assets.uploads.append': () => ({}),
        'bureau.assets.uploads.complete': () => ({ assetId: 'asset-42', mediaType: 'image/png' }),
      },
    );
    const { container } = await open();
    await waitFor(() => expect(container.querySelector('input[type="file"]')).not.toBeNull());
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', {
      value: [new File(['x'], 'logo.png', { type: 'image/png' })],
      configurable: true,
    });
    await fireEvent.change(input);

    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(calls.map((call) => call.method)).toContain('bureau.assets.uploads.complete');
    expect(bodies[1]?.resume?.[0]?.payload).toEqual({ decision: 'approve', answer: 'asset-42' });
  });
});

describe('a question with no schema', () => {
  test('is answered in the composer, and draws no field of its own', async () => {
    const { bodies } = serve(ask(undefined));
    const { container, findByText } = await open();

    expect(await findByText('Answer below')).not.toBeNull();
    expect(container.querySelector('.chat-question textarea')).toBeNull();
    const box = container.querySelector('textarea')!;
    await fireEvent.input(box, { target: { value: 'staging' } });
    await fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]?.resume?.[0]?.payload).toEqual({ decision: 'approve', answer: 'staging' });
  });
});
