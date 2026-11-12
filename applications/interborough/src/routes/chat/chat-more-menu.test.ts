/**
 * The chat header's More menu and editing a sent message (COR-1968), over a stubbed Bureau: Rename
 * sends the title and keeps a typed one when the chat is renamed elsewhere, Delete asks first and
 * says what happens to a run, Branch branches from the last reply, Export saves Markdown, and an
 * edited message branches the chat before it and is sent on the branch.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { CHAT_COPY } from '../../app/copy/chat.ts';
import { StubFault } from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import ChatConversation from './chat-conversation.svelte';
import {
  callsTo,
  mount,
  openMenu,
  restoreBureau,
  serve,
  TURNS,
} from './chat-more-menu.test-support.ts';
import ChatToasts from './chat-toasts.test-harness.svelte';
import { CONTEXT } from './pages.test-support.ts';

afterEach(() => {
  cleanup();
  restoreBureau();
});

const MORE = CHAT_COPY.more;

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

    // The page holds no header of its own, so it has nowhere to offer the menu: wait for the greeting.
    await view.findByTestId('new-chat-welcome');

    expect(view.queryByTestId('chat-header')).toBeNull();
    expect(view.queryByRole('button', { name: MORE.label })).toBeNull();
  });
});

describe('the stubbed Bureau', () => {
  test('starts and finishes a run sent without a response of its own', async () => {
    const served = serve();
    const view = mount();
    await view.findByText('Second answer');

    const box = view.getByRole('textbox', { name: /message/i }) as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: 'Third question' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(served.runs).toHaveLength(1));
    // The turn has ended once Stop gives way to Send again.
    await waitFor(() =>
      expect(view.queryByRole('button', { name: /^stop/i })?.outerHTML ?? null).toBeNull(),
    );

    expect(view.queryByText('Not sent')).toBeNull();
    expect(view.queryByText(/HTTP 500/)).toBeNull();
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
    let deleted = false;
    serve(TURNS, {
      'bureau.contexts.get': () => {
        if (deleted) throw new StubFault('NotFound', 404, 'No such context.');
        return CONTEXT;
      },
      'bureau.contexts.delete': () => {
        deleted = true;
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

  test('says it could not save when the browser refuses the file, and the chat stays as it was', async () => {
    serve();
    const originalCreate = URL.createObjectURL;
    URL.createObjectURL = () => {
      throw new Error('The browser refused the file.');
    };
    try {
      const view = mount();
      await openMenu(view);

      await fireEvent.click(view.getByRole('menuitem', { name: MORE.export }));

      expect(await view.findByText(MORE.exportFault)).not.toBeNull();
    } finally {
      URL.createObjectURL = originalCreate;
    }
  });
});
