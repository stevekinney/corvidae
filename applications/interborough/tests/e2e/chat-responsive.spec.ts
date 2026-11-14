/**
 * Chat on a phone and a tablet, and Chat with no model provider, on the sample world
 * (`fixtures/sample-world-seed.ts`, the showcase host) at the browser's sample clock, Monday, Nov 2,
 * 10:46 AM Central time (COR-2016, design rows 04y, 06l, 06m, 06n, 14h). The sample world holds no
 * provider key and Tool runner needs a model, so its refund chat and a new chat with it are the
 * no-provider frames as they stand. The live composer on a phone is the same page with a provider
 * answered into the host's provider list. Each frame is captured for the design review under its
 * own name.
 */
import type { Locator, Page } from '@playwright/test';

import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { SAMPLE_WORLD_THREADS } from '../../fixtures/sample-world-records.ts';
import { CHAT_COPY } from '../../src/app/copy/chat.ts';
import { NAVIGATION_COPY } from '../../src/app/copy/shell.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import { touchHeight } from './hit-area.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'chat-responsive.spec.ts';
const REFUND = 'Please refund order 4471, it arrived damaged.';
/** Chat's blocked row with no model provider, beside a chat with messages (COR-2285 V4). */
const REASON = 'Connect a model provider';
const CONNECT = 'Connect provider';

/** Opens `path` at `width` by 812 pixels on the sample clock. */
async function open(page: Page, width: number, path: string): Promise<void> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width, height: 812 });
  await page.goto(path);
}

/** Answers the host's provider list as it would with a key in place. */
async function connectProvider(page: Page): Promise<void> {
  await page.route('**/host/providers', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { providers: { hasKey: boolean }[] };
    await route.fulfill({
      response,
      json: {
        ...body,
        providers: body.providers.map((provider) => ({ ...provider, hasKey: true })),
      },
    });
  });
}

const trail = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' });
const chatList = (page: Page) => page.getByRole('region', { name: 'Chats' });
const openChat = (page: Page) => page.getByRole('region', { name: 'Open chat' });
const blockedRow = (page: Page) => page.locator('[data-chat-composer-status="blocked"]');

/** The box of `locator`, which must be on the page. */
async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box, 'the element is on the page').not.toBeNull();
  return box!;
}

/** Whether the page scrolls sideways. */
const scrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

/** Opens the refund chat from the list on a phone and waits until its approval is drawn. */
async function openRefundFromList(page: Page): Promise<void> {
  await open(page, 375, '/chats');
  await expect(page.locator('[data-chat]')).toHaveCount(5);
  await page.locator('[data-chat]').filter({ hasText: REFUND }).getByRole('link').first().click();
  await expect(page.locator('[data-approval-decision]')).toBeVisible();
}

/**
 * The waiting approval's title sits inside the transcript's visible box: the transcript, pinned to
 * its end, lifted the card until its question shows above Deny and Approve.
 */
async function expectApprovalTitleInView(page: Page): Promise<void> {
  const card = page.locator('.cinder-approval-card[data-cinder-state="pending"]').first();
  const title = card.getByRole('heading').first();
  await expect(title).toBeVisible();
  const transcript = page.locator('.chat-timeline').first();
  await expect
    .poll(async () => {
      const [titleBox, transcriptBox] = await Promise.all([
        title.boundingBox(),
        transcript.boundingBox(),
      ]);
      if (titleBox === null || transcriptBox === null) return false;
      return (
        titleBox.y >= transcriptBox.y - 1 &&
        titleBox.y + titleBox.height <= transcriptBox.y + transcriptBox.height + 1
      );
    })
    .toBe(true);
}

