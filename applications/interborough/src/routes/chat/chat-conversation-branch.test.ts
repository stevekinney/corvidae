/**
 * The conversation page's two new controls over a stubbed Bureau: Branch from here on the final
 * agent message of each completed turn, and the model picker in the composer. Each opens on a
 * finished session, whose transcript the page reads from the mount.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import { CHAT_COPY } from '../../app/copy.ts';
import { StubFault } from '../../lib/bureau-stub.test-support.ts';
import { createQueryClient, queryKeys } from '../../lib/query.ts';
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

function mount() {
  const client = createQueryClient();
  const view = render(QueryPage, {
    props: {
      page: ChatConversation,
      pageProps: { sessionId: 'session-1', title: 'Plan the week', agentName: 'assistant' },
      client,
    },
  } as never);
  return { ...view, client };
}

/**
 * Each agent reply on screen that has text, by its text, and whether it offers Branch from here. A
 * reply still being written has no text yet and is left out.
 */
function branchOffers(container: HTMLElement): Array<readonly [string, boolean]> {
  const offers: Array<readonly [string, boolean]> = [];
  for (const row of container.querySelectorAll('[data-message-role="assistant"]')) {
    const text = row.querySelector('p')?.textContent ?? '';
    if (text === '') continue;
    // The message's actions sit beside its article, under the element that holds both.
    const offered = [...(row.parentElement?.querySelectorAll('button') ?? [])].some(
      (button) => button.textContent?.trim() === CHAT_COPY.branch.action,
    );
    offers.push([text, offered]);
  }
  return offers;
}

const BRANCH = { name: CHAT_COPY.branch.action };

