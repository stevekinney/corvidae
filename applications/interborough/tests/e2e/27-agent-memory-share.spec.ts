/** A memory share on the real two-owner workspace host. */
import type { Browser, BrowserContext } from '@playwright/test';

import { MEMORY_COPY } from '../../src/app/copy/memory.ts';
import { captureOpenMenuForDesignReview } from './design-review-capture.ts';
import { E2E_CHAT_SHARING_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

const OWNER_KEY = 'chat-owner-browser-key';
const READER_OWNER = 'chat-sharing:reader';
const AGENT = 'echo-text';

const uniqueLabel = () => `Shared memory ${crypto.randomUUID().slice(0, 8)}`;

async function owner(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: E2E_CHAT_SHARING_URL,
    extraHTTPHeaders: { 'x-api-key': OWNER_KEY },
    reducedMotion: 'reduce',
  });
}

test.describe('memory sharing on a multi-owner workspace /agents/:agent/memory', () => {
  test('shares a memory with the other workspace owner', async ({ browser }) => {
    const ownerContext = await owner(browser);
    const page = await ownerContext.newPage();
    const label = uniqueLabel();
    try {
      await page.goto(`/chats/new?agent=${AGENT}`);
      await page.getByRole('textbox', { name: 'Message' }).fill(label);
      await page.locator('button[data-chat-send]').click();
      await expect(page.locator('article[data-message-id]').filter({ hasText: label })).toHaveCount(
        2,
      );

      await page.goto(`/agents/${AGENT}/memory`);
      const row = page.locator('[data-memory]', { hasText: label });
      await expect(row).toHaveCount(1);
      await row.locator('.ib-memory__content').click();
      const detail = page.getByRole('region', { name: MEMORY_COPY.detail.heading });
      await expect(detail.locator('h2', { hasText: label })).toBeVisible();

      const more = detail.locator('details');
      await more.locator('summary').click();
      await captureOpenMenuForDesignReview(page, {
        route: '/agents/:agent/memory',
        state: 'multi-owner more options',
        tab: 'Memory',
        source: '27-agent-memory-share.spec.ts',
        ready: async (capturePage) => {
          const more = capturePage
            .getByRole('region', { name: MEMORY_COPY.detail.heading })
            .locator('details');
          await more.locator('summary').scrollIntoViewIfNeeded();
          if ((await more.getAttribute('open')) === null) await more.locator('summary').click();
        },
      });
      await detail.getByRole('button', { name: MEMORY_COPY.govern.share.action }).click();
      const dialog = page.getByRole('dialog', { name: MEMORY_COPY.govern.share.dialog.title });
      await dialog.getByLabel(MEMORY_COPY.govern.share.dialog.label).fill(READER_OWNER);
      await dialog.getByRole('button', { name: MEMORY_COPY.govern.share.dialog.submit }).click();

      await expect(page.getByText(MEMORY_COPY.govern.share.outcome.granted.title)).toBeVisible();
    } finally {
      await ownerContext.close();
    }
  });
});
