import { colorAlpha, openTouchPage, TOUCH_TARGET_MIN } from './editors-complex-support.ts';
import { fixtureRoute } from './overlay-fixture.ts';
import { expect, test } from './review-editor-browser-errors.ts';

const CHAT_ROUTE = fixtureRoute('chat');

async function describedbyText(
  locator: import('@playwright/test').Locator,
): Promise<string | null> {
  return locator.evaluate((element) => {
    const describedby = element.getAttribute('aria-describedby');
    if (!describedby) return null;
    return describedby
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
  });
}

test.describe('chat action buttons', () => {
  test('narrow hover layouts do not reserve space for hidden actions', async ({ page }) => {
    await page.setViewportSize({ width: 414, height: 896 });
    await page.goto(CHAT_ROUTE, { waitUntil: 'load' });
    await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });

    expect(await page.evaluate(() => window.matchMedia('(hover: hover)').matches)).toBe(true);

    const copyButton = page.locator('.chat-message-copy').first();
    const actionableRow = copyButton.locator(
      'xpath=ancestor::*[contains(@class, "chat-message-wrapper")]',
    );
    await expect(actionableRow).toHaveCSS('margin-block-end', '0px');
  });

  test('built-in action buttons have a visible resting affordance and touch-sized target', async ({
    browser,
  }) => {
    const { page, dispose } = await openTouchPage(browser, CHAT_ROUTE, 'light');
    try {
      const copyButton = page.locator('.chat-message-copy').first();
      await expect(copyButton).toBeVisible();
      await copyButton.scrollIntoViewIfNeeded();

      expect(await colorAlpha(copyButton, 'backgroundColor')).toBeGreaterThan(0);
      expect(await colorAlpha(copyButton, 'borderTopColor')).toBeGreaterThan(0);

      const restingColor = await copyButton.evaluate((element) => getComputedStyle(element).color);

      const box = await copyButton.boundingBox();
      expect(box).not.toBeNull();
      if (box === null) throw new Error('Copy button has no layout box.');
      expect(box.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN - 0.5);
      expect(box.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN - 0.5);

      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: () => Promise.resolve() },
        });
      });

      const actionableRow = copyButton.locator(
        'xpath=ancestor::*[contains(@class, "chat-message-wrapper")]',
      );
      const space1Px = await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.cssText =
          'position:absolute;width:var(--cinder-space-1);visibility:hidden;pointer-events:none';
        document.body.appendChild(probe);
        const px = parseFloat(getComputedStyle(probe).width);
        probe.remove();
        return px;
      });
      await expect(actionableRow).toHaveCSS('margin-block-end', `${TOUCH_TARGET_MIN + space1Px}px`);

      const hitTarget = await copyButton.evaluate((element) => {
        const hitBox = element.getBoundingClientRect();
        const target = document.elementFromPoint(
          hitBox.x + hitBox.width / 2,
          hitBox.y + hitBox.height / 2,
        );
        return {
          className: target instanceof HTMLElement ? target.className : null,
          isCopyButton: target === element || element.contains(target),
          tagName: target?.tagName ?? null,
        };
      });
      expect(hitTarget.isCopyButton, JSON.stringify(hitTarget)).toBe(true);

      const emptyToolRow = page.locator('.chat-message-wrapper[data-role="tool-call"]').first();
      await expect(emptyToolRow).toBeVisible();
      await expect(emptyToolRow.locator('.chat-message-actions > *')).toHaveCount(0);
      await expect(emptyToolRow).toHaveCSS('margin-block-end', '0px');

      await copyButton.click();
      // CopyButton signals the copied state via `data-cinder-copied` attribute.
      const successButton = page.locator('.chat-message-copy[data-cinder-copied]').first();
      await expect(successButton).toBeVisible();
      const successColor = await successButton.evaluate(
        (element) => getComputedStyle(element).color,
      );
      expect(successColor).not.toBe(restingColor);
    } finally {
      await dispose();
    }
  });

  test('wide touch layouts reserve only below-bubble action rows', async ({ browser }) => {
    const { page, dispose } = await openTouchPage(browser, CHAT_ROUTE, 'light', {
      width: 768,
      height: 1024,
    });
    try {
      const space1Px = await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.cssText =
          'position:absolute;width:var(--cinder-space-1);visibility:hidden;pointer-events:none';
        document.body.appendChild(probe);
        const px = parseFloat(getComputedStyle(probe).width);
        probe.remove();
        return px;
      });

      const toolPairRow = page.locator('.chat-message-wrapper[data-tool-pair]').first();
      await expect(toolPairRow).toBeVisible();
      await toolPairRow.locator('.chat-message-actions').evaluate((actions) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Test action';
        actions.appendChild(button);
      });
      await expect(toolPairRow).toHaveCSS('margin-block-end', `${TOUCH_TARGET_MIN + space1Px}px`);

      const assistantCopyButton = page
        .locator('.chat-message-wrapper[data-role="assistant"] .chat-message-copy')
        .first();
      await expect(assistantCopyButton).toBeVisible();
      const assistantRow = assistantCopyButton.locator(
        'xpath=ancestor::*[contains(@class, "chat-message-wrapper")]',
      );
      await expect(assistantRow).toHaveCSS('margin-block-end', '0px');
    } finally {
      await dispose();
    }
  });
});

test.describe('chat input shortcut', () => {
  test('composer and send button both expose shortcut description via aria-describedby', async ({
    page,
  }) => {
    // A11y wiring is viewport-independent; use the default desktop context so
    // the send button and editor surface are always rendered.
    await page.goto(CHAT_ROUTE, { waitUntil: 'load' });
    await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });

    const composer = page.locator('textarea.chat-input-editor').first();
    await expect(composer).toBeVisible();
    await composer.focus();

    const composerDescribedby = await describedbyText(composer);
    expect(composerDescribedby).toBeTruthy();
    expect(composerDescribedby).toMatch(/Enter/);
    expect(composerDescribedby).toMatch(/Shift\s*\+?\s*Enter/i);

    // The send button references the same shortcut description.
    const sendButton = page
      .locator(
        '.chat-input-send, button[aria-label="Send message"], button[aria-label="Sending message"]',
      )
      .first();
    await expect(sendButton).toBeVisible();
    const sendDescribedby = await describedbyText(sendButton);
    expect(sendDescribedby).toBeTruthy();
    expect(sendDescribedby).toMatch(/Enter/);
    expect(sendDescribedby).toMatch(/Shift\s*\+?\s*Enter/i);
  });
});
