/**
 * Try it, in the agent editor: a throwaway chat with the form as it stands. It starts from the
 * unsaved draft, saves nothing, and ends (the Bureau deletes the chat's context) when the drawer
 * closes, when the person starts over, and when the page is left, however the start is timed.
 */
import { fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
import {
  catalogFixture,
  faults,
  installBureauStub,
  readyAgent,
  StubFault,
  type BureauHandler,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import Harness from './agent-editor-test-harness.test-harness.svelte';

const copy = AGENT_EDITOR_COPY;
const TRIED = { contextId: 'ctx-1', agentName: 'try:one', taskId: 'task-1' };

let stub: BureauStub | undefined;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate('/', { replace: true });
});

afterEach(() => {
  stub?.restore();
  stub = undefined;
});

function bureau(
  handlers: Record<string, BureauHandler> = {},
  options: Parameters<typeof installBureauStub>[1] = {},
): BureauStub {
  stub = installBureauStub(
    {
      'bureau.agents.catalog': () => catalogFixture(),
      'bureau.agents.definitions.get': () => readyAgent(),
      'bureau.agents.definitions.revisions': () => ({ revisions: [] }),
      'bureau.agents.versions.list': () => ({ versions: [] }),
      'bureau.agents.definitions.create': () => ({ id: 'x', hash: 'created' }),
      'bureau.agents.definitions.update': () => ({ id: 'researcher', hash: 'hash-2' }),
      'bureau.agents.try': () => TRIED,
      'bureau.contexts.delete': (params) => ({
        contextId: params['contextId'],
        receipt: 'applied',
      }),
      ...handlers,
    },
    options,
  );
  return stub;
}

function mount(id: string | undefined = 'researcher') {
  return render(Harness, { props: id === undefined ? {} : { id } } as never);
}

type View = ReturnType<typeof mount>;

async function type(element: HTMLElement, value: string): Promise<void> {
  await fireEvent.input(element, { target: { value } });
}

/** Opens the drawer and starts a chat with `message`. */
async function startChat(view: View, message = 'Hello there'): Promise<void> {
  await fireEvent.click(await view.findByRole('button', { name: copy.try.action }));
  await type(await view.findByRole('textbox', { name: 'Message' }), message);
  await fireEvent.click(view.getByRole('button', { name: /^Send/ }));
}

