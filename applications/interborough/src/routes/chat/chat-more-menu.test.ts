/**
 * The chat header's More menu and editing a sent message (COR-1968), over a stubbed Bureau: Rename
 * sends the title and keeps a typed one when the chat is renamed elsewhere, Delete asks first and
 * says what happens to a run, Branch branches from the last reply, Export saves Markdown, and an
 * edited message branches the chat before it and is sent on the branch.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { CHAT_COPY } from '../../app/copy.ts';
import { StubFault } from '../../lib/bureau-stub.test-support.ts';
import { createQueryClient } from '../../lib/query.ts';
import { router } from '../../lib/router.svelte.ts';
import ChatConversation from './chat-conversation.svelte';
import ChatToasts from './chat-toasts.test-harness.svelte';
import { holdEdit } from './edit-fork.ts';
import { AGENT, bureau, CONTEXT, landAt } from './pages.test-support.ts';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const MORE = CHAT_COPY.more;

const TURNS = [
  { id: 'u1', role: 'user', content: 'First question' },
  { id: 'a1', role: 'assistant', content: 'First answer' },
  { id: 'u2', role: 'user', content: 'Second question' },
  { id: 'a2', role: 'assistant', content: 'Second answer' },
];

type Answers = Record<string, (params: Record<string, unknown>) => unknown>;

/** A Bureau holding the session `session-1`, whose transcript is `messages`. */
function serve(messages: readonly unknown[] = TURNS, answers: Answers = {}) {
  const runs: Array<Record<string, unknown>> = [];
  const served = bureau(
    {
      'bureau.agents.list': () => ({ agents: [AGENT] }),
      'bureau.agents.models': () => ({ selectable: true, models: [], default: null }),
      'bureau.contexts.get': () => CONTEXT,
      'bureau.tasks.list': () => ({ tasks: [], nextOffset: null }),
      ...answers,
    },
    (url, init) => {
      if (url.endsWith('/messages')) return Response.json({ threadId: 'session-1', messages });
      if (url.includes('/ag-ui/agents/')) {
        runs.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
        return new Response(
          [
            { type: 'RUN_STARTED', threadId: 'session-1', runId: 'run-9' },
            {
              type: 'RUN_FINISHED',
              threadId: 'session-1',
              runId: 'run-9',
              outcome: { type: 'success' },
            },
          ]
            .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
            .join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
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
  landAt('/chats/session-1');
  return { ...served, runs };
}

function mount(sessionId = 'session-1') {
  const client = createQueryClient();
  const view = render(ChatToasts, {
    props: {
      page: ChatConversation,
      pageProps: { sessionId, title: 'Plan the week', agentName: 'assistant' },
      client,
    },
  } as never);
  return { ...view, client };
}

type Mounted = ReturnType<typeof mount>;

async function openMenu(view: Mounted): Promise<void> {
  await view.findByText('Second answer');
  await fireEvent.click(await view.findByRole('button', { name: MORE.label }));
}

const callsTo = (served: ReturnType<typeof serve>, method: string) =>
  served.calls.filter((call) => call.method === method);

describe('the More menu', () => {
  test('offers Rename, Branch, Export and Delete', async () => {
    serve();
    const view = mount();

    await openMenu(view);

    for (const name of [MORE.rename, MORE.branch, MORE.export, MORE.delete]) {
      expect(view.getByRole('menuitem', { name })).not.toBeNull();
    }
  });

  test('is not offered on a new chat, which has no session to act on', async () => {
    serve([]);
    const view = render(ChatToasts, {
      props: {
        page: ChatConversation,
        pageProps: { sessionId: 'thread-1', title: null, agentName: 'assistant', isNew: true },
      },
    } as never);

    await view.findByTestId('chat-header');

    expect(view.queryByRole('button', { name: MORE.label })).toBeNull();
  });
});

describe('Rename', () => {
  test('starts at the title the header shows and sends the new one', async () => {
    const served = serve(TURNS, {
      'bureau.contexts.rename': (params) => ({ contextId: 'session-1', title: params['title'] }),
    });
    const view = mount();
    await openMenu(view);

    await fireEvent.click(view.getByRole('menuitem', { name: MORE.rename }));
    const field = await view.findByRole('textbox', { name: MORE.renameDialog.label });
    expect((field as HTMLInputElement).value).toBe('Plan the week');
    await fireEvent.input(field, { target: { value: '  Plan the quarter  ' } });
    await fireEvent.click(view.getByRole('button', { name: MORE.renameDialog.save }));

    await waitFor(() => expect(callsTo(served, 'bureau.contexts.rename')).toHaveLength(1));
    expect(callsTo(served, 'bureau.contexts.rename')[0]?.params).toEqual({
      contextId: 'session-1',
      title: 'Plan the quarter',
    });
    expect(await view.findByText(MORE.renameDialog.renamed)).not.toBeNull();
    await waitFor(() =>
      expect(
        view.queryByRole('textbox', { name: MORE.renameDialog.label })?.outerHTML ?? null,
      ).toBeNull(),
    );
  });

  test('asks for the derived title back when the field is emptied', async () => {
    const served = serve(TURNS, {
      'bureau.contexts.rename': () => ({ contextId: 'session-1', title: null }),
    });
    const view = mount();
    await openMenu(view);

    await fireEvent.click(view.getByRole('menuitem', { name: MORE.rename }));
    const field = await view.findByRole('textbox', { name: MORE.renameDialog.label });
    await fireEvent.input(field, { target: { value: '   ' } });
    await fireEvent.click(view.getByRole('button', { name: MORE.renameDialog.save }));

    await waitFor(() => expect(callsTo(served, 'bureau.contexts.rename')).toHaveLength(1));
    expect(callsTo(served, 'bureau.contexts.rename')[0]?.params['title']).toBeNull();
  });

  test('sends nothing for the title the chat already has, and refuses one over 200 characters', async () => {
    const served = serve();
    const view = mount();
    await openMenu(view);

    await fireEvent.click(view.getByRole('menuitem', { name: MORE.rename }));
    const field = await view.findByRole('textbox', { name: MORE.renameDialog.label });
    await fireEvent.input(field, { target: { value: 'x'.repeat(201) } });
    await fireEvent.click(view.getByRole('button', { name: MORE.renameDialog.save }));
    expect(await view.findByText(MORE.renameDialog.tooLong)).not.toBeNull();

    await fireEvent.input(field, { target: { value: 'Plan the week' } });
    await fireEvent.click(view.getByRole('button', { name: MORE.renameDialog.save }));
    await waitFor(() =>
      expect(
        view.queryByRole('textbox', { name: MORE.renameDialog.label })?.outerHTML ?? null,
      ).toBeNull(),
    );
    expect(callsTo(served, 'bureau.contexts.rename')).toHaveLength(0);
  });

  test('keeps the dialog open and says so when the Bureau refuses', async () => {
    serve(TURNS, {
      'bureau.contexts.rename': () => {
        throw new StubFault('Unavailable', 503, 'The Bureau is not answering.');
      },
    });
    const view = mount();
    await openMenu(view);

    await fireEvent.click(view.getByRole('menuitem', { name: MORE.rename }));
    const field = await view.findByRole('textbox', { name: MORE.renameDialog.label });
    await fireEvent.input(field, { target: { value: 'Another' } });
    await fireEvent.click(view.getByRole('button', { name: MORE.renameDialog.save }));

    expect(await view.findByTestId('chat-rename-failure')).not.toBeNull();
    expect((field as HTMLInputElement).value).toBe('Another');
  });

  test('keeps typed text when the chat is renamed elsewhere, and offers the new title', async () => {
    let title = 'Plan the week';
    serve(TURNS, { 'bureau.contexts.get': () => ({ ...CONTEXT, title }) });
    const view = mount();
    await openMenu(view);
    await fireEvent.click(view.getByRole('menuitem', { name: MORE.rename }));
    const field = (await view.findByRole('textbox', {
      name: MORE.renameDialog.label,
    })) as HTMLInputElement;
    await fireEvent.input(field, { target: { value: 'My own title' } });

    title = 'Renamed in another window';
    await view.client.invalidateQueries({ queryKey: ['contexts'] });

    expect(await view.findByTestId('chat-rename-changed')).not.toBeNull();
    expect(field.value).toBe('My own title');
    await fireEvent.click(view.getByRole('button', { name: MORE.renameDialog.reload }));
    expect(field.value).toBe('Renamed in another window');
    expect(view.queryByTestId('chat-rename-changed')).toBeNull();
  });

  test('follows a rename elsewhere when nothing was typed', async () => {
    let title = 'Plan the week';
    serve(TURNS, { 'bureau.contexts.get': () => ({ ...CONTEXT, title }) });
    const view = mount();
    await openMenu(view);
    await fireEvent.click(view.getByRole('menuitem', { name: MORE.rename }));
    const field = (await view.findByRole('textbox', {
      name: MORE.renameDialog.label,
    })) as HTMLInputElement;

    title = 'Renamed in another window';
    await view.client.invalidateQueries({ queryKey: ['contexts'] });

    await waitFor(() => expect(field.value).toBe('Renamed in another window'));
    expect(view.queryByTestId('chat-rename-changed')).toBeNull();
  });
});

describe('Delete', () => {
  test('asks first, naming the chat, and deletes nothing until it is confirmed', async () => {
    const served = serve();
    const view = mount();
    await openMenu(view);

    await fireEvent.click(view.getByRole('menuitem', { name: MORE.delete }));
    const dialog = await view.findByRole('dialog');

    expect(within(dialog).getByText(MORE.deleteDialog.title('Plan the week'))).not.toBeNull();
    expect(dialog.textContent).toContain(MORE.deleteDialog.description(false));
    expect(dialog.textContent).not.toContain('Its run is going now');
    await fireEvent.click(within(dialog).getByRole('button', { name: MORE.deleteDialog.cancel }));
    expect(callsTo(served, 'bureau.contexts.delete')).toHaveLength(0);
    expect(router.pathname).toBe('/chats/session-1');
  });

  test('deletes the chat once confirmed and returns to the list', async () => {
    const served = serve(TURNS, {
      'bureau.contexts.delete': () => ({ contextId: 'session-1', receipt: 'applied' }),
    });
    const view = mount();
    await openMenu(view);

    await fireEvent.click(view.getByRole('menuitem', { name: MORE.delete }));
    const dialog = await view.findByRole('dialog');
    await fireEvent.click(within(dialog).getByRole('button', { name: MORE.deleteDialog.confirm }));

    await waitFor(() => expect(router.pathname).toBe('/chats'));
    expect(callsTo(served, 'bureau.contexts.delete')).toHaveLength(1);
    expect(callsTo(served, 'bureau.contexts.delete')[0]?.params).toEqual({
      contextId: 'session-1',
    });
  });

  test('says a run that is going is stopped by it, and that its stopping may take a moment', async () => {
    const served = serve(TURNS, {
      'bureau.contexts.get': () => ({ ...CONTEXT, activity: 'running' }),
      'bureau.contexts.delete': () => ({ contextId: 'session-1', receipt: 'cleanup-pending' }),
    });
    const view = mount();
    await openMenu(view);
    await waitFor(() => expect(callsTo(served, 'bureau.contexts.get').length).toBeGreaterThan(0));

    await fireEvent.click(view.getByRole('menuitem', { name: MORE.delete }));
    const dialog = await view.findByRole('dialog');
    await waitFor(() => expect(dialog.textContent).toContain('Its run is going now'));
    await fireEvent.click(within(dialog).getByRole('button', { name: MORE.deleteDialog.confirm }));

    expect(await view.findByText(MORE.deleteDialog.deletedRunning)).not.toBeNull();
    await waitFor(() => expect(router.pathname).toBe('/chats'));
  });

  test('leaves for the list when the chat was already deleted elsewhere', async () => {
    serve(TURNS, {
      'bureau.contexts.delete': () => {
        throw new StubFault('NotFound', 404, 'No such context.');
      },
    });
    const view = mount();
    await openMenu(view);

    await fireEvent.click(view.getByRole('menuitem', { name: MORE.delete }));
    const dialog = await view.findByRole('dialog');
    await fireEvent.click(within(dialog).getByRole('button', { name: MORE.deleteDialog.confirm }));

    expect(await view.findByText(MORE.deleteDialog.alreadyGone)).not.toBeNull();
    await waitFor(() => expect(router.pathname).toBe('/chats'));
  });

  test('stays on the chat and says so when the Bureau deleted nothing', async () => {
    serve(TURNS, {
      'bureau.contexts.delete': () => ({ contextId: 'session-1', receipt: 'rejected' }),
    });
    const view = mount();
    await openMenu(view);

    await fireEvent.click(view.getByRole('menuitem', { name: MORE.delete }));
    const dialog = await view.findByRole('dialog');
    await fireEvent.click(within(dialog).getByRole('button', { name: MORE.deleteDialog.confirm }));

    expect(await view.findByText(MORE.deleteDialog.refused)).not.toBeNull();
    expect(router.pathname).toBe('/chats/session-1');
  });

  test('stays on the chat and says so when the delete fails', async () => {
    serve(TURNS, {
      'bureau.contexts.delete': () => {
        throw new StubFault('Unavailable', 503, 'The Bureau is not answering.');
      },
    });
    const view = mount();
    await openMenu(view);

    await fireEvent.click(view.getByRole('menuitem', { name: MORE.delete }));
    const dialog = await view.findByRole('dialog');
    await fireEvent.click(within(dialog).getByRole('button', { name: MORE.deleteDialog.confirm }));

    expect(await view.findByText(MORE.deleteDialog.fault)).not.toBeNull();
    expect(router.pathname).toBe('/chats/session-1');
  });
});

describe('Branch', () => {
  test('branches from the last reply and opens the branch', async () => {
    const served = serve(TURNS, {
      'bureau.contexts.fork': () => ({ contextId: 'branch-1', carriedOverride: null }),
    });
    const view = mount();
    await openMenu(view);

    await fireEvent.click(view.getByRole('menuitem', { name: MORE.branch }));

    await waitFor(() => expect(router.pathname).toBe('/chats/branch-1'));
    expect(callsTo(served, 'bureau.contexts.fork')[0]?.params).toMatchObject({
      contextId: 'session-1',
      throughMessageId: 'a2',
    });
  });

  test('is disabled, with the reason, for a chat with no finished reply', async () => {
    serve([{ id: 'u1', role: 'user', content: 'Only a question' }]);
    const view = mount();
    await view.findByText('Only a question');
    await fireEvent.click(await view.findByRole('button', { name: MORE.label }));

    const item = view.getByRole('menuitem', { name: MORE.branch });

    expect(item.getAttribute('aria-disabled') === 'true' || item.hasAttribute('disabled')).toBe(
      true,
    );
    expect(item.getAttribute('title')).toBe(MORE.noBranchPoint);
  });
});

describe('Export', () => {
  test('saves the conversation as a Markdown file named for the chat', async () => {
    serve();
    const saved: Array<{ blob: Blob; name: string }> = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const originalClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (blob) => {
      saved.push({ blob: blob as Blob, name: '' });
      return 'blob:chat';
    };
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      saved[0]!.name = this.download;
    };
    try {
      const view = mount();
      await openMenu(view);

      await fireEvent.click(view.getByRole('menuitem', { name: MORE.export }));
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      HTMLAnchorElement.prototype.click = originalClick;
    }

    expect(saved).toHaveLength(1);
    expect(saved[0]?.name).toMatch(/^Plan the week-\d{4}-\d{2}-\d{2}\.md$/);
    expect(saved[0]?.blob.type).toBe('text/markdown');
    const text = await saved[0]!.blob.text();
    expect(text).toContain('# Plan the week');
    expect(text).toContain('## You\n\nFirst question');
    expect(text).toContain('## Assistant\n\nSecond answer');
  });
});

describe('editing a sent message', () => {
  async function editSecondQuestion(view: Mounted, text: string): Promise<void> {
    await view.findByText('Second answer');
    const row = view.getByText('Second question').closest('[data-message-role="user"]');
    if (row === null) throw new Error('The second question did not render.');
    const scope = row.parentElement ?? row;
    await fireEvent.click(within(scope as HTMLElement).getByRole('button', { name: /edit/i }));
    const box = await waitFor(() => {
      const found = scope.querySelector('textarea');
      if (found === null) throw new Error('The editor did not open.');
      return found;
    });
    await fireEvent.input(box, { target: { value: text } });
    await fireEvent.click(
      within(scope as HTMLElement).getByRole('button', { name: /save|send|submit/i }),
    );
  }

  test('branches before the message and opens the branch, leaving the original alone', async () => {
    const served = serve(TURNS, {
      'bureau.contexts.fork': () => ({ contextId: 'branch-1', carriedOverride: null }),
    });
    const view = mount();

    await editSecondQuestion(view, 'A better question');

    await waitFor(() => expect(router.pathname).toBe('/chats/branch-1'));
    expect(callsTo(served, 'bureau.contexts.fork')[0]?.params).toMatchObject({
      contextId: 'session-1',
      throughMessageId: 'a1',
    });
    expect(callsTo(served, 'bureau.contexts.delete')).toHaveLength(0);
    expect(callsTo(served, 'bureau.contexts.rename')).toHaveLength(0);
  });

  test('says why and stays when the Bureau refuses the branch', async () => {
    serve(TURNS, {
      'bureau.contexts.fork': () => {
        throw new StubFault('Conflict', 409, 'Not a branch point.', {
          reason: 'not-a-branch-point',
        });
      },
    });
    const view = mount();

    await editSecondQuestion(view, 'A better question');

    expect(await view.findByText(CHAT_COPY.branch.refused['not-a-branch-point'])).not.toBeNull();
    expect(router.pathname).toBe('/chats/session-1');
  });

  test('says the message cannot be edited when it follows no finished reply', async () => {
    serve([
      { id: 'u1', role: 'user', content: 'Start the work' },
      { id: 'run-1:step:0', role: 'assistant', content: 'Early reply' },
      { id: 'u2', role: 'user', content: 'Second question' },
      { id: 'run-1:step:1', role: 'assistant', content: 'Second answer' },
    ]);
    const view = mount();

    await editSecondQuestion(view, 'A better question');

    expect(await view.findByText(CHAT_COPY.edit.unavailable)).not.toBeNull();
    expect(router.pathname).toBe('/chats/session-1');
  });

  test('says a message with files cannot be edited, because the branch would leave them behind', async () => {
    const served = serve([
      { id: 'u1', role: 'user', content: 'First question' },
      { id: 'a1', role: 'assistant', content: 'First answer' },
      {
        id: 'u2',
        role: 'user',
        content: [
          { type: 'text', text: 'Second question' },
          {
            type: 'image',
            source: { type: 'file', provider: 'bureau', value: 'asset-1', mimeType: 'image/png' },
          },
        ],
      },
      { id: 'a2', role: 'assistant', content: 'Second answer' },
    ]);
    const view = mount();

    await editSecondQuestion(view, 'A better question');

    expect(await view.findByText(CHAT_COPY.edit.withFiles)).not.toBeNull();
    expect(router.pathname).toBe('/chats/session-1');
    expect(callsTo(served, 'bureau.contexts.fork')).toHaveLength(0);
  });

  test('a branch opened with an edited message sends it as the next turn, once', async () => {
    holdEdit('session-1', 'A better question');
    const served = serve([
      { id: 'u1', role: 'user', content: 'First question' },
      { id: 'a1', role: 'assistant', content: 'First answer' },
    ]);
    const view = mount();
    await view.findByText('First answer');

    await waitFor(() => expect(served.runs).toHaveLength(1));
    const messages = served.runs[0]?.['messages'] as Array<{ role: string; content: string }>;
    expect(messages.at(-1)).toMatchObject({ role: 'user', content: 'A better question' });
    expect(await view.findByText('A better question')).not.toBeNull();
  });
});
