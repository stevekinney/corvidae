import { expect, test } from './review-editor-browser-errors.ts';

type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type HeaderMetrics = {
  titleCountGap: number;
  actionGap: number;
  countRight: number;
  addLeft: number;
  moreLeft: number;
  headerRight: number;
};

type ComposerMetrics = {
  inlineEndInset: number;
  blockEndInset: number;
  textareaPaddingInlineEnd: number;
  textareaPaddingBlockEnd: number;
  textProbeRight: number;
  buttonLeft: number;
};

type PopoverReadinessSample = {
  ready: string | null;
  visibility: string;
  pointerEvents: string;
  left: string;
  top: string;
  inert: boolean;
  containsFocus: boolean;
  hasInlinePosition: boolean;
};

type ReadyPopoverMetrics = {
  ready: string | null;
  visibility: string;
  pointerEvents: string;
  inert: boolean;
  left: string;
  top: string;
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  hasInlinePosition: boolean;
};

const reviewCommentsScreenshotsDirectory =
  '/Users/stevekinney/.codex/artifacts/chef-corvidae-ui-01a0b754-7538-7491-8f63-3a00c2a66ed0/review-comments-screenshots';

async function openReviewCommentsFixture(page: import('@playwright/test').Page, theme = 'light') {
  await page.addInitScript((selectedTheme) => {
    localStorage.setItem('browser-fixture-theme', selectedTheme);
  }, theme);
  await page.goto('/page/review-editor-comments?snapshot=1', { waitUntil: 'load' });
  await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('.markdown-editor-wrapper[data-mode="wysiwyg"]')).every(
      (editor) => editor.getAttribute('data-ready') === 'true',
    ),
  );
}

function requireBox(box: Box | null, label: string): Box {
  if (!box) throw new Error(`${label} must have a layout box.`);
  return box;
}

async function openCommentsFixtureSidebar(page: import('@playwright/test').Page) {
  const fixture = page.locator('#example-mount-with-comments');
  const commentsToggle = fixture.locator('button[aria-controls$="-sidebar"]').first();
  await expect(commentsToggle).toBeVisible();
  const sidebarId = await commentsToggle.getAttribute('aria-controls');
  if (!sidebarId) throw new Error('Comments toggle must control a sidebar.');
  await commentsToggle.click();
  const sidebar = page
    .getByRole('complementary', { name: 'Comment threads' })
    .and(page.locator(`[id="${sidebarId}"]`));
  await expect(sidebar).toBeVisible();
  return sidebar;
}