describe('Try it', () => {
  test('talks to the unsaved draft, and writes nothing', async () => {
    const calls = bureau();
    const where = router.pathname;
    const view = mount();
    await type(
      await view.findByRole('textbox', { name: /^Instructions/ }),
      'Answer only in haiku.',
    );
    await startChat(view, 'Say hi');

    await view.findByRole('region', { name: copy.try.chatLabel });
    // The draft is what was tried: the unsaved instructions, with the rest of the form.
    expect(calls.callsTo('bureau.agents.try')).toEqual([
      {
        method: 'bureau.agents.try',
        params: {
          definition: expect.objectContaining({
            name: 'Researcher',
            model: 'anthropic/sonnet',
            tools: ['lookup-order'],
            instructions: 'Answer only in haiku.',
          }),
          message: 'Say hi',
        },
      },
    ]);
    expect(view.getByTestId('agent-try').getAttribute('data-context-id')).toBe('ctx-1');
    // No file: nothing was created or updated, and the page did not move.
    expect(calls.callsTo('bureau.agents.definitions.create')).toEqual([]);
    expect(calls.callsTo('bureau.agents.definitions.update')).toEqual([]);
    expect(router.pathname).toBe(where);
  });

  test('tries a new agent before it is saved', async () => {
    const calls = bureau();
    const view = mount(undefined);
    await view.findByRole('textbox', { name: /^Name/ });
    await startChat(view);
    await view.findByRole('region', { name: copy.try.chatLabel });
    expect(calls.callsTo('bureau.agents.try')).toHaveLength(1);
    expect(calls.callsTo('bureau.agents.definitions.create')).toEqual([]);
  });

  test('ends the chat when the drawer is closed', async () => {
    const calls = bureau();
    const view = mount();
    await startChat(view);
    await view.findByRole('region', { name: copy.try.chatLabel });
    expect(calls.callsTo('bureau.contexts.delete')).toEqual([]);

    await fireEvent.click(view.getByRole('button', { name: copy.try.close }));

    await waitFor(() =>
      expect(calls.callsTo('bureau.contexts.delete')).toEqual([
        { method: 'bureau.contexts.delete', params: { contextId: 'ctx-1' } },
      ]),
    );
    // Opening it again starts from the composer, not the old chat.
    await fireEvent.click(view.getByRole('button', { name: copy.try.action }));
    await view.findByRole('textbox', { name: 'Message' });
    expect(view.queryByRole('region', { name: copy.try.chatLabel })).toBeNull();
  });

  test('ends the chat when the page is left', async () => {
    const calls = bureau();
    const view = mount();
    await startChat(view);
    await view.findByRole('region', { name: copy.try.chatLabel });

    view.unmount();

    await waitFor(() =>
      expect(calls.callsTo('bureau.contexts.delete')).toEqual([
        { method: 'bureau.contexts.delete', params: { contextId: 'ctx-1' } },
      ]),
    );
  });

  test('ends the chat with a request that outlives the page when the page is hidden', async () => {
    const calls = bureau();
    const view = mount();
    await startChat(view);
    await view.findByRole('region', { name: copy.try.chatLabel });

    window.dispatchEvent(new window.Event('pagehide'));

    await waitFor(() =>
      expect(calls.callsTo('bureau.contexts.delete')).toEqual([
        { method: 'bureau.contexts.delete', params: { contextId: 'ctx-1' } },
      ]),
    );
  });

  test('starts over with the form as it is now, ending the earlier chat', async () => {
    let started = 0;
    const calls = bureau({
      'bureau.agents.try': () => {
        started += 1;
        return {
          contextId: `ctx-${String(started)}`,
          agentName: `try:${String(started)}`,
          taskId: 't',
        };
      },
    });
    const view = mount();
    await startChat(view);
    await view.findByRole('region', { name: copy.try.chatLabel });
    expect(view.queryByTestId('agent-try-changed')).toBeNull();

    // The form moved on: the chat says it is the earlier version.
    await type(await view.findByRole('textbox', { name: /^Instructions/ }), 'Different now.');
    const notice = await view.findByTestId('agent-try-changed');
    expect(notice.textContent).toBe(copy.try.changed);

    await fireEvent.click(view.getByRole('button', { name: copy.try.startOver }));
    await waitFor(() =>
      expect(calls.callsTo('bureau.contexts.delete')[0]?.params).toEqual({ contextId: 'ctx-1' }),
    );
    await type(await view.findByRole('textbox', { name: 'Message' }), 'Again');
    await fireEvent.click(view.getByRole('button', { name: /^Send/ }));
    await view.findByRole('region', { name: copy.try.chatLabel });
    expect(calls.callsTo('bureau.agents.try')[1]?.params).toMatchObject({
      definition: { instructions: 'Different now.' },
      message: 'Again',
    });
    expect(view.queryByTestId('agent-try-changed')).toBeNull();
  });

  test('deletes a chat that was still starting when the drawer closed', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = bureau({
      'bureau.agents.try': async () => {
        await gate;
        return TRIED;
      },
    });
    const view = mount();
    await startChat(view);
    await fireEvent.click(view.getByRole('button', { name: copy.try.close }));
    expect(calls.callsTo('bureau.contexts.delete')).toEqual([]);

    release?.();

    await waitFor(() =>
      expect(calls.callsTo('bureau.contexts.delete')).toEqual([
        { method: 'bureau.contexts.delete', params: { contextId: 'ctx-1' } },
      ]),
    );
    expect(view.queryByRole('region', { name: copy.try.chatLabel })).toBeNull();
  });

  test('says why a definition cannot be tried, and starts no chat', async () => {
    const calls = bureau({
      'bureau.agents.try': () => {
        throw faults.unprocessable('The definition cannot be tried: tools.0: writes memory');
      },
    });
    const view = mount();
    await startChat(view);

    const failure = await view.findByTestId('agent-try-failure');
    expect(failure.textContent).toContain('writes memory');
    expect(view.queryByRole('region', { name: copy.try.chatLabel })).toBeNull();
    expect(calls.callsTo('bureau.contexts.delete')).toEqual([]);
    // The composer is back, so a corrected form can be tried.
    expect(view.getByRole('textbox', { name: 'Message' })).not.toBeNull();
  });

  test('does not warn about a chat that is already gone, and warns about one that cannot be removed', async () => {
    const calls = bureau({
      'bureau.contexts.delete': () => {
        throw faults.notFound('ctx-1');
      },
    });
    const view = mount();
    await startChat(view);
    await view.findByRole('region', { name: copy.try.chatLabel });
    await fireEvent.click(view.getByRole('button', { name: copy.try.close }));
    await waitFor(() => expect(calls.callsTo('bureau.contexts.delete')).toHaveLength(1));
    expect(view.queryByText(copy.try.notRemoved)).toBeNull();

    calls.on('bureau.contexts.delete', () => {
      throw faults.unprocessable('cannot delete');
    });
    await startChat(view, 'Again');
    await view.findByRole('region', { name: copy.try.chatLabel });
    await fireEvent.click(view.getByRole('button', { name: copy.try.startOver }));
    await view.findByText(copy.try.notRemoved);
  });

  test('says when the caller may not try agents', async () => {
    bureau({
      'bureau.agents.try': () => {
        throw new StubFault('Forbidden', 403, 'Forbidden');
      },
    });
    const view = mount();
    await startChat(view);
    const failure = await view.findByTestId('agent-try-failure');
    expect(failure.textContent).toBe(copy.try.forbidden);
  });

  test('is off while the form cannot be tried', async () => {
    bureau();
    const view = mount();
    const button = await view.findByRole('button', { name: copy.try.action });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await type(await view.findByRole('textbox', { name: /^Steps per run/ }), 'many');
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
  });
  test('with no model provider connected the shared blocked row stands in for the composer, over an empty transcript', async () => {
    bureau({}, { hostProviders: [{ name: 'anthropic', hasKey: false }] });
    const view = mount();
    await fireEvent.click(await view.findByRole('button', { name: copy.try.action }));

    await view.findByText('Connect a model provider to chat');
    await view.findByText('Connect a provider');
    expect(view.queryByRole('textbox', { name: 'Message' })).toBeNull();
    expect(view.getByText(copy.try.usesChanges)).not.toBeNull();
    // Reset has nothing to reset until a chat has started.
    expect(
      (view.getByRole('button', { name: copy.try.startOver }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test('the composer is one line, “Send a test message”, with the line about real tools under it', async () => {
    bureau({}, { hostProviders: [{ name: 'anthropic', hasKey: true }] });
    const view = mount();
    await fireEvent.click(await view.findByRole('button', { name: copy.try.action }));

    const field = await view.findByRole('textbox', { name: 'Message' });
    expect(field.getAttribute('placeholder')).toBe(copy.try.messagePlaceholder);
    expect(view.getByText(copy.try.hint)).not.toBeNull();
    expect(view.queryByText('Connect a model provider to chat')).toBeNull();
  });

  describe('while the first answer is being read', () => {
    const encoder = new TextEncoder();
    const frame = (event: unknown) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    const sse = (events: readonly unknown[], open = false) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) controller.enqueue(frame(event));
          if (!open) controller.close();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    };
    const started = { type: 'RUN_STARTED', threadId: 'ctx-1', runId: 'task-1' };

    function tryWith(
      agUi: NonNullable<NonNullable<Parameters<typeof installBureauStub>[1]>['agUi']>,
    ) {
      bureau(
        {
          'bureau.tasks.list': () => ({ tasks: [], nextPageToken: null }),
          'bureau.contexts.get': () => ({ id: 'ctx-1' }),
        },
        { hostProviders: [{ name: 'anthropic', hasKey: true }], agUi },
      );
      return mount();
    }

    test('Send becomes Stop and the “Send a test message” field is disabled, though the chat takes follow-ups', async () => {
      const view = tryWith(() =>
        sse(
          [
            started,
            { type: 'TEXT_MESSAGE_START', messageId: 'run-1:step:0', role: 'assistant' },
            {
              type: 'TEXT_MESSAGE_CONTENT',
              messageId: 'run-1:step:0',
              delta: 'Category: damaged item, urgency',
            },
          ],
          true,
        ),
      );
      await startChat(view, 'My order 4471 arrived broken.');

      await view.findByText(/Category: damaged item, urgency/);
      const field = await view.findByRole('textbox', { name: 'Message' });
      await waitFor(() => expect((field as HTMLTextAreaElement).disabled).toBe(true));
      expect(view.getByRole('button', { name: 'Stop generating' })).not.toBeNull();
      expect(view.queryByRole('button', { name: /^Send/ })).toBeNull();
    });

    test('a tool call under way reads “Using Lookup order…” under the message, beside the partial reply', async () => {
      const view = tryWith(() =>
        sse(
          [
            started,
            { type: 'TEXT_MESSAGE_START', messageId: 'run-1:step:0', role: 'assistant' },
            { type: 'TEXT_MESSAGE_CONTENT', messageId: 'run-1:step:0', delta: 'Category: damaged' },
            { type: 'TEXT_MESSAGE_END', messageId: 'run-1:step:0' },
            {
              type: 'TOOL_CALL_START',
              toolCallId: 'call-1',
              toolCallName: 'lookup-order',
              parentMessageId: 'run-1:step:0',
            },
            { type: 'TOOL_CALL_ARGS', toolCallId: 'call-1', delta: '{"orderId":"4471"}' },
            { type: 'TOOL_CALL_END', toolCallId: 'call-1' },
          ],
          true,
        ),
      );
      await startChat(view, 'My order 4471 arrived broken.');

      // The group's line is the call in the present tense, and its row says the same inside.
      await view.findAllByText(/Using/);
      expect(
        view.container
          .querySelector('.chat-tool-call-heading')
          ?.textContent?.replace(/\s+/g, ' ')
          .trim(),
      ).toBe('Using Lookup order…');
      expect(view.container.textContent).toContain('Category: damaged');
      expect(view.getByText(copy.try.hint)).not.toBeNull();
    });

    test('a failed answer is a titled danger block under the message, with what failed, that nothing was saved, and Try again', async () => {
      const view = tryWith(() =>
        sse([
          started,
          {
            type: 'RUN_ERROR',
            message: 'The provider answered with an error (429, too many requests).',
          },
        ]),
      );
      await startChat(view, 'My order 4471 arrived broken.');

      const block = await view.findByTestId('agent-try-answer-failure');
      expect(block.textContent).toContain(copy.try.failureTitle);
      expect(block.textContent).toContain('429, too many requests');
      expect(block.textContent).toContain(copy.try.nothingSaved);
      expect(
        block.querySelector('[role="alert"], [data-cinder-variant="danger"], .cinder-alert'),
      ).not.toBeNull();
      expect(within(block).getByRole('button', { name: copy.try.tryAgain })).not.toBeNull();
      // The board's shape: a glyph, a heading in the severity colour, the body in the default text
      // colour, and Try again at the right, in the alert's own actions slot.
      expect(block.querySelector('.cinder-alert__icon svg')).not.toBeNull();
      expect(block.querySelector('.cinder-alert__heading')?.textContent).toBe(
        copy.try.failureTitle,
      );
      expect(block.querySelector('.cinder-alert__body')?.textContent).toContain('429');
      expect(
        block
          .querySelector('.cinder-alert__actions')
          ?.contains(within(block).getByRole('button', { name: copy.try.tryAgain })),
      ).toBe(true);
    });
  });
});
