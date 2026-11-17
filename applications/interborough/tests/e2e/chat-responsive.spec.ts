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
        providers: body.providers.map((provider) => ({
          ...provider,
          hasKey: true,
          connected: true,
        })),
      },
    });
  });
}

const trail = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' });
const chatList = (page: Page) => page.getByRole('region', { name: 'Chats' });
const openChat = (page: Page) => page.getByRole('region', { name: 'Open chat' });
const blockedRow = (page: Page) => page.locator('[data-chat-composer-status="blocked"]');

/**
 * The waiting approval's placement, read in one layout pass: the transcript's box, the card's box,
 * Deny's and Approve's boxes with whether a tap at each centre reaches the button (a composer, the
 * reminder or the tab bar over it is a miss), and whether the reminder is drawn.
 */
async function readApprovalPlacement(page: Page) {
  return page.evaluate(() => {
    const rectOf = (node: Element | null) => {
      if (node === null) return null;
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    };
    const decision = document.querySelector('[data-approval-decision]');
    const buttons = [...(decision?.querySelectorAll('button') ?? [])].filter((button) =>
      ['Deny', 'Approve'].includes(button.textContent?.trim() ?? ''),
    );
    const question = decision?.querySelector('.cinder-approval-card__row-question') ?? null;
    const questionBox = question?.getBoundingClientRect();
    const questionHit =
      questionBox === undefined
        ? null
        : document.elementFromPoint(
            questionBox.x + questionBox.width / 2,
            questionBox.y + questionBox.height / 2,
          );
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      transcript: rectOf(document.querySelector('.chat-timeline')),
      card: rectOf(decision),
      question: rectOf(question),
      questionHitsItself:
        questionHit !== null && question !== null && question.contains(questionHit),
      reminder: document.querySelector('[data-chat-approval-drawer]') !== null,
      blocked: rectOf(document.querySelector('[data-chat-composer-status="blocked"]')),
      buttons: buttons.map((button) => {
        const box = button.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { box: rectOf(button), hitsItself: hit !== null && button.contains(hit) };
      }),
    };
  });
}

type ApprovalPlacement = Awaited<ReturnType<typeof readApprovalPlacement>>;

/** Deny and Approve are inside the transcript's visible box, a tap reaches each, and no reminder. */
function expectDecisionInView(read: ApprovalPlacement): void {
  expect(read.buttons).toHaveLength(2);
  const transcript = read.transcript!;
  for (const button of read.buttons) {
    const box = button.box!;
    expect(box.y).toBeGreaterThanOrEqual(transcript.y - 1);
    expect(box.y + box.height).toBeLessThanOrEqual(transcript.y + transcript.height + 1);
    expect(button.hitsItself).toBe(true);
  }
  // The reminder is for Deny and Approve out of view, so with both in view it is not drawn.
  expect(read.reminder).toBe(false);
}

/**
 * The narrow card says things once, so at 320 by 640 the whole of it fits: its question and Approve
 * are both inside the viewport and the transcript's visible box, and a tap reaches each (COR-2327).
 */