test.describe('Chat on a phone (04y, 06l, 06m)', () => {
  // A button's 44px hit area exists only under a coarse pointer, so the phone is a touch phone.
  test.use({ hasTouch: true, isMobile: true });

  test('lists the chats as a screen of its own: the status, a dot, then the latest message on line two (06l)', async ({
    page,
  }) => {
    await open(page, 375, '/chats');
    await expect(page.locator('[data-chat]')).toHaveCount(5);
    // The list is the screen: no conversation beside it, no sideways scroll.
    await expect(openChat(page)).toHaveCount(0);
    expect(await scrollsSideways(page)).toBe(false);

    const waiting = page.locator('[data-chat]').filter({ hasText: REFUND });
    await expect(waiting.locator('.cinder-stacked-list-item__title')).toHaveAttribute(
      'data-cinder-title-lines',
      '2',
    );
    // The title wraps to a second line rather than ending in an ellipsis after one.
    const titleBox = await boxOf(waiting.locator('.cinder-stacked-list-item__title'));
    expect(titleBox.height).toBeGreaterThan(24);

    const done = page.locator('[data-chat]').filter({ hasText: 'Say hello' });
    await expect(done.locator('.cinder-stacked-list-item__status')).toHaveText('Done');
    await expect(
      done
        .locator('.cinder-stacked-list-item__description, .cinder-stacked-list-item__meta')
        .first(),
    ).toContainText('Hello! How can I help?');
    // No fixed column: the word is followed by a comma and the message, close by.
    const dot = await done
      .locator('.cinder-stacked-list-item__status')
      .evaluate((element) => getComputedStyle(element, '::after').content);
    expect(dot).toMatch(/^","/);
    const statusBox = await boxOf(done.locator('.cinder-stacked-list-item__status'));
    const previewBox = await boxOf(
      done
        .locator('.cinder-stacked-list-item__description, .cinder-stacked-list-item__meta')
        .first(),
    );
    expect(previewBox.x - (statusBox.x + statusBox.width)).toBeLessThan(16);
    await captureForDesignReview(page, {
      route: '/chats',
      state: 'phone list',
      source: SOURCE,
    });
  });

  test('opens a chat as a separate screen with one back button, "Chat", and returns to the list with it (04y, 06m)', async ({
    page,
  }) => {
    await openRefundFromList(page);
    await expect(page).toHaveURL(new RegExp(`/chats/${SAMPLE_WORLD_THREADS.refund}$`));
    // The conversation is the screen: the list is gone, and so is the pane's own Back.
    await expect(chatList(page)).toHaveCount(0);
    await expect(openChat(page).getByRole('button', { name: 'Back' })).toHaveCount(0);
    expect(await scrollsSideways(page)).toBe(false);
    const back = trail(page).getByRole('link', { name: 'Chat' });
    await expect(back).toBeVisible();
    // The back link takes the menu button's place, so the chat's title in the bar keeps room to
    // say more than its first letters (06m).
    await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveCount(0);
    const title = trail(page).getByRole('button', { name: /Please refund order 4471/ });
    const titleBox = await boxOf(title);
    expect(titleBox.width).toBeGreaterThanOrEqual(110);

    await back.click();
    await expect(page).toHaveURL(/\/chats$/);
    await expect(chatList(page)).toBeVisible();
    await expect(page.locator('[data-chat]')).toHaveCount(5);
  });

  test('opens on the approval with its question in view, not only its buttons', async ({
    page,
  }) => {
    await openRefundFromList(page);
    await expectApprovalTitleInView(page);

    // With a provider the composer is live and its approval drawer takes more of the screen.
    const connected = await page.context().newPage();
    await connectProvider(connected);
    await open(connected, 375, `/chats/${SAMPLE_WORLD_THREADS.refund}`);
    await expect(connected.getByRole('textbox', { name: 'Message' })).toBeVisible();
    await expectApprovalTitleInView(connected);
    await connected.close();
  });

  test('at 320 by 640 the waiting approval’s Deny and Approve are in view and not covered, with the reminder and the blocked row one row each (COR-2327 B1)', async ({
    page,
  }) => {
    await page.clock.setFixedTime(SAMPLE_NOW);
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`/chats/${SAMPLE_WORLD_THREADS.refund}`);
    const row = page.locator('[data-approval-decision]');
    await expect(row).toBeFocused();
    // One layout, read once: each decision button's box, what a tap at its centre lands on, the
    // transcript's box, and the reminder and blocked row, when drawn.
    const read = await page.evaluate(() => {
      const rectOf = (node: Element | null) => {
        if (node === null) return null;
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      };
      const decision = document.querySelector('[data-approval-decision]');
      const buttons = [...(decision?.querySelectorAll('button') ?? [])].filter((button) =>
        ['Deny', 'Approve'].includes(button.textContent?.trim() ?? ''),
      );
      return {
        transcript: rectOf(document.querySelector('.chat-timeline')),
        drawer: rectOf(document.querySelector('[data-chat-approval-drawer]')),
        blocked: rectOf(document.querySelector('[data-chat-composer-status="blocked"]')),
        buttons: buttons.map((button) => {
          const box = button.getBoundingClientRect();
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return { box: rectOf(button), hitsItself: hit !== null && button.contains(hit) };
        }),
      };
    });
    expect(read.buttons).toHaveLength(2);
    const transcript = read.transcript!;
    for (const button of read.buttons) {
      const box = button.box!;
      expect(box.y).toBeGreaterThanOrEqual(transcript.y - 1);
      expect(box.y + box.height).toBeLessThanOrEqual(transcript.y + transcript.height + 1);
      expect(button.hitsItself).toBe(true);
    }
    // The reminder is for an approval out of view, so with Deny and Approve in view it is not drawn.
    expect(read.drawer).toBeNull();
    // The blocked row is one row with its action beside the reason.
    expect(read.blocked).not.toBeNull();
    expect(read.blocked!.height).toBeLessThanOrEqual(64);

    // Scrolled back up, the approval leaves the view and the reminder comes: one row, its glyph,
    // its words and a small Review at the row's end, never a button stacked under the words.
    const transcriptLocator = page.locator('.chat-timeline').first();
    await transcriptLocator.hover();
    await page.mouse.wheel(0, -4000);
    const drawer = page.locator('[data-chat-approval-drawer]');
    await expect(drawer).toBeVisible();
    const review = drawer.getByRole('button', { name: 'Review approval' });
    await expect(review).toHaveText('Review', { useInnerText: true });
    const reminder = await drawer.evaluate((element) => {
      const rectOf = (node: Element | null) => {
        const { x, y, width, height } = node!.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        drawer: rectOf(element),
        text: rectOf(element.querySelector('.chat-approval-drawer-text')),
        button: rectOf(element.querySelector('button')),
      };
    });
    expect(reminder.drawer.height).toBeLessThanOrEqual(60);
    expect(reminder.button.x).toBeGreaterThanOrEqual(reminder.text.x + reminder.text.width - 1);
    expect(reminder.button.y).toBeLessThan(reminder.text.y + reminder.text.height);
    expect(
      reminder.drawer.x + reminder.drawer.width - (reminder.button.x + reminder.button.width),
    ).toBeLessThan(20);
  });

  test('draws Deny and the primary as compact buttons on one row, the primary last, each with a 44px hit area and neither clipped by the card (06m)', async ({
    page,
  }) => {
    await openRefundFromList(page);
    const row = page.locator('[data-approval-decision]');
    const denyButton = row.getByRole('button', { name: 'Deny' });
    const approveButton = row.getByRole('button', { name: 'Approve' });
    // The page has brought the person to the approval: it scrolled the row to the middle and
    // focused it, and until then it scrolls it again each frame the row is drawn anew.
    await expect(row).toBeFocused();
    // The three boxes come from one layout. Read one at a time, they can straddle a scroll: the
    // CI failure measured Deny and Approve 22px apart, which is no wrap (a wrapped Approve sits a
    // 28px button and the 12px row gap lower) but the transcript moving between two reads.
    const { rowBox, deny, approve } = await row.evaluate((element) => {
      const rectOf = (node: Element) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      };
      const buttonNamed = (name: string) => {
        const button = [...element.querySelectorAll('button')].find(
          (candidate) => candidate.textContent?.trim() === name,
        );
        if (button === undefined) throw new Error(`No ${name} button in the approval.`);
        return button;
      };
      return {
        rowBox: rectOf(element),
        deny: rectOf(buttonNamed('Deny')),
        approve: rectOf(buttonNamed('Approve')),
      };
    });
    // One row, in reading order, the primary decision last.
    expect(Math.abs(deny.y - approve.y)).toBeLessThan(1);
    expect(approve.x).toBeGreaterThanOrEqual(deny.x + deny.width - 1);
    // Compact to the eye, never a full-width phone slab.
    expect(deny.height).toBeLessThanOrEqual(32);
    expect(approve.height).toBeLessThanOrEqual(32);
    // Generous to a finger.
    expect(await touchHeight(denyButton)).toBeGreaterThanOrEqual(44);
    expect(await touchHeight(approveButton)).toBeGreaterThanOrEqual(44);
    // Inside the card, with nothing cut off at its edges.
    for (const box of [deny, approve]) {
      expect(box.x).toBeGreaterThanOrEqual(rowBox.x - 0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 0.5);
    }
  });

  test('with no provider the composer is the blocked row: the reason wraps, and "Connect provider" stays beside it at the row’s end, a small button with a 44px hit area (06m, 04y, COR-2327 B1)', async ({
    page,
  }) => {
    await openRefundFromList(page);
    const row = blockedRow(page);
    await expect(row).toBeVisible();
    await expect(row.getByText(REASON)).toBeVisible();
    // The blocked row replaces the text box: nothing to type into, and Send never appears.
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send message' })).toHaveCount(0);

    const action = row.getByRole('button', { name: CONNECT });
    expect(await touchHeight(action)).toBeGreaterThanOrEqual(44);
    // Read in one pass: the reason, the action and the row.
    const { reason, actionBox, rowBox } = await row.evaluate((element, connect) => {
      const box = (node: Element | null) => {
        const rect = node!.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };
      const buttons = [...element.querySelectorAll('button, a')];
      return {
        reason: box(element.querySelector('.chat-input-blocked-reason')),
        actionBox: box(buttons.find((node) => node.textContent?.trim() === connect) ?? null),
        rowBox: box(element),
      };
    }, CONNECT);
    // Beside the reason, at the row's end, at its own width: never a full-width bar under it.
    expect(actionBox.x).toBeGreaterThanOrEqual(reason.x + reason.width - 1);
    expect(actionBox.y).toBeLessThan(reason.y + reason.height);
    expect(actionBox.width).toBeLessThan(rowBox.width * 0.6);
    expect(rowBox.x + rowBox.width - (actionBox.x + actionBox.width)).toBeLessThan(20);
    // One row: well under the 75px the stacked bar took.
    expect(rowBox.height).toBeLessThanOrEqual(64);
    // Nothing is queued and nothing pretends to be pending.
    await expect(page.getByText(/queued|sending|pending/i)).toHaveCount(0);
    expect(await scrollsSideways(page)).toBe(false);
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'no provider',
      source: SOURCE,
    });
  });

  test('docks the composer at the bottom of the screen, blocked or live (04y)', async ({
    page,
  }) => {
    await openRefundFromList(page);
    // Under 700 pixels the shell's tab bar holds the bottom edge (COR-2315), so the composer docks on
    // top of it: the page's own margin and the pane's border lie between them, and nothing else.
    const tabBar = await boxOf(page.getByRole('navigation', { name: NAVIGATION_COPY.tabBar }));
    const blocked = await boxOf(blockedRow(page));
    expect(tabBar.y - (blocked.y + blocked.height)).toBeGreaterThanOrEqual(0);
    expect(tabBar.y - (blocked.y + blocked.height)).toBeLessThan(40);

    const connected = await page.context().newPage();
    await connectProvider(connected);
    await open(connected, 375, `/chats/${SAMPLE_WORLD_THREADS.refund}`);
    const composer = connected.getByRole('textbox', { name: 'Message' });
    await expect(composer).toBeVisible();
    const send = await boxOf(connected.getByRole('button', { name: 'Send message' }));
    // The hint line sits under the composer; the composer's own bottom is within it of the tab bar.
    const liveTabBar = await boxOf(
      connected.getByRole('navigation', { name: NAVIGATION_COPY.tabBar }),
    );
    expect(liveTabBar.y - (send.y + send.height)).toBeGreaterThanOrEqual(0);
    expect(liveTabBar.y - (send.y + send.height)).toBeLessThan(120);
    await captureForDesignReview(connected, {
      route: '/chats/:chat',
      state: 'phone conversation, provider connected',
      source: SOURCE,
    });
    await connected.close();
  });
});

