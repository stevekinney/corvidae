/**
 * A chat deleted under an open page (COR-1968, round 1): the Bureau recreates a chat that is sent
 * to, so the composer closes and the page says the chat is gone; an edit that did not branch keeps
 * its text; and a not-found on a change is checked against a read before it is called a deletion.
 */
import { cleanup, fireEvent, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { CHAT_COPY } from '../../app/copy.ts';
import { StubFault } from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import {
  callsTo,
  mount,
  openMenu,
  restoreBureau,
  serve,
  TURNS,
  type Mounted,
} from './chat-more-menu.test-support.ts';
import { CONTEXT } from './pages.test-support.ts';

afterEach(() => {
  cleanup();
  restoreBureau();
});

const MORE = CHAT_COPY.more;

function composerOf(view: Mounted): HTMLTextAreaElement {
  return view.getByRole('textbox', { name: /message/i }) as HTMLTextAreaElement;
}

function gone(): never {
  throw new StubFault('NotFound', 404, 'No such context.');
}

describe('a chat deleted while its page is open', () => {
  test('closes the composer and offers the way back when the chats are read again', async () => {
    let deleted = false;
    const served = serve(TURNS, {
      'bureau.contexts.get': () => (deleted ? gone() : CONTEXT),
    });
    const view = mount();
    await view.findByText('Second answer');
    expect(view.queryByTestId('chat-gone')).toBeNull();

    // What `session.deleted` does: the chats are invalidated and read again.
    deleted = true;
    await view.client.invalidateQueries({ queryKey: ['contexts'] });

    const notice = await view.findByTestId('chat-gone');
    expect(within(notice).getByText(CHAT_COPY.gone.title)).not.toBeNull();
    expect(composerOf(view).readOnly).toBe(true);
    expect(served.runs).toHaveLength(0);
    await fireEvent.click(within(notice).getByRole('button', { name: CHAT_COPY.gone.back }));
    expect(router.pathname).toBe('/chats');
  });

  test('offers no Edit, and sends nothing', async () => {
    let deleted = false;
    const served = serve(TURNS, {
      'bureau.contexts.get': () => (deleted ? gone() : CONTEXT),
    });
    const view = mount();
    await view.findByText('Second answer');

    deleted = true;
    await view.client.invalidateQueries({ queryKey: ['contexts'] });
    await view.findByTestId('chat-gone');

    expect(view.queryByRole('button', { name: /edit/i })).toBeNull();
    expect(served.runs).toHaveLength(0);
    expect(callsTo(served, 'bureau.contexts.fork')).toHaveLength(0);
  });

  test('is found out when a send is answered not-found and the read agrees', async () => {
    let deleted = false;
    const served = serve(
      TURNS,
      { 'bureau.contexts.get': () => (deleted ? gone() : CONTEXT) },
      () => {
        deleted = true;
        return new Response('{}', { status: 404 });
      },
    );
    const view = mount();
    await view.findByText('Second answer');

    const box = composerOf(view);
    await fireEvent.input(box, { target: { value: 'Still there?' } });
    await fireEvent.keyDown(box, { key: 'Enter' });

    expect(await view.findByTestId('chat-gone')).not.toBeNull();
    expect(served.runs).toHaveLength(1);
  });

  test('is not called deleted when a send is answered not-found but the chat still reads', async () => {
    serve(TURNS, {}, () => new Response('{}', { status: 404 }));
    const view = mount();
    await view.findByText('Second answer');

    const box = composerOf(view);
    await fireEvent.input(box, { target: { value: 'Hello' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(box.value).toBe(''));

    expect(view.queryByTestId('chat-gone')).toBeNull();
  });
});

describe('a change refused as not-found', () => {
  async function confirmDelete(view: Mounted): Promise<void> {
    await openMenu(view);
    await fireEvent.click(view.getByRole('menuitem', { name: MORE.delete }));
    const dialog = await view.findByRole('dialog');
    await fireEvent.click(within(dialog).getByRole('button', { name: MORE.deleteDialog.confirm }));
  }

  test('says Delete was refused, and stays, when the chat still reads', async () => {
    serve(TURNS, { 'bureau.contexts.delete': gone });
    const view = mount();

    await confirmDelete(view);

    expect(await view.findByText(MORE.deleteDialog.notAllowed)).not.toBeNull();
    expect(view.queryByText(MORE.deleteDialog.alreadyGone)).toBeNull();
    expect(router.pathname).toBe('/chats/session-1');
  });

  test('says Rename was refused, not that the chat is gone, when the chat still reads', async () => {
    serve(TURNS, { 'bureau.contexts.rename': gone });
    const view = mount();
    await openMenu(view);

    await fireEvent.click(view.getByRole('menuitem', { name: MORE.rename }));
    const field = await view.findByRole('textbox', { name: MORE.renameDialog.label });
    await fireEvent.input(field, { target: { value: 'Another' } });
    await fireEvent.click(view.getByRole('button', { name: MORE.renameDialog.save }));

    const failure = await view.findByTestId('chat-rename-failure');
    expect(failure.textContent).toContain(MORE.renameDialog.refused);
    expect(failure.textContent).not.toContain(MORE.renameDialog.gone);
  });

  test('says the chat no longer exists on Rename when a read proves it', async () => {
    let deleted = false;
    serve(TURNS, {
      'bureau.contexts.get': () => (deleted ? gone() : CONTEXT),
      'bureau.contexts.rename': () => {
        deleted = true;
        return gone();
      },
    });
    const view = mount();
    await openMenu(view);

    await fireEvent.click(view.getByRole('menuitem', { name: MORE.rename }));
    const field = await view.findByRole('textbox', { name: MORE.renameDialog.label });
    await fireEvent.input(field, { target: { value: 'Another' } });
    await fireEvent.click(view.getByRole('button', { name: MORE.renameDialog.save }));

    const failure = await view.findByTestId('chat-rename-failure');
    expect(failure.textContent).toContain(MORE.renameDialog.gone);
  });
});

describe('an edit that did not branch', () => {
  async function edit(view: Mounted, text: string): Promise<void> {
    await view.findByText('Second answer');
    const row = view.getByText('Second question').closest('[data-message-role="user"]');
    if (row === null) throw new Error('The second question did not render.');
    const scope = (row.parentElement ?? row) as HTMLElement;
    await fireEvent.click(within(scope).getByRole('button', { name: /edit/i }));
    const box = await waitFor(() => {
      const found = scope.querySelector('textarea');
      if (found === null) throw new Error('The editor did not open.');
      return found;
    });
    await fireEvent.input(box, { target: { value: text } });
    await fireEvent.click(within(scope).getByRole('button', { name: /save|send|submit/i }));
  }

  test('keeps the text, copies it, and tries again', async () => {
    let refuse = true;
    const served = serve(TURNS, {
      'bureau.contexts.fork': () => {
        if (refuse) throw new StubFault('Unavailable', 503, 'The Bureau is not answering.');
        return { contextId: 'branch-1', carriedOverride: null };
      },
    });
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });
    const view = mount();

    await edit(view, 'A better question');

    const kept = await view.findByTestId('kept-edit');
    expect(kept.textContent?.trim()).toBe('A better question');
    await fireEvent.click(view.getByRole('button', { name: CHAT_COPY.edit.copy }));
    await waitFor(() => expect(written).toEqual(['A better question']));

    refuse = false;
    await fireEvent.click(view.getByRole('button', { name: CHAT_COPY.edit.tryAgain }));
    await waitFor(() => expect(router.pathname).toBe('/chats/branch-1'));
    expect(callsTo(served, 'bureau.contexts.fork')).toHaveLength(2);
  });

  test('keeps the text when the message cannot be edited at all', async () => {
    serve([
      { id: 'u1', role: 'user', content: 'Start the work' },
      { id: 'run-1:step:0', role: 'assistant', content: 'Early reply' },
      { id: 'u2', role: 'user', content: 'Second question' },
      { id: 'run-1:step:1', role: 'assistant', content: 'Second answer' },
    ]);
    const view = mount();

    await edit(view, 'A better question');

    expect(await view.findByText(CHAT_COPY.edit.unavailable)).not.toBeNull();
    const kept = await view.findByTestId('kept-edit');
    expect(kept.textContent?.trim()).toBe('A better question');
  });

  test('is not offered on a new chat, which has no message to edit from', async () => {
    serve([]);
    const { render } = await import('@testing-library/svelte');
    const { default: ChatConversation } = await import('./chat-conversation.svelte');
    const { default: ChatToasts } = await import('./chat-toasts.test-harness.svelte');
    const view = render(ChatToasts, {
      props: {
        page: ChatConversation,
        pageProps: { sessionId: 'thread-1', title: null, agentName: 'assistant', isNew: true },
      },
    } as never);

    await view.findByTestId('chat-header');

    expect(view.queryByRole('button', { name: /edit/i })).toBeNull();
  });
});