function expectQuestionAndApproveInView(read: ApprovalPlacement): void {
  const transcript = read.transcript!;
  const question = read.question!;
  const approve = read.buttons.at(-1)!.box!;
  for (const [name, box] of [
    ['question', question],
    ['Approve', approve],
  ] as const) {
    expect(box.y, `${name} top`).toBeGreaterThanOrEqual(Math.max(0, transcript.y - 1));
    expect(box.y + box.height, `${name} bottom`).toBeLessThanOrEqual(
      Math.min(read.viewport.height, transcript.y + transcript.height + 1),
    );
  }
  expect(read.questionHitsItself).toBe(true);
}

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

  test('the header’s More and the title switcher paint compact and answer a 44px press (COR-2327 B2)', async ({
    page,
  }) => {
    await openRefundFromList(page);
    await expect(trail(page).getByRole('button', { name: REFUND })).toBeVisible();
    // One layout, read once: each control's painted height, and whether presses at its centre and
    // 21px above and below it land on it.
    const read = await page.evaluate(() => {
      const measure = (control: Element | null) => {
        if (control === null) return null;
        const box = control.getBoundingClientRect();
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        // What a press lands on: the control itself, or the name of what took it instead.
        const lands = (at: number) => {
          const hit = document.elementFromPoint(x, at);
          return hit !== null && control.contains(hit)
            ? 'control'
            : `${hit?.tagName.toLowerCase() ?? 'nothing'}.${hit?.className ?? ''}`;
        };
        return { height: box.height, centre: lands(y), above: lands(y - 21), below: lands(y + 21) };
      };
      return {
        more: measure(
          document.querySelector('[data-testid="chat-header"] .cinder-dropdown-trigger'),
        ),
        title: measure(document.querySelector('.cinder-breadcrumbs__trigger')),
      };
    });
    expect(read.more).not.toBeNull();
    expect(read.more!.height).toBeLessThanOrEqual(32.5);
    expect(read.title).not.toBeNull();
    expect(read.title!.height).toBeLessThanOrEqual(30.5);
    // The title switcher sits a little above the top bar's centre, so the top bar's trail must not
    // clip its hit area vertically (CI run 43635945611 found it cut at the top).
    for (const [name, control] of [
      ['More', read.more!],
      ['title switcher', read.title!],
    ] as const) {
      expect(control.centre, `${name} centre`).toBe('control');
      expect(control.above, `${name}, 21px above`).toBe('control');
      expect(control.below, `${name}, 21px below`).toBe('control');
    }
  });

  test('at 320 by 640 the waiting approval opens with Deny and Approve in view and not covered, no reminder, and the reminder is one row once scrolled away (COR-2327 B1)', async ({
    page,
  }) => {
    await page.clock.setFixedTime(SAMPLE_NOW);
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`/chats/${SAMPLE_WORLD_THREADS.refund}`);
    const row = page.locator('[data-approval-decision]');
    await expect(row).toBeFocused();
    // The narrow card says things once, so the whole of it, question to Approve, fits above the
    // blocked row. Each attempt reads the whole layout in one pass and judges that pass, so a frame
    // mid-settle is never acted on.
    await expect(async () => {
      const read = await readApprovalPlacement(page);
      expectDecisionInView(read);
      expectQuestionAndApproveInView(read);
      // The blocked row stands under the transcript; its action has a line of its own (06m).
      expect(read.blocked).not.toBeNull();
    }).toPass();

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
      // The next drawn surface in the docked stack: the blocked row or the composer.
      let next = element.nextElementSibling;
      while (next !== null && next.getBoundingClientRect().height === 0) {
        next = next.nextElementSibling;
      }
      const space = document.createElement('div');
      space.style.blockSize = 'var(--cinder-space-3)';
      element.parentElement!.append(space);
      const token = space.getBoundingClientRect().height;
      space.remove();
      return {
        drawer: rectOf(element),
        text: rectOf(element.querySelector('.chat-approval-drawer-text')),
        button: rectOf(element.querySelector('button')),
        gapBelow:
          next === null
            ? null
            : next.getBoundingClientRect().top - element.getBoundingClientRect().bottom,
        token,
      };
    });
    // The docked stack keeps one gap: the reminder stands --cinder-space-3 clear of the row under it.
    expect(reminder.gapBelow).not.toBeNull();
    expect(Math.abs(reminder.gapBelow! - reminder.token)).toBeLessThanOrEqual(0.5);
    expect(reminder.token).toBe(12);
    // The reminder's own state, for design review: the transcript scrolled up so it shows, its
    // bottom edge fading into the docked stack.
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'approval reminder, transcript scrolled up',
      source: SOURCE,
    });
    expect(reminder.drawer.height).toBeLessThanOrEqual(60);
    expect(reminder.button.x).toBeGreaterThanOrEqual(reminder.text.x + reminder.text.width - 1);
    expect(reminder.button.y).toBeLessThan(reminder.text.y + reminder.text.height);
    expect(
      reminder.drawer.x + reminder.drawer.width - (reminder.button.x + reminder.button.width),
    ).toBeLessThan(20);
  });

  test('at 320 by 640 with a provider connected, the waiting approval’s decision row is in view and not covered by the live composer (COR-2327 B1)', async ({
    page,
  }) => {
    await connectProvider(page);
    await page.clock.setFixedTime(SAMPLE_NOW);
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`/chats/${SAMPLE_WORLD_THREADS.refund}`);
    // The live composer, not the blocked row, stands under the transcript.
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
    await expect(blockedRow(page)).toHaveCount(0);
    const row = page.locator('[data-approval-decision]');
    await expect(row).toBeFocused();
    // Deny and Approve in the transcript's view, a tap at each centre reaching it past the live
    // composer, the question in view too, and no reminder; each attempt judges one whole-layout read.
    await expect(async () => {
      const read = await readApprovalPlacement(page);
      expectDecisionInView(read);
      expectQuestionAndApproveInView(read);
    }).toPass();
  });

  test('on a phone tall enough for the whole waiting approval, the card opens whole, Deny and Approve in view, with no reminder (COR-2327 B1)', async ({
    page,
  }) => {
    await page.clock.setFixedTime(SAMPLE_NOW);
    await page.setViewportSize({ width: 320, height: 1000 });
    await page.goto(`/chats/${SAMPLE_WORLD_THREADS.refund}`);
    const row = page.locator('[data-approval-decision]');
    await expect(row).toBeFocused();
    await expect(async () => {
      const read = await readApprovalPlacement(page);
      expectDecisionInView(read);
      // The card fits the transcript, so all of it, its question through Deny and Approve, is in view.
      const transcript = read.transcript!;
      const card = read.card!;
      expect(card.height).toBeLessThan(transcript.height);
      expect(card.y).toBeGreaterThanOrEqual(transcript.y - 1);
      expect(card.y + card.height).toBeLessThanOrEqual(transcript.y + transcript.height + 1);
    }).toPass();
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
    // The primary ends the row at the card's trailing content edge (its padding lies between).
    expect(rowBox.x + rowBox.width - (approve.x + approve.width)).toBeLessThan(32);
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

  test('with no provider the composer is the blocked row: the reason wraps, and "Connect provider" drops to its own compact 44px line beneath, ending at the trailing edge (06m, 04y)', async ({
    page,
  }) => {
    await openRefundFromList(page);
    const row = blockedRow(page);
    await expect(row).toBeVisible();
    await expect(row.getByText(REASON)).toBeVisible();
    // The blocked row replaces the text box: nothing to type into, and Send never appears.
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send message' })).toHaveCount(0);

    const reason = await boxOf(row.getByText(REASON));
    const action = row.getByRole('button', { name: CONNECT });
    const actionBox = await boxOf(action);
    const rowBox = await boxOf(row);
    // Beneath the text, never over it, and across the row.
    expect(actionBox.y).toBeGreaterThanOrEqual(reason.y + reason.height - 1);
    expect(await touchHeight(action)).toBeGreaterThanOrEqual(44);
    // Compact, never a full-width slab, and ending at the row's trailing content edge (the row's
    // own padding lies between the action and its border).
    expect(actionBox.width).toBeLessThan(rowBox.width * 0.7);
    const trailingGap = rowBox.x + rowBox.width - (actionBox.x + actionBox.width);
    expect(trailingGap).toBeGreaterThanOrEqual(0);
    expect(trailingGap).toBeLessThan(24);
    // Nothing is queued and nothing pretends to be pending.
    await expect(page.getByText(/queued|sending|pending/i)).toHaveCount(0);
    expect(await scrollsSideways(page)).toBe(false);
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'no provider',
      source: SOURCE,
    });
  });

  test('on a phone the conversation column stands the phone gutter from each side: the title and the composer share the 16px edge (COR-2327)', async ({
    page,
  }) => {
    await connectProvider(page);
    await open(page, 375, `/chats/${SAMPLE_WORLD_THREADS.refund}`);
    await expect(page.getByRole('heading', { level: 1, name: REFUND })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
    // Each attempt reads every edge in one pass and judges that pass, never a frame mid-layout.
    await expect(async () => {
      const read = await page.evaluate(() => {
        const box = (selector: string) => {
          const element = document.querySelector(selector);
          if (element === null) return null;
          const { left, right } = element.getBoundingClientRect();
          return { left, right };
        };
        const gutter = document.createElement('div');
        gutter.style.inlineSize = 'var(--cinder-space-4)';
        document.body.append(gutter);
        const phoneGutter = gutter.getBoundingClientRect().width;
        gutter.remove();
        return {
          viewport: document.documentElement.clientWidth,
          phoneGutter,
          title: box('h1.cinder-page-header__title'),
          head: box('.weft-chat-head'),
          composer: box('.chat-input-shell'),
        };
      });
      expect(read.phoneGutter).toBe(16);
      expect(read.title).not.toBeNull();
      expect(read.composer).not.toBeNull();
      expect(Math.abs(read.title!.left - read.composer!.left)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(read.composer!.left - read.phoneGutter)).toBeLessThanOrEqual(0.5);
      // Symmetrical: the column ends the same gutter from the right edge.
      expect(Math.abs(read.viewport - read.composer!.right - read.phoneGutter)).toBeLessThanOrEqual(
        0.5,
      );
      expect(Math.abs(read.head!.right - read.composer!.right)).toBeLessThanOrEqual(0.5);
    }).toPass();
  });

  test('docks the composer at the bottom of the screen, blocked or live (04y)', async ({
    page,
  }) => {
    await openRefundFromList(page);
    // Under 700 pixels the shell's tab bar holds the bottom edge (COR-2315), so the composer docks on
    // top of it: the page's own margin and the pane's border lie between them, and nothing else.
    // The shell's column never scrolls: the tab bar's focus-ring room overhangs it by a few pixels,
    // and a focus that scrolled the column by them lifted the page 5px under the tab bar (CI run
    // 43635945611 read 41px here).
    expect(
      await page.evaluate(() => document.querySelector('.weft-shell-main')?.scrollTop ?? -1),
    ).toBe(0);
    const tabBar = await boxOf(page.getByRole('navigation', { name: NAVIGATION_COPY.tabBar }));
    const blocked = await boxOf(blockedRow(page));
    expect(tabBar.y - (blocked.y + blocked.height)).toBeGreaterThanOrEqual(0);
    expect(tabBar.y - (blocked.y + blocked.height)).toBeLessThan(40);

    const connected = await page.context().newPage();
    await connectProvider(connected);
    await open(connected, 375, `/chats/${SAMPLE_WORLD_THREADS.refund}`);
    const composer = connected.getByRole('textbox', { name: 'Message' });
    await expect(composer).toBeVisible();
    // The chat's history is in (COR-2327 B3): its waiting approval is drawn, and Send is Send.
    await expect(connected.locator('[data-approval-decision]')).toBeVisible();
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
    // The pane is as narrow as a phone's screen, but the screen is a tablet's: the reason wraps and
    // the action stays at its right, never under it (06n). Only a phone stacks them (06m).
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