describe('Branch from here', () => {
  test('is offered on the final agent message of each completed turn, and on no other message', async () => {
    serve();
    const { findByText, findAllByRole } = mount();
    await findByText('Second answer');

    const buttons = await findAllByRole('button', BRANCH);
    expect(buttons.length).toBe(2);
  });

  test('is offered on the last reply of each completed run, and on none of the earlier steps of a run a follow-up was delivered to', async () => {
    serve([
      { id: 'u1', role: 'user', content: 'Start the work' },
      { id: 'run-1:step:0', role: 'assistant', content: 'Early reply' },
      { id: 'u2', role: 'user', content: 'Also this' },
      { id: 'run-1:step:1', role: 'assistant', content: 'Last reply of the first run' },
      { id: 'u3', role: 'user', content: 'Another question' },
      { id: 'run-2:step:0', role: 'assistant', content: 'Reply of the second run' },
    ]);
    const { container, findByText } = mount();
    await findByText('Reply of the second run');

    await waitFor(() => expect(branchOffers(container).some(([, offered]) => offered)).toBe(true));
    expect(branchOffers(container)).toEqual([
      ['Early reply', false],
      ['Last reply of the first run', true],
      ['Reply of the second run', true],
    ]);
  });

  test('is offered on no reply of the run that is going, which a follow-up row follows', async () => {
    // The page joins a run that is still going: its stream restores the transcript and stays open.
    const served = bureau(
      {
        'bureau.agents.list': () => ({ agents: [AGENT] }),
        'bureau.agents.models': () => ({ selectable: true, models: [], default: null }),
        'bureau.contexts.get': () => CONTEXT,
        'bureau.tasks.list': () => ({ tasks: [], nextOffset: null }),
      },
      (url) => {
        if (url.endsWith('/messages'))
          return Response.json({ threadId: 'session-1', messages: [] });
        if (!url.includes('/threads/')) return undefined;
        const frames = [
          { type: 'RUN_STARTED', threadId: 'session-1', runId: 'run-1' },
          {
            type: 'MESSAGES_SNAPSHOT',
            messages: [
              { id: 'u1', role: 'user', content: 'Start the work' },
              { id: 'run-1:step:0', role: 'assistant', content: 'Early reply' },
              { id: 'u2', role: 'user', content: 'Also this' },
            ],
          },
        ];
        return new Response(
          new ReadableStream({
            start(controller) {
              for (const frame of frames) {
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
              }
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    );
    restore = served.restore;
    landAt('/chat/session-1');
    const { container, findByText } = mount();
    await findByText('Early reply');
    // The run is going: Chat offers Stop.
    await waitFor(() =>
      expect(container.querySelector('[aria-label="Stop generating"]') === null).toBe(false),
    );
    await tick();

    expect(branchOffers(container)).toEqual([['Early reply', false]]);
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
      'a turn that is waiting for an approval',
      new StubFault('Conflict', 409, 'An approval is pending.', {
        reason: 'branch-with-pending-approval',
      }),
      CHAT_COPY.branch.refused['branch-with-pending-approval'],
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

describe('the identifier of a branch', () => {
  async function clickFirstBranch(mounted: ReturnType<typeof mount>): Promise<void> {
    await mounted.findByText('Second answer');
    const [first] = await mounted.findAllByRole('button', BRANCH);
    if (first === undefined) throw new Error('The first reply offers no branch.');
    await fireEvent.click(first);
  }

  test('is kept when the Bureau was shutting down, so a retry after a restart finds the branch it may have made', async () => {
    const served = serve(TURNS, {
      'bureau.contexts.fork': () => {
        throw new StubFault('Unavailable', 503, 'The Bureau is shutting down.', {
          reason: 'shutting-down',
        });
      },
    });
    const mounted = mount();
    await clickFirstBranch(mounted);
    await mounted.findByText(CHAT_COPY.branch.fault);
    await waitFor(() =>
      expect(mounted.queryAllByRole('button', BRANCH)[0]?.hasAttribute('disabled')).toBe(false),
    );

    const [again] = await mounted.findAllByRole('button', BRANCH);
    if (again === undefined) throw new Error('The first reply offers no branch.');
    await fireEvent.click(again);

    await waitFor(() =>
      expect(served.calls.filter((call) => call.method === 'bureau.contexts.fork').length).toBe(2),
    );
    const [first, second] = served.calls.filter((call) => call.method === 'bureau.contexts.fork');
    expect(second?.params['commandId']).toBe(first?.params['commandId']);
  });

  test('is new after the Bureau refused the branch, because a conflict is its final answer', async () => {
    const served = serve(TURNS, {
      'bureau.contexts.fork': () => {
        throw new StubFault('Conflict', 409, 'Not a branch point.', {
          reason: 'not-a-branch-point',
        });
      },
    });
    const mounted = mount();
    await clickFirstBranch(mounted);
    await mounted.findByText(CHAT_COPY.branch.refused['not-a-branch-point']);
    await waitFor(() =>
      expect(mounted.queryAllByRole('button', BRANCH)[0]?.hasAttribute('disabled')).toBe(false),
    );

    const [again] = await mounted.findAllByRole('button', BRANCH);
    if (again === undefined) throw new Error('The first reply offers no branch.');
    await fireEvent.click(again);

    await waitFor(() =>
      expect(served.calls.filter((call) => call.method === 'bureau.contexts.fork').length).toBe(2),
    );
    const [first, second] = served.calls.filter((call) => call.method === 'bureau.contexts.fork');
    expect(second?.params['commandId']).not.toBe(first?.params['commandId']);
  });
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
        effort: null,
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
        effort: null,
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
    const only = {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      displayName: 'claude-sonnet-5',
    };
    serve(TURNS, {
      'bureau.agents.models': () => ({ selectable: true, models: [only], default: only }),
    });
    const { container, client, findByText } = mount();
    await findByText('Second answer');
    // The list has reached the page and the page has drawn it, and it holds one model.
    await waitFor(() =>
      expect(client.getQueryData(queryKeys.agents.models('assistant')) === undefined).toBe(false),
    );
    await tick();

    expect(container.querySelector('select') === null).toBe(true);
  });
});