test.describe('The composer at desktop width', () => {
  test('never cuts a setting to a stub: the values show in full, or fold into Settings', async ({
    page,
  }) => {
    await connectProvider(page);
    await open(page, 1280, `/chats/${SAMPLE_WORLD_THREADS.refund}`);
    const composer = page.locator('.chat-input').first();
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
    const settings = page.getByRole('button', { name: 'Settings: Model, Effort and Permissions' });
    await expect(
      page
        .getByRole('combobox', { name: /Permissions/ })
        .or(settings)
        .first(),
    ).toBeVisible();
    // Whatever stays in the row is drawn whole: nothing in it is clipped to an ellipsis.
    const clipped = await composer.locator('.chat-input-footer-left').evaluate((footer) =>
      [footer, ...footer.querySelectorAll<HTMLElement>('*')]
        // A visually hidden element is clipped to a pixel on purpose and draws nothing.
        .filter((element) => element.clientWidth > 1)
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => element.textContent?.trim()),
    );
    expect(clipped).toEqual([]);
    if ((await composer.getAttribute('data-controls-folded')) !== null) {
      await expect(settings).toBeVisible();
      await expect(page.getByRole('combobox', { name: /Permissions/ })).toHaveCount(0);
    }
  });
});

test.describe('Keyboard hints on a phone', () => {
  test('a phone with a mouse names the number keys under a question and the Enter keys under the composer', async ({
    page,
  }) => {
    await connectProvider(page);
    await open(page, 375, `/chats/${SAMPLE_WORLD_THREADS.release}`);
    await expect(page.getByRole('radio', { name: /^Staging\b/ })).toBeVisible();
    await expect(page.getByText(CHAT_COPY.pickHint)).toBeVisible();
  });

  test.describe('on a touch-only device', () => {
    test.use({ hasTouch: true, isMobile: true });

    test('names no keys: no number-key hint under a question, no Enter hint under the composer', async ({
      page,
    }) => {
      await connectProvider(page);
      await open(page, 375, `/chats/${SAMPLE_WORLD_THREADS.release}`);
      await expect(page.getByRole('radio', { name: /^Staging\b/ })).toBeVisible();
      await expect(page.getByText(CHAT_COPY.pickHint)).toHaveCount(1);
      await expect(page.getByText(CHAT_COPY.pickHint)).toBeHidden();

      await open(page, 375, `/chats/${SAMPLE_WORLD_THREADS.refund}`);
      await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
      await expect(page.locator('.chat-input-hint')).toHaveCount(1);
      await expect(page.locator('.chat-input-hint')).toBeHidden();
    });
  });
});

