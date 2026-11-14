/**
 * Archiving a chat from its page (COR-2285 V5), over a stubbed Bureau: the More menu's Archive turns
 * the composer into Chat's Archived bar with no question asked, an archived chat opens on that bar
 * and its menu offers Unarchive, Unarchive brings the composer back with the focus in its box, a
 * chat that is working is not archived and the toast says why, and a send that loses a race with an
 * archive in another window keeps its text and shows the bar, with none of the refusal's words.
 */
import { cleanup, fireEvent, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { CHAT_COPY } from '../../app/copy/chat.ts';
import { StubFault } from '../../lib/bureau-stub.test-support.ts';
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
/** Noon on Nov 3, read in any zone as Nov 3. */
const ARCHIVED_AT = '2026-11-03T12:00:00.000Z';

/** The neutral bar Chat draws in place of an archived chat's composer. */
function archivedBar(view: Mounted): HTMLElement | null {
  return view.container.querySelector<HTMLElement>('[data-chat-composer-status="archived"]');
}

async function untilArchived(view: Mounted): Promise<HTMLElement> {
  await waitFor(() => expect(archivedBar(view)).not.toBeNull());
  return archivedBar(view)!;
}

function composer(view: Mounted): HTMLElement | null {
  return view.queryByRole('textbox', { name: /message/i });
}

/** A Bureau whose chat is archived from `archivedAt` (or not, with `null`) until it is changed. */
function serveArchivable(archivedAt: string | null = null) {
  let current = archivedAt;
  const served = serve(TURNS, {
    'bureau.contexts.get': () => ({ ...CONTEXT, archivedAt: current }),
    'bureau.contexts.archive': () => {
      current ??= ARCHIVED_AT;
      return { id: 'session-1', changed: true, archivedAt: current };
    },
    'bureau.contexts.unarchive': () => {
      current = null;
      return { id: 'session-1', changed: true, archivedAt: null };
    },
  });
  return served;
}

describe('the More menu', () => {
  test('offers Archive after Export and above Delete, as Rename and Delete are offered', async () => {
    serveArchivable();
    const view = mount();

    await openMenu(view);

    expect(view.getAllByRole('menuitem').map((item) => item.textContent?.trim())).toEqual([
      MORE.rename,
      MORE.branch,
      MORE.export,
      MORE.archive,
      MORE.delete,
    ]);
  });

  test('archives with no question asked: the chat stays open, readable, with the Archived bar', async () => {
    const served = serveArchivable();
    const view = mount();

    await openMenu(view);
    await fireEvent.click(view.getByRole('menuitem', { name: MORE.archive }));

    const bar = await untilArchived(view);
    expect(callsTo(served, 'bureau.contexts.archive').map((call) => call.params)).toEqual([
      { contextId: 'session-1' },
    ]);
    expect(view.queryByRole('dialog')).toBeNull();
    expect(bar.textContent).toContain('Archived Nov 3');
    expect(composer(view)).toBeNull();
    // The conversation is still there to read.
    expect(view.getByText('Second answer')).not.toBeNull();
  });

  test('offers Unarchive in place of Archive on an archived chat', async () => {
    serveArchivable(ARCHIVED_AT);
    const view = mount();

    await openMenu(view);

    expect(view.getByRole('menuitem', { name: MORE.unarchive })).not.toBeNull();
    expect(view.queryByRole('menuitem', { name: MORE.archive })).toBeNull();
  });

  test('Unarchive in the menu brings the composer back', async () => {
    const served = serveArchivable(ARCHIVED_AT);
    const view = mount();
    await untilArchived(view);

    await openMenu(view);
    await fireEvent.click(view.getByRole('menuitem', { name: MORE.unarchive }));

    await waitFor(() => expect(composer(view)).not.toBeNull());
    expect(callsTo(served, 'bureau.contexts.unarchive').map((call) => call.params)).toEqual([
      { contextId: 'session-1' },
    ]);
    expect(archivedBar(view)).toBeNull();
  });

  test('says a chat that is working or waiting cannot be archived yet, and keeps its composer', async () => {
    serve(TURNS, {
      'bureau.contexts.archive': () => {
        throw new StubFault('Conflict', 409, 'Context "session-1" has a live task.', {
          reason: 'context-busy',
        });
      },
    });
    const view = mount();

    await openMenu(view);
    await fireEvent.click(view.getByRole('menuitem', { name: MORE.archive }));

    expect(await view.findByText(MORE.archiving.busy)).not.toBeNull();
    expect(view.queryByText(/live task/)).toBeNull();
    expect(archivedBar(view)).toBeNull();
    expect(composer(view)).not.toBeNull();
  });

  test('says a goal’s chat cannot be archived', async () => {
    serve(TURNS, {
      'bureau.contexts.archive': () => {
        throw new StubFault('Conflict', 409, 'A goal session.', {
          reason: 'context-not-archivable',
        });
      },
    });
    const view = mount();

    await openMenu(view);
    await fireEvent.click(view.getByRole('menuitem', { name: MORE.archive }));

    expect(await view.findByText(MORE.archiving.notArchivable)).not.toBeNull();
  });
});

describe('the Archived bar', () => {
  test('stands in for the composer with the date, a secondary New chat and a primary Unarchive', async () => {
    serveArchivable(ARCHIVED_AT);
    const view = mount();

    const bar = await untilArchived(view);

    expect(bar.textContent).toContain('Archived Nov 3');
    const newChat = within(bar).getByRole('link', { name: CHAT_COPY.composer.newChat });
    expect(newChat.getAttribute('href')).toBe('/chats/new');
    expect(newChat.getAttribute('data-cinder-variant')).toBe('secondary');
    const unarchive = within(bar).getByRole('button', { name: CHAT_COPY.composer.unarchive });
    expect(unarchive.getAttribute('data-cinder-variant')).toBe('primary');
    expect(composer(view)).toBeNull();
    expect(await view.findByText('Second answer')).not.toBeNull();
  });

  test('Unarchive brings the composer back with the focus in its box', async () => {
    const served = serveArchivable(ARCHIVED_AT);
    const view = mount();
    const bar = await untilArchived(view);

    await fireEvent.click(within(bar).getByRole('button', { name: CHAT_COPY.composer.unarchive }));

    await waitFor(() => expect(composer(view)).not.toBeNull());
    expect(callsTo(served, 'bureau.contexts.unarchive')).toHaveLength(1);
    expect(archivedBar(view)).toBeNull();
    await waitFor(() => expect(document.activeElement === composer(view)).toBe(true));
  });

  test('stays when Unarchive fails, and says so', async () => {
    serve(TURNS, {
      'bureau.contexts.get': () => ({ ...CONTEXT, archivedAt: ARCHIVED_AT }),
      'bureau.contexts.unarchive': () => {
        throw new StubFault('Internal', 500, 'Storage failed.');
      },
    });
    const view = mount();
    const bar = await untilArchived(view);

    await fireEvent.click(within(bar).getByRole('button', { name: CHAT_COPY.composer.unarchive }));

    expect(await view.findByText(MORE.archiving.unarchiveFault)).not.toBeNull();
    expect(archivedBar(view)).not.toBeNull();
  });

  test('outranks the missing provider: the bar, not Connect a model provider', async () => {
    serve(TURNS, {
      'bureau.contexts.get': () => ({ ...CONTEXT, archivedAt: ARCHIVED_AT }),
    });
    const view = mount();

    await untilArchived(view);

    expect(view.container.querySelector('[data-chat-availability="unconfigured"]')).toBeNull();
  });
});

describe('a send that loses a race with an archive in another window', () => {
  test('keeps the typed text, reads the chat again and shows the Archived bar, with no raw error', async () => {
    let archivedAt: string | null = null;
    const served = serve(
      TURNS,
      { 'bureau.contexts.get': () => ({ ...CONTEXT, archivedAt }) },
      () => {
        archivedAt = ARCHIVED_AT;
        return new Response(
          `data: ${JSON.stringify({
            type: 'RUN_ERROR',
            message: 'Thread "session-1" is archived',
            code: 'THREAD_ARCHIVED',
          })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    );
    const view = mount();
    await view.findByText('Second answer');

    const box = composer(view) as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: 'One more thing' } });
    await fireEvent.keyDown(box, { key: 'Enter' });

    await untilArchived(view);
    expect(served.runs).toHaveLength(1);
    // The message is still on screen, on its row.
    expect(view.getByText('One more thing')).not.toBeNull();
    expect(view.queryByText(/is archived/)).toBeNull();
    expect(view.queryByText(/THREAD_ARCHIVED/)).toBeNull();
    expect(view.queryByText(CHAT_COPY.failureTitle)).toBeNull();
  });
});
