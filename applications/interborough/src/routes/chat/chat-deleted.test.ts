/**
 * A chat deleted under an open page (COR-1968, round 1): the Bureau recreates a chat that is sent
 * to, so the composer closes and the page says the chat is gone; an edit that did not branch keeps
 * its text; and a not-found on a change is checked against a read before it is called a deletion.
 */
import { cleanup, fireEvent, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { breadcrumbTrail } from '../../app/breadcrumbs.svelte.ts';
import { CHAT_COPY } from '../../app/copy/chat.ts';
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

/** Chat's deleted availability state, when it is drawn. */
function deletedState(view: Mounted): HTMLElement | null {
  return view.container.querySelector<HTMLElement>('[data-chat-availability="deleted"]');
}

async function untilDeleted(view: Mounted): Promise<void> {
  await waitFor(() => expect(deletedState(view)).not.toBeNull());
}

function gone(): never {
  throw new StubFault('NotFound', 404, 'No such context.');
}

describe('a chat deleted while its page is open', () => {
  test('is Chat’s deleted state, with no composer and All conversations, when the chats are read again', async () => {
    let deleted = false;
    const served = serve(TURNS, {
      'bureau.contexts.get': () => (deleted ? gone() : CONTEXT),
    });
    const view = mount();
    await view.findByText('Second answer');
    expect(deletedState(view)).toBeNull();

    // What `session.deleted` does: the chats are invalidated and read again.
    deleted = true;
    await view.client.invalidateQueries({ queryKey: ['contexts'] });

    // COR-2285 V3: the deleted state stands in the transcript's place, and the composer is gone.
    await untilDeleted(view);
    const notice = deletedState(view)!;
    expect(within(notice).getByText(CHAT_COPY.gone.title)).not.toBeNull();
    expect(within(notice).getByText(CHAT_COPY.gone.description)).not.toBeNull();
    expect(view.queryByRole('textbox', { name: /message/i })).toBeNull();
    expect(served.runs).toHaveLength(0);
    const back = within(notice).getByRole('button', { name: CHAT_COPY.load.allConversations });
    expect(back.getAttribute('data-cinder-variant')).toBe('primary');
    await fireEvent.click(back);
    expect(router.pathname).toBe('/chats');
  });

  test('keeps a header that agrees: no status, no context ring, no More, and a crumb that names the chat, never its identifier (COR-2327 B5)', async () => {
    let deleted = false;
    serve(TURNS, {
      'bureau.contexts.get': () => (deleted ? gone() : CONTEXT),
    });
    const view = mount();
    await view.findByText('Second answer');
    const header = view.getByTestId('chat-header');
    await waitFor(() => expect(header.textContent).toContain(CHAT_COPY.status.done));
    expect(within(header).queryByRole('button', { name: MORE.label })).not.toBeNull();

    deleted = true;
    await view.client.invalidateQueries({ queryKey: ['contexts'] });
    await untilDeleted(view);

    const after = view.getByTestId('chat-header');
    for (const word of Object.values(CHAT_COPY.status)) {
      expect(after.textContent).not.toContain(word);
    }
    expect(within(after).queryByRole('button', { name: MORE.label })).toBeNull();
    expect(after.querySelector('.cinder-page-header__actions')).toBeNull();
    const crumb = breadcrumbTrail('/chats/session-1').at(-1);
    expect(crumb?.label).toBe(CONTEXT.title);
    expect(crumb?.label).not.toBe('session-1');
    expect(crumb).not.toHaveProperty('popover');
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
    await untilDeleted(view);

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

    await untilDeleted(view);
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

    expect(deletedState(view)).toBeNull();
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
