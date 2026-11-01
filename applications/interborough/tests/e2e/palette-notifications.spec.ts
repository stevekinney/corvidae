/**
 * Search, notifications and the keyboard map as a person meets them (COR-1861): ⌘K reaches every
 * kind of record and action (waiting-on-you first, `>` for actions, `@` for agents), the bell keeps
 * what is read in the Bureau so a second browser agrees, a list it cannot read does not read as
 * empty, `?` lists the registry, and none of the three scrolls sideways at 375, 768 or 1280 pixels
 * with long values seeded.
 */
import type { APIRequestContext, Page } from '@playwright/test';

import {
  NOTIFICATION_COPY,
  PALETTE_COPY,
  SETTINGS_COPY,
  SHORTCUT_COPY,
} from '../../src/app/copy.ts';
import { createAgentFile, readCatalog, removeAgent } from './agent-support.ts';
import { deleteChats, newThreadId, runToEnd } from './chat-support.ts';
import { E2E_BASE_URL, E2E_FLEET_WORKER_ID } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';
import { bureauCall } from './task-support.ts';

const WIDTHS = [375, 768, 1280] as const;

/** A word no other case uses, so a search for it finds only what this specification seeded. */
const MARKER = `palette${crypto.randomUUID().slice(0, 8)}`;
/** A title with 190 characters and no place to break. */
const LONG_TITLE = `${MARKER}${'x'.repeat(190 - MARKER.length)}`;

const palette = (page: Page) => page.getByRole('dialog', { name: PALETTE_COPY.label });
const search = (page: Page) => palette(page).getByRole('combobox');
const groupsOf = (page: Page) =>
  palette(page)
    .getByRole('group')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label')));
const bell = (page: Page, name: string | RegExp) => page.getByRole('button', { name });
const fitsWidth = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** Opens the palette with its key, once the shell has registered it. */
async function openPalette(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: /^Search everything/ })).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
}

