/**
 * The conversation page's two new controls over a stubbed Bureau: Branch from here on the final
 * agent message of each completed turn, and the model picker in the composer. Each opens on a
 * finished session, whose transcript the page reads from the mount.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { CHAT_COPY } from '../../app/copy.ts';
import { StubFault } from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import ChatConversation from './chat-conversation.svelte';
import { AGENT, bureau, CONTEXT, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const TURNS = [
  { id: 'u1', role: 'user', content: 'First question' },
  { id: 'a1', role: 'assistant', content: 'First answer' },
  { id: 'u2', role: 'user', content: 'Second question' },
  { id: 'a2', role: 'assistant', content: 'Second answer' },
];

/** A Bureau holding the session `session-1`, whose transcript is `messages`. */
function serve(
  messages: readonly unknown[] = TURNS,
  answers: Record<string, (params: Record<string, unknown>) => unknown> = {},
) {
  const served = bureau(
    {
      'bureau.agents.list': () => ({ agents: [AGENT] }),
      'bureau.agents.models': () => ({ selectable: true, models: [], default: null }),
      'bureau.contexts.get': () => CONTEXT,
      'bureau.tasks.list': () => ({ tasks: [], nextOffset: null }),
      ...answers,
    },
    (url) => {
      if (url.endsWith('/messages')) return Response.json({ threadId: 'session-1', messages });
      if (url.includes('/threads/')) {
        return new Response(
          `data: ${JSON.stringify({ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return undefined;
    },
  );
  restore = served.restore;
  landAt('/chat/session-1');
  return served;
}

const mount = () =>
  render(QueryPage, {
    props: {
      page: ChatConversation,
      pageProps: { sessionId: 'session-1', title: 'Plan the week', agentName: 'assistant' },
    },
  } as never);

const BRANCH = { name: CHAT_COPY.branch.action };

describe('Branch from here', () => {
  test('is offered on the final agent message of each completed turn, and on no other message', async () => {
    serve();
    const { findByText, findAllByRole } = mount();
    await findByText('Second answer');

    const buttons = await findAllByRole('button', BRANCH);
    expect(buttons).toHaveLength(2);
  });

  test('is offered on the last agent message of a session that has only one turn', async () => {
    serve(TURNS.slice(0, 2));
    const { findByText, findAllByRole } = mount();
    await findByText('First answer');

    expect(await findAllByRole('button', BRANCH)).toHaveLength(1);
  });

  test('branches through that message, and opens the new session', async () => {
    const served = serve(TURNS, {
      'bureau.contexts.fork': () => ({ contextId: 'branch-1', carriedOverride: null }),
    });
    const { findByText, findAllByRole } = mount();
    await findByText('Second answer');

    const [first] = await findAllByRole('button', BRANCH);
    if (first === undefined) throw new Error('The first reply offers no branch.');
    await fireEvent.click(first);

    await waitFor(() => expect(router.pathname).toBe('/chat/branch-1'));
    const [fork] = served.calls.filter((call) => call.method === 'bureau.contexts.fork');
    expect(fork?.params).toMatchObject({ contextId: 'session-1', throughMessageId: 'a1' });
    expect(typeof fork?.params['commandId']).toBe('string');
  });

  const refusals: ReadonlyArray<readonly [string, StubFault, string]> = [
    [
      'a turn that ended in an error',
      new StubFault('Conflict', 409, 'It ended in error.', { reason: 'branch-from-errored-run' }),
      CHAT_COPY.branch.refused['branch-from-errored-run'],
    ],
    [
      'a message that is not a branch point',
      new StubFault('Conflict', 409, 'Not a branch point.', { reason: 'not-a-branch-point' }),
      CHAT_COPY.branch.refused['not-a-branch-point'],
    ],
    [
      'a request that fails for another reason',
      new StubFault('Unavailable', 503, 'The Bureau is not answering.'),
      CHAT_COPY.branch.fault,
    ],
  ];

  for (const [name, fault, copy] of refusals) {
    test(`says why and stays on this session for ${name}`, async () => {
      serve(TURNS, {
        'bureau.contexts.fork': () => {
          throw fault;
        },
      });
      const { findByText, findAllByRole } = mount();
      await findByText('Second answer');

      const [first] = await findAllByRole('button', BRANCH);
      if (first === undefined) throw new Error('The first reply offers no branch.');
      await fireEvent.click(first);

      expect(await findByText(copy)).not.toBeNull();
      expect(router.pathname).toBe('/chat/session-1');
    });
  }
});

describe('a refused branch', () => {
  test('is told once, and the alert can be dismissed', async () => {
    serve(TURNS, {
      'bureau.contexts.fork': () => {
        throw new StubFault('Unavailable', 503, 'The Bureau is not answering.');
      },
    });
    const { findByText, findAllByRole, findByRole, queryByText } = mount();
    await findByText('Second answer');
    const [first] = await findAllByRole('button', BRANCH);
    if (first === undefined) throw new Error('The first reply offers no branch.');

    await fireEvent.click(first);
    await findByText(CHAT_COPY.branch.fault);
    await fireEvent.click(await findByRole('button', { name: 'Dismiss alert' }));

    await waitFor(() => expect(queryByText(CHAT_COPY.branch.fault) === null).toBe(true));
  });
});

describe('a branch’s header', () => {
  test('says where the session was branched from, with a link to the parent', async () => {
    serve(TURNS, {
      'bureau.contexts.get': (params) =>
        params['contextId'] === 'parent-1'
          ? { ...CONTEXT, id: 'parent-1', title: 'The original chat' }
          : { ...CONTEXT, parentContextId: 'parent-1', forkedFromMessageId: 'a1' },
    });
    const { findByRole, container } = mount();

    const link = await findByRole('link', { name: 'The original chat' });
    expect(link.getAttribute('href')).toBe('/chat/parent-1');
    expect(container.querySelector('.weft-chat-header')?.textContent).toContain(
      CHAT_COPY.branch.branchedFrom,
    );
  });

  test('says nothing of a branch for a session that is not one', async () => {
    serve();
    const { findByText, container } = mount();
    await findByText('Second answer');

    expect(container.querySelector('.weft-chat-header__origin') === null).toBe(true);
  });
});

describe('the model picker in a session’s composer', () => {
  test('lists the models the agent allows, with the session’s own model selected', async () => {
    const models = [
      { provider: 'anthropic', model: 'claude-sonnet-5', displayName: 'claude-sonnet-5' },
      { provider: 'anthropic', model: 'claude-haiku-4-5', displayName: 'claude-haiku-4-5' },
    ];
    const served = serve(TURNS, {
      'bureau.agents.models': () => ({ selectable: true, models, default: models[0] }),
      'bureau.contexts.get': () => ({
        ...CONTEXT,
        model: { provider: 'anthropic', model: 'claude-haiku-4-5' },
        configVersion: 4,
      }),
    });
    const { container, findByText } = mount();
    await findByText('Second answer');

    await waitFor(() => expect(container.querySelector('select') === null).toBe(false));
    const select = container.querySelector('select');
    expect(select?.value.endsWith('claude-haiku-4-5')).toBe(true);
    expect(served.calls.find((call) => call.method === 'bureau.agents.models')?.params).toEqual({
      agentName: 'assistant',
    });
  });

  test('switches the session, reads it again, and shows the model the session has afterwards', async () => {
    const models = [
      { provider: 'anthropic', model: 'claude-sonnet-5', displayName: 'claude-sonnet-5' },
      { provider: 'anthropic', model: 'claude-haiku-4-5', displayName: 'claude-haiku-4-5' },
    ];
    let switched = false;
    const served = serve(TURNS, {
      'bureau.agents.models': () => ({ selectable: true, models, default: models[0] }),
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
    const { container, findByText } = mount();
    await findByText('Second answer');
    await waitFor(() => expect(container.querySelector('select') === null).toBe(false));
    const select = container.querySelector('select');
    if (select === null) throw new Error('The picker did not render.');
    expect(select.value.endsWith('claude-sonnet-5')).toBe(true);

    const haiku = [...select.options].find((option) => option.value.endsWith('claude-haiku-4-5'));
    if (haiku === undefined) throw new Error('The picker lists no claude-haiku-4-5.');
    await fireEvent.change(select, { target: { value: haiku.value } });

    await waitFor(() =>
      expect(served.calls.filter((call) => call.method === 'bureau.contexts.steer')).toHaveLength(
        1,
      ),
    );
    const steer = served.calls.find((call) => call.method === 'bureau.contexts.steer');
    expect(steer?.params['expectedRevision']).toBe(1);
    // The session is read again after the switch, which is where the new model comes from.
    await waitFor(() => expect(select.value.endsWith('claude-haiku-4-5')).toBe(true));
    await waitFor(() =>
      expect(served.calls.filter((call) => call.method === 'bureau.contexts.get').length).toBe(2),
    );
  });

  test('is not there when the agent allows one model', async () => {
    serve(TURNS);
    const { container, findByText } = mount();
    await findByText('Second answer');

    expect(container.querySelector('select') === null).toBe(true);
  });
});