test.describe('Chat on a tablet (06n)', () => {
  test('opens on the approval with its question in view, provider connected', async ({ page }) => {
    await connectProvider(page);
    await open(page, 768, `/chats/${SAMPLE_WORLD_THREADS.refund}`);
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
    await expectApprovalTitleInView(page);
  });

  test('shows the list and the conversation side by side, with the one blocked composer row and no agent select', async ({
    page,
  }) => {
    await open(page, 768, `/chats/${SAMPLE_WORLD_THREADS.refund}`);
    await expect(page.locator('[data-approval-decision]')).toBeVisible();
    await expect(chatList(page)).toBeVisible();
    await expect(openChat(page)).toBeVisible();
    expect(await scrollsSideways(page)).toBe(false);
    // List left of the conversation, as separate panes.
    const list = await boxOf(chatList(page));
    const conversation = await boxOf(openChat(page));
    expect(list.x + list.width).toBeLessThanOrEqual(conversation.x + 1);

    await expect(trail(page).getByRole('link', { name: 'Chat' })).toBeVisible();
    await expect(trail(page).getByRole('button', { name: REFUND })).toBeVisible();

    const row = blockedRow(page);
    await expect(row.getByText(REASON)).toBeVisible();
    await expect(row.getByRole('button', { name: CONNECT })).toBeVisible();
    // The one row: no text box, no Send, no agent or model select.
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send message' })).toHaveCount(0);
    await expect(row.getByRole('combobox')).toHaveCount(0);
    await expect(openChat(page).getByRole('combobox')).toHaveCount(0);
    // The pane is as narrow as a phone's screen: the reason wraps and the action stays at its
    // right, never under it (06n), as it does on a phone (COR-2327 B1).
    const reason = await boxOf(row.getByText(REASON));
    const action = await boxOf(row.getByRole('button', { name: CONNECT }));
    expect(action.x).toBeGreaterThanOrEqual(reason.x + reason.width - 1);
    expect(action.y).toBeLessThan(reason.y + reason.height);
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'no provider',
      source: SOURCE,
    });
  });
});