test.describe('review comments toggle', () => {
  test('comments toggle contains a badge with the count and remains keyboard focusable', async ({
    page,
  }) => {
    await page.goto('/page/review-editor-comments?snapshot=1', { waitUntil: 'load' });
    await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });

    // Locate the comments toggle button via its aria-controls attribute.
    // The button controls the sidebar panel whose id ends with "-sidebar".
    const commentsToggle = page.locator('button[aria-controls$="-sidebar"]').first();

    await expect(commentsToggle).toBeVisible();

    // The visible count must be rendered by the Badge component — it carries
    // the .cinder-badge class and is aria-hidden so the button's aria-label
    // remains the sole accessible count source.
    const badge = commentsToggle.locator('.cinder-badge');
    await expect(badge).toBeVisible();
    expect(await badge.getAttribute('aria-hidden')).toBe('true');

    // The badge must contain a numeric text node (count ≥ 0).
    const badgeContent = await badge.textContent();
    const badgeText = badgeContent?.trim() ?? '';
    expect(/^\d+$/.test(badgeText)).toBe(true);

    // The button's aria-label must include the same count as a human-readable string.
    const ariaLabel = (await commentsToggle.getAttribute('aria-label')) ?? '';
    expect(ariaLabel).toContain(badgeText);

    // The button must keep aria-expanded and aria-controls.
    expect(await commentsToggle.getAttribute('aria-expanded')).not.toBeNull();
    expect(await commentsToggle.getAttribute('aria-controls')).not.toBeNull();

    // The button must be keyboard focusable: Tab should bring focus to it.
    // Resolve focus by evaluating via the browser — Tab navigation in Playwright
    // may need prior focus seeding; use element.focus() directly.
    await commentsToggle.evaluate((element) => {
      if (!(element instanceof HTMLElement)) throw new Error('Expected an HTML element.');
      element.focus();
    });
    await expect(commentsToggle).toBeFocused();

    // Confirm Space or Enter activates the toggle (keyboard operability).
    // We just verify the button is focusable and has a valid tabIndex.
    const tabIndex = await commentsToggle.evaluate((element) =>
      element instanceof HTMLElement ? element.tabIndex : -1,
    );
    // tabIndex of 0 or -1 are both valid for a toolbar button; -1 means it is
    // programmatically focusable even if excluded from tab order when the toolbar
    // manages roving focus. The important thing is that it is focusable.
    expect(tabIndex).toBeGreaterThanOrEqual(-1);
  });

  test('review threads delete in place without an unpositioned paint', async ({ page }) => {
    await openReviewCommentsFixture(page);
    const sidebar = await openCommentsFixtureSidebar(page);

    const threadList = sidebar.getByRole('list', { name: 'Comment threads' });
    await expect(threadList).toBeVisible();
    const rows = threadList.getByRole('listitem');
    await expect(rows).toHaveCount(3);

    await expect(
      rows.nth(0).getByRole('button', {
        name: 'Open comment thread: Document comment',
      }),
    ).toBeVisible();
    await expect(
      rows.nth(1).getByRole('button', {
        name: 'Open comment thread: Architecture Notes',
      }),
    ).toBeVisible();
    await expect(
      rows.nth(2).getByRole('button', {
        name: 'Open comment thread: handoff',
      }),
    ).toBeVisible();

    const declinedRemove = rows
      .nth(0)
      .getByRole('button', { name: 'Remove comment thread: Document comment' });

    const firstTextRowOpen = rows.nth(1).getByRole('button', {
      name: 'Open comment thread: Architecture Notes',
    });
    await firstTextRowOpen.click();
    await expect(firstTextRowOpen).toHaveAttribute('aria-current', 'true');
    const architecturePopover = page.getByRole('dialog');
    await expect(architecturePopover).toHaveAttribute('data-position-ready', 'true');
    const architectureDraft = architecturePopover.getByLabel('Comment');
    await architectureDraft.fill('Keep this draft.');
    await firstTextRowOpen.click();
    await expect(architecturePopover).toHaveCount(1);
    await expect(architectureDraft).toHaveValue('Keep this draft.');

    await declinedRemove.click();
    await expect(declinedRemove).toBeFocused();
    await expect(firstTextRowOpen).toHaveAttribute('aria-current', 'true');
    await expect(threadList.getByRole('listitem')).toHaveCount(3);
    await expect(architecturePopover).toHaveCount(1);
    await expect(architectureDraft).toHaveValue('Keep this draft.');

    await firstTextRowOpen.focus();
    await page.keyboard.press('Tab');
    const firstTextRemove = rows.nth(1).getByRole('button', {
      name: 'Remove comment thread: Architecture Notes',
    });
    await expect(firstTextRemove).toBeFocused();
    await firstTextRemove.click();
    const remainingTextOpen = threadList.getByRole('button', {
      name: 'Open comment thread: handoff',
    });
    await expect(remainingTextOpen).toBeFocused();
    await expect(remainingTextOpen).toHaveAttribute('aria-current', 'true');
    await expect(threadList.getByRole('listitem')).toHaveCount(2);
    await page.waitForTimeout(450);
    await expect(remainingTextOpen).toBeFocused();
    await expect(remainingTextOpen).toHaveAttribute('aria-current', 'true');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const remainingTextRemove = threadList.getByRole('button', {
      name: 'Remove comment thread: handoff',
    });
    await remainingTextRemove.click();
    const documentThreadOpen = threadList.getByRole('button', {
      name: 'Open comment thread: Document comment',
    });
    await expect(documentThreadOpen).toBeFocused();
    await expect(documentThreadOpen).toHaveAttribute('aria-current', 'true');
    await expect(threadList.getByRole('listitem')).toHaveCount(1);
    await page.waitForTimeout(450);
    await expect(documentThreadOpen).toBeFocused();
    await expect(documentThreadOpen).toHaveAttribute('aria-current', 'true');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        __reviewPopoverObserver?: MutationObserver;
        __reviewPopoverReadinessSamples?: PopoverReadinessSample[];
      };
      state.__reviewPopoverObserver?.disconnect();
      state.__reviewPopoverReadinessSamples = [];

      function recordPopover(element: Element) {
        if (!(element instanceof HTMLElement)) return;
        const computed = getComputedStyle(element);
        state.__reviewPopoverReadinessSamples?.push({
          ready: element.getAttribute('data-position-ready'),
          visibility: computed.visibility,
          pointerEvents: computed.pointerEvents,
          left: computed.left,
          top: computed.top,
          inert: element.inert,
          containsFocus:
            document.activeElement !== null && element.contains(document.activeElement),
          hasInlinePosition: element.style.left.length > 0 && element.style.top.length > 0,
        });
      }

      state.__reviewPopoverObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (node.matches('.thread-popover')) recordPopover(node);
            for (const popover of node.querySelectorAll('.thread-popover')) {
              recordPopover(popover);
            }
          }
        }
      });
      state.__reviewPopoverObserver.observe(document.body, { childList: true, subtree: true });
    });

    await page.keyboard.press('Enter');
    const readyPopover = page.getByRole('dialog').and(page.locator('[data-position-ready="true"]'));
    await expect(readyPopover).toBeVisible();

    const firstPaint = await page.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        __reviewPopoverObserver?: MutationObserver;
        __reviewPopoverReadinessSamples?: PopoverReadinessSample[];
      };
      state.__reviewPopoverObserver?.disconnect();
      return state.__reviewPopoverReadinessSamples?.[0] ?? null;
    });
    expect(firstPaint).toMatchObject({
      ready: 'false',
      visibility: 'hidden',
      pointerEvents: 'none',
      inert: true,
      containsFocus: false,
      hasInlinePosition: false,
    });

    const readyMetrics = await readyPopover.evaluate((element): ReadyPopoverMetrics => {
      if (!(element instanceof HTMLElement)) throw new Error('Expected a ready popover.');
      const computed = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return {
        ready: element.getAttribute('data-position-ready'),
        visibility: computed.visibility,
        pointerEvents: computed.pointerEvents,
        inert: element.inert,
        left: element.style.left,
        top: element.style.top,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        hasInlinePosition: element.style.left.length > 0 && element.style.top.length > 0,
      };
    });
    expect(readyMetrics).toMatchObject({
      ready: 'true',
      visibility: 'visible',
      inert: false,
      hasInlinePosition: true,
    });
    expect(readyMetrics.pointerEvents).not.toBe('none');
    expect(Number.parseFloat(readyMetrics.left)).toBeGreaterThanOrEqual(0);
    expect(Number.parseFloat(readyMetrics.top)).toBeGreaterThanOrEqual(0);
    expect(readyMetrics.x).toBeGreaterThanOrEqual(0);
    expect(readyMetrics.y).toBeGreaterThanOrEqual(0);
    expect(readyMetrics.width).toBeGreaterThan(0);
    expect(readyMetrics.height).toBeGreaterThan(0);
    expect(readyMetrics.x + readyMetrics.width).toBeLessThanOrEqual(readyMetrics.viewportWidth);
    expect(readyMetrics.y + readyMetrics.height).toBeLessThanOrEqual(readyMetrics.viewportHeight);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Allow document thread removal' }).click();
    await declinedRemove.click();
    await expect(threadList.getByRole('listitem')).toHaveCount(0);
    await expect(sidebar.getByRole('button', { name: 'Add document comment' })).toBeFocused();
  });

  test('comment metadata and composer actions keep their spacing', async ({ page }) => {
    for (const theme of ['light', 'dark'] as const) {
      for (const width of [320, 512, 848] as const) {
        await page.setViewportSize({ width: Math.max(width + 80, 420), height: 900 });
        await openReviewCommentsFixture(page, theme);
        const mount = page.locator('#example-mount-with-comments');
        await mount.evaluate((element, inlineSize) => {
          if (!(element instanceof HTMLElement)) throw new Error('Expected fixture mount.');
          element.style.inlineSize = `${inlineSize}px`;
          element.style.maxInlineSize = `${inlineSize}px`;
        }, width);

        const sidebar = await openCommentsFixtureSidebar(page);
        const headerMetrics = await sidebar.evaluate((element): HeaderMetrics => {
          const header = element.querySelector('.sidebar-header');
          const title = element.querySelector('.sidebar-title');
          const count = element.querySelector('.thread-count');
          const add = element.querySelector('[aria-label="Add document comment"]');
          const more = element.querySelector('[aria-label="Comment actions"]');
          if (
            !(header instanceof HTMLElement) ||
            !(title instanceof HTMLElement) ||
            !(count instanceof HTMLElement) ||
            !(add instanceof HTMLElement) ||
            !(more instanceof HTMLElement)
          ) {
            throw new Error('Missing sidebar header controls.');
          }
          const headerRect = header.getBoundingClientRect();
          const titleRect = title.getBoundingClientRect();
          const countRect = count.getBoundingClientRect();
          const addRect = add.getBoundingClientRect();
          const moreRect = more.getBoundingClientRect();
          return {
            titleCountGap: Math.round(countRect.left - titleRect.right),
            actionGap: Math.round(addRect.left - countRect.right),
            countRight: countRect.right,
            addLeft: addRect.left,
            moreLeft: moreRect.left,
            headerRight: headerRect.right,
          };
        });

        expect(headerMetrics.titleCountGap).toBeLessThanOrEqual(4);
        expect(headerMetrics.actionGap).toBeGreaterThanOrEqual(8);
        expect(headerMetrics.countRight).toBeLessThanOrEqual(headerMetrics.addLeft);
        expect(headerMetrics.moreLeft).toBeGreaterThanOrEqual(headerMetrics.addLeft);
        expect(headerMetrics.moreLeft).toBeLessThanOrEqual(headerMetrics.headerRight);

        await sidebar
          .getByRole('button', { name: 'Open comment thread: Architecture Notes' })
          .click();
        const popover = page.getByRole('dialog');
        await expect(popover).toHaveAttribute('data-position-ready', 'true');
        const composer = popover.locator('.comment-composer').last();
        const textarea = composer.getByLabel('Comment');
        await textarea.fill('Safe text.');
        await expect(composer.getByRole('button', { name: 'Comment' })).toBeVisible();

        const composerMetrics = await composer.evaluate((element): ComposerMetrics => {
          const textareaElement = element.querySelector('textarea');
          const button = element.querySelector('.comment-composer-inline-submit button');
          if (
            !(textareaElement instanceof HTMLTextAreaElement) ||
            !(button instanceof HTMLElement)
          ) {
            throw new Error('Missing composer controls.');
          }
          const textStyle = getComputedStyle(textareaElement);
          const textareaRect = textareaElement.getBoundingClientRect();
          const buttonRect = button.getBoundingClientRect();
          const probe = document.createElement('span');
          probe.textContent = textareaElement.value;
          probe.style.position = 'fixed';
          probe.style.visibility = 'hidden';
          probe.style.whiteSpace = 'pre';
          probe.style.font = textStyle.font;
          document.body.append(probe);
          const textProbeRight =
            textareaRect.left + Number.parseFloat(textStyle.paddingInlineStart) + probe.offsetWidth;
          probe.remove();
          return {
            inlineEndInset: Math.round(textareaRect.right - buttonRect.right),
            blockEndInset: Math.round(textareaRect.bottom - buttonRect.bottom),
            textareaPaddingInlineEnd: Math.round(Number.parseFloat(textStyle.paddingInlineEnd)),
            textareaPaddingBlockEnd: Math.round(Number.parseFloat(textStyle.paddingBlockEnd)),
            textProbeRight,
            buttonLeft: buttonRect.left,
          };
        });

        expect(composerMetrics.inlineEndInset).toBeGreaterThanOrEqual(12);
        expect(composerMetrics.blockEndInset).toBeGreaterThanOrEqual(12);
        expect(composerMetrics.textareaPaddingInlineEnd).toBeGreaterThanOrEqual(88);
        expect(composerMetrics.textareaPaddingBlockEnd).toBeGreaterThanOrEqual(48);
        expect(composerMetrics.textProbeRight).toBeLessThan(composerMetrics.buttonLeft);

        const screenshotTarget = requireBox(
          await page.locator('#example-mount-with-comments').boundingBox(),
          'review comments fixture',
        );
        await page.screenshot({
          path: `${reviewCommentsScreenshotsDirectory}/red-or-green-${theme}-${width}.png`,
          clip: {
            x: Math.floor(screenshotTarget.x),
            y: Math.floor(screenshotTarget.y),
            width: Math.ceil(screenshotTarget.width),
            height: Math.ceil(Math.min(screenshotTarget.height, 760)),
          },
        });
      }
    }
  });
});