test.describe('⌘K over every kind of record', () => {
  test.describe.configure({ mode: 'serial' });

  const chatThread = newThreadId('palette-chat');
  const waitingThread = newThreadId('palette-waiting');
  let toolName = '';
  let runPrefix = '';

  test.beforeAll(async ({ request }) => {
    await runToEnd(request, 'demo:echo', chatThread, `${MARKER} say this back`);
    await runToEnd(request, 'demo:tool-runner', waitingThread, `Refund ${MARKER}`);
    const catalog = await readCatalog(request);
    toolName = catalog.tools[0]?.name ?? '';
    const listed = await request.get('/v1/workflows?type=order-processing&limit=1');
    const runs = (await listed.json()) as { items?: { id: string }[] };
    runPrefix = (runs.items?.[0]?.id ?? '').slice(0, 14);
  });

  test.afterAll(async () => {
    await deleteChats([chatThread, waitingThread]);
  });

  test('finds a chat, a workflow, a run, a worker, an agent, a tool and an action', async ({
    page,
    checkA11y,
  }) => {
    expect(toolName).not.toBe('');
    expect(runPrefix).not.toBe('');
    await page.goto('/');
    await openPalette(page);

    await search(page).fill(MARKER);
    await expect(
      palette(page)
        .getByRole('option', { name: new RegExp(MARKER) })
        .first(),
    ).toBeVisible();
    await expect.poll(() => groupsOf(page)).toContain(PALETTE_COPY.groups.chats);

    await search(page).fill('order-proc');
    await expect(palette(page).getByRole('option', { name: /^order-processing/ })).toBeVisible();
    await expect.poll(() => groupsOf(page)).toContain(PALETTE_COPY.groups.workflows);

    await search(page).fill(runPrefix);
    await expect.poll(() => groupsOf(page)).toContain(PALETTE_COPY.groups.runs);

    await search(page).fill(E2E_FLEET_WORKER_ID);
    await expect(
      palette(page).getByRole('option', { name: new RegExp(E2E_FLEET_WORKER_ID) }),
    ).toBeVisible();
    await expect.poll(() => groupsOf(page)).toContain(PALETTE_COPY.groups.workers);

    await search(page).fill('echo');
    await expect(palette(page).getByRole('option', { name: /^demo:echo, / })).toBeVisible();
    await expect.poll(() => groupsOf(page)).toContain(PALETTE_COPY.groups.agents);

    await search(page).fill(toolName);
    await expect(
      palette(page).getByRole('option', { name: new RegExp(`^${toolName}`) }),
    ).toBeVisible();
    await expect.poll(() => groupsOf(page)).toContain(PALETTE_COPY.groups.tools);

    await search(page).fill('go to reviews');
    await expect(palette(page).getByRole('option', { name: 'Go to Reviews' })).toBeVisible();
    await expect.poll(() => groupsOf(page)).toContain(PALETTE_COPY.groups.actions);
    await checkA11y('the palette with a result of every kind');
  });

  test('choosing a result opens that record', async ({ page }) => {
    await page.goto('/');
    await openPalette(page);

    await search(page).fill(toolName);
    await palette(page)
      .getByRole('option', { name: new RegExp(`^${toolName}`) })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/capabilities\\?tool=${encodeURIComponent(toolName)}`),
    );

    await openPalette(page);
    await search(page).fill('order-proc');
    await palette(page)
      .getByRole('option', { name: /^order-processing/ })
      .click();
    await expect(page).toHaveURL(/\/workflows\/order-processing$/);

    await openPalette(page);
    await search(page).fill('go to reviews');
    await palette(page).getByRole('option', { name: 'Go to Reviews' }).click();
    await expect(page).toHaveURL(/\/reviews$/);
  });

  test('lists what is waiting on the person first, before anything is typed', async ({ page }) => {
    await page.goto('/agents');
    await openPalette(page);

    const waiting = palette(page).getByRole('group', { name: PALETTE_COPY.groups.waiting });
    await expect(waiting).toBeVisible();
    const groups = await groupsOf(page);
    expect(groups[0]).toBe(PALETTE_COPY.groups.waiting);
    await expect.poll(() => groupsOf(page)).toContain(PALETTE_COPY.groups.actions);
    // The palette lists the eight longest-waiting, and other specifications leave their own
    // approvals waiting on this host, so what is first is not known here: it opens a chat.
    await waiting
      .getByRole('option', { name: /needs your approval/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/chats\/(?!new)[^/?]+$/);

    // Typing narrows the waiting group to what the query is about, so this case's own approval is
    // found by the marker in its chat's title and opens that chat.
    await openPalette(page);
    await search(page).fill(MARKER);
    await palette(page)
      .getByRole('group', { name: PALETTE_COPY.groups.waiting })
      .getByRole('option', { name: new RegExp(`needs your approval.*${MARKER}`) })
      .click();
    await expect(page).toHaveURL(new RegExp(`/chats/${waitingThread}$`));
  });

  test('> narrows to actions with their shortcuts, and @ to agents', async ({ page }) => {
    await page.goto('/');
    await openPalette(page);

    await search(page).fill('>keyboard');
    await expect.poll(() => groupsOf(page)).toEqual([PALETTE_COPY.groups.actions]);
    const action = palette(page).getByRole('option', { name: SHORTCUT_COPY.openMap });
    await expect(action).toHaveAttribute('aria-keyshortcuts', '?');

    await search(page).fill('>go to rev');
    await expect(palette(page).getByRole('option', { name: 'Go to Reviews' })).toHaveAttribute(
      'aria-keyshortcuts',
      'G V',
    );

    await search(page).fill('@');
    await expect(palette(page).getByRole('option', { name: /^demo:echo, / })).toBeVisible();
    await expect.poll(() => groupsOf(page)).toEqual([PALETTE_COPY.groups.agents]);

    await search(page).fill('@zzzzqqqq');
    await expect(palette(page).getByText(PALETTE_COPY.noMatchesTitle)).toBeVisible();
    await palette(page)
      .getByRole('button', { name: /^Clear filters/ })
      .click();
  });

  test('an action runs what its shortcut runs', async ({ page }) => {
    await page.goto('/');
    await openPalette(page);

    await search(page).fill('>keyboard');
    await palette(page).getByRole('option', { name: SHORTCUT_COPY.openMap }).click();

    await expect(page.getByRole('dialog', { name: SHORTCUT_COPY.mapTitle })).toBeVisible();
  });

  for (const width of WIDTHS) {
    test(`fits ${String(width)} pixels with a long title`, async ({ page, request, checkA11y }) => {
      const thread = newThreadId('palette-long');
      await runToEnd(request, 'demo:echo', thread, 'hello');
      await bureauCall(request, 'bureau.contexts.rename', { contextId: thread, title: LONG_TITLE });
      try {
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/');
        await openPalette(page);
        await search(page).fill(MARKER);
        await expect(
          palette(page)
            .getByRole('option', { name: new RegExp(MARKER) })
            .first(),
        ).toBeVisible();

        expect(await fitsWidth(page)).toBe(true);
        const box = await palette(page).boundingBox();
        expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= width).toBe(true);
        expect(
          await palette(page).evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth),
        ).toBe(true);
        await checkA11y(`the palette at ${String(width)}`);
      } finally {
        await deleteChats([thread]);
      }
    });
  }
});

test.describe('the ? map', () => {
  test('lists the shell’s keys, and the keys of the page that is open', async ({
    page,
    checkA11y,
  }) => {
    await page.goto('/settings');
    await expect(page.getByRole('button', { name: /^Search everything/ })).toBeVisible();
    // The page registers its key once its form is on screen, and the map lists what is registered.
    await expect(page.getByRole('group', { name: SETTINGS_COPY.formLabel })).toBeVisible();
    await page.keyboard.press('?');

    const map = page.getByRole('dialog', { name: SHORTCUT_COPY.mapTitle });
    await expect(map).toBeVisible();
    for (const label of [
      SHORTCUT_COPY.openSearch,
      SHORTCUT_COPY.openMap,
      SHORTCUT_COPY.newChat,
      'Go to Reviews',
      'Go to Workers',
      'Next row',
      'Previous row',
    ]) {
      await expect(map.getByText(label, { exact: true })).toBeVisible();
    }
    // The page's own key is listed while the page is open.
    await expect(
      map.locator('.cinder-keyboard-shortcuts__row').filter({ hasText: SETTINGS_COPY.saveAction }),
    ).not.toHaveCount(0);
    await checkA11y('the keyboard map');
  });

  test('is listed from the registry on every page, so ⌘K shows its key', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /^Search everything/ })).toBeVisible();
    await page.keyboard.press('?');

    const row = page
      .getByRole('dialog', { name: SHORTCUT_COPY.mapTitle })
      .locator('.cinder-keyboard-shortcuts__row')
      .filter({ hasText: SHORTCUT_COPY.openSearch });
    await expect(row).toHaveCount(1);
    await expect(row.locator('kbd')).toHaveText(['⌘', 'K']);
  });

  for (const width of WIDTHS) {
    test(`fits ${String(width)} pixels`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      await expect(page.getByRole('button', { name: /^Search everything/ })).toBeVisible();
      await page.keyboard.press('?');
      const map = page.getByRole('dialog', { name: SHORTCUT_COPY.mapTitle });
      await expect(map).toBeVisible();

      expect(await fitsWidth(page)).toBe(true);
      expect(await map.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
    });
  }
});

test.describe('the bell keeps what is read in the Bureau', () => {
  test.describe.configure({ mode: 'serial' });

  // The Bureau writes a notification for a failed run, and nothing in the suite's host fails one, so
  // the notifications are made the way a person makes them: hooks that notify the owner when an
  // agent is created. Each hook writes one, the second under a title with no place to break.
  const TITLE = `Palette probe ${MARKER}`;
  const agentId = `bell-probe-${crypto.randomUUID().slice(0, 8)}`;
  const hookIds: string[] = [];
  let notificationIds: string[] = [];

  const probeNotifications = async (request: APIRequestContext) => {
    const listed = (await bureauCall(request, 'bureau.notifications.list', {})) as {
      notifications: { id: string; title: string }[];
    };
    return listed.notifications.filter((notification) => notification.title.includes(MARKER));
  };

  test.beforeAll(async ({ request }) => {
    for (const [name, title] of [
      ['short', TITLE],
      ['long', `${TITLE} ${'y'.repeat(150)}`],
    ] as const) {
      const hook = (await bureauCall(request, 'bureau.hooks.create', {
        name: `${MARKER} ${name}`,
        events: ['definitions.changed'],
        action: { type: 'notify', title },
      })) as { id: string };
      hookIds.push(hook.id);
    }
    await createAgentFile(request, agentId, { name: `Probe ${agentId}` });
    await expect
      .poll(async () => {
        const found = await probeNotifications(request);
        notificationIds = found.map((notification) => notification.id);
        return found.length;
      })
      .toBe(2);
  });

  test.afterAll(async ({ request }) => {
    if (notificationIds.length > 0) {
      await bureauCall(request, 'bureau.notifications.dismiss', { ids: notificationIds });
    }
    for (const hookId of hookIds) await bureauCall(request, 'bureau.hooks.delete', { hookId });
    await removeAgent(request, agentId);
  });

  const rowOf = (page: Page) =>
    page.locator('.weft-notification-panel__item').filter({ hasText: TITLE }).first();

  test('a mark-as-read the Bureau refuses leaves the notification unread, and says so', async ({
    page,
    pageErrors,
  }) => {
    pageErrors.expect({
      pattern: loggedFailedResponse(500, /\/bureau\/jsonrpc/),
      reason: 'the test refuses the Bureau’s mark-as-read on purpose',
    });
    await page.route('**/bureau/jsonrpc', async (route) => {
      if ((route.request().postData() ?? '').includes('"bureau.notifications.markread"')) {
        await route.fulfill({ status: 500, body: 'unavailable' });
      } else {
        await route.fallback();
      }
    });
    await page.goto('/agents');
    await bell(page, /^Notifications/).click();
    await expect(rowOf(page)).toHaveAttribute('data-read', 'false');

    await page.getByRole('button', { name: NOTIFICATION_COPY.markAllRead }).click();

    await expect(page.getByText(NOTIFICATION_COPY.readFailed)).toBeVisible();
    await expect(rowOf(page)).toHaveAttribute('data-read', 'false');
    await expect(page.locator('.weft-notification-bell__count')).not.toHaveCount(0);
  });

  test('a notification is unread, and marking it read in one browser reads it in another', async ({
    browser,
    page,
    checkA11y,
  }) => {
    await page.goto('/agents');
    await expect(page.locator('.weft-notification-bell__count')).not.toHaveCount(0);
    await bell(page, /^Notifications/).click();
    await expect(rowOf(page)).toHaveAttribute('data-read', 'false');
    await checkA11y('the notification panel with a notification');

    await page.getByRole('button', { name: NOTIFICATION_COPY.markAllRead }).click();
    await expect(rowOf(page)).toHaveAttribute('data-read', 'true');
    const stored = (await bureauCall(page.request, 'bureau.notifications.list', {
      unread: true,
    })) as { notifications: { title: string }[] };
    expect(
      stored.notifications.filter((notification) => notification.title.includes(MARKER)),
    ).toEqual([]);

    // A second browser: its own storage, so only the Bureau can tell it.
    const other = await browser.newContext({ baseURL: E2E_BASE_URL });
    try {
      const second = await other.newPage();
      await second.goto('/agents');
      await bell(second, /^Notifications/).click();
      await expect(rowOf(second)).toHaveAttribute('data-read', 'true');
    } finally {
      await other.close();
    }
  });

  test('the panel ends with Notification settings and Hooks', async ({ page }) => {
    await page.goto('/agents');
    await bell(page, /^Notifications/).click();

    const links = page.getByRole('navigation', { name: NOTIFICATION_COPY.linksLabel });
    await expect(links.getByRole('link')).toHaveText([
      NOTIFICATION_COPY.settingsLink,
      NOTIFICATION_COPY.hooksLink,
    ]);
    await links.getByRole('link', { name: NOTIFICATION_COPY.hooksLink }).click();
    await expect(page).toHaveURL(/\/hooks$/);
  });

  test('a Bureau that cannot be read is not reported as having nothing', async ({
    page,
    pageErrors,
  }) => {
    pageErrors.expectEvery({
      pattern: loggedFailedResponse(500, /\/bureau\/jsonrpc/),
      reason: 'the test refuses the Bureau’s list of notifications on purpose',
    });
    await page.route('**/bureau/jsonrpc', async (route) => {
      if ((route.request().postData() ?? '').includes('"bureau.notifications.list"')) {
        await route.fulfill({ status: 500, body: 'unavailable' });
      } else {
        await route.fallback();
      }
    });
    await page.goto('/agents');
    await bell(page, /^Notifications/).click();

    await expect(page.getByText(NOTIFICATION_COPY.loadFailed.title)).toBeVisible();
    await expect(page.getByText(NOTIFICATION_COPY.empty.title)).toHaveCount(0);
  });

  for (const width of WIDTHS) {
    test(`the panel fits ${String(width)} pixels with a long title`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/agents');
      await bell(page, /^Notifications/).click();
      await expect(page.locator('.weft-notification-panel__item').first()).toBeVisible();

      expect(await fitsWidth(page)).toBe(true);
      const box = await page.locator('.weft-notification-panel').boundingBox();
      expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= width).toBe(true);
    });
  }
});