test.describe('Chat with no provider (14h)', () => {
  // The phone case measures a 44px hit area, which exists only under a coarse pointer.
  test.use({ hasTouch: true, isMobile: true });

  test('on New chat from a model agent, the reason sits where it blocks sending, nothing is queued, and no banner is drawn', async ({
    page,
  }) => {
    const sent: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && /ag-ui|\/run/.test(request.url())) {
        sent.push(request.url());
      }
    });
    await open(page, 1280, '/chats/new?agent=tool-runner');
    // An empty chat is Chat's Connect a model provider state, in place of the greeting and the
    // composer (COR-2285 V4).
    const state = page.locator('[data-chat-availability="unconfigured"]');
    await expect(state).toBeVisible();
    await expect(state.getByRole('heading', { level: 2 })).toHaveText(REASON);
    await expect(state.getByRole('button', { name: CONNECT })).toHaveAttribute(
      'data-cinder-variant',
      'primary',
    );
    // No text box to type into, so nothing can be sent and nothing waits to be.
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Send message' })).toBeHidden();
    await expect(page.getByText(/queued|sending|pending/i)).toHaveCount(0);
    // The reason is not an app-wide banner or an alert.
    await expect(page.locator('.cinder-banner')).toHaveCount(0);
    await expect(page.getByRole('alert').filter({ hasText: /provider/i })).toHaveCount(0);
    await expect(page.locator('header').getByText(/provider/i)).toHaveCount(0);
    expect(sent).toEqual([]);
    expect(await scrollsSideways(page)).toBe(false);
    await captureForDesignReview(page, {
      route: '/chats/new',
      state: 'no provider',
      source: SOURCE,
    });
  });

  test('on a phone the Connect a model provider state fits the screen, with a 44px Connect provider', async ({
    page,
  }) => {
    await open(page, 375, '/chats/new?agent=tool-runner');
    const state = page.locator('[data-chat-availability="unconfigured"]');
    await expect(state).toBeVisible();
    const title = await boxOf(state.getByRole('heading', { level: 2 }));
    const connect = state.getByRole('button', { name: CONNECT });
    const action = await boxOf(connect);
    expect(action.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
    expect(await touchHeight(connect)).toBeGreaterThanOrEqual(44);
    expect(await scrollsSideways(page)).toBe(false);
    await captureForDesignReview(page, {
      route: '/chats/new',
      state: 'no provider',
      source: SOURCE,
    });
  });
});
