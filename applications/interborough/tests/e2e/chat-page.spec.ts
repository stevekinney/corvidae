/**
 * An open chat on the sample world (`fixtures/sample-world-seed.ts`, the showcase host) at the
 * browser's sample clock, Monday, Nov 2, 10:46 AM Central time (COR-2016, design rows 16a, 16m,
 * 16u, 16v, 17g): the breadcrumb that names the chat, the approval the chat opens on, the details
 * popover the breadcrumb opens, and the Permissions select open. Each frame is captured for the
 * design review under its own name.
 */
import type { Page } from '@playwright/test';

import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { SAMPLE_WORLD_THREADS } from '../../fixtures/sample-world-records.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'chat-page.spec.ts';
const TITLE = 'Please refund order 4471, it arrived damaged.';

/** Opens the refund chat at 1280 pixels and waits until its transcript is drawn. */
async function openRefundChat(page: Page): Promise<void> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/chats/${SAMPLE_WORLD_THREADS.refund}`);
  await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('[data-approval-decision]')).toBeVisible();
}

const trail = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' });

test.describe('an open chat on the sample world', () => {
  test('reads Chat, then a button naming the chat with a chevron (16a)', async ({ page }) => {
    await openRefundChat(page);
    await expect(trail(page).getByRole('link', { name: 'Chat' })).toBeVisible();
    const button = trail(page).getByRole('button', { name: TITLE });
    await expect(button).toBeVisible();
    await expect(button.locator('svg')).toBeVisible();
    await expect(trail(page)).not.toContainText(SAMPLE_WORLD_THREADS.refund);
  });

  test('scrolls the pending approval into view and focuses it without answering it (16m)', async ({
    page,
  }) => {
    await openRefundChat(page);
    const row = page.locator('[data-approval-decision]');
    await expect(row).toBeFocused();
    await expect(row).toBeInViewport();
    // Nothing was answered: the approval is still waiting, with both choices enabled.
    await expect(row.getByRole('button', { name: 'Approve' })).toBeEnabled();
    await expect(row.getByRole('button', { name: 'Deny' })).toBeEnabled();
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'approval focused',
      source: SOURCE,
    });
  });

  test('opens the details popover from the breadcrumb: session, agent, started and As run (16u, 16v)', async ({
    page,
  }) => {
    await openRefundChat(page);
    await trail(page).getByRole('button', { name: TITLE }).click();
    const details = page.getByTestId('chat-details');
    await expect(details).toBeVisible();

    await expect(details.getByTestId('chat-details-session')).toHaveText(
      SAMPLE_WORLD_THREADS.refund,
    );
    await expect(details.getByRole('button', { name: 'Copy session ID' })).toBeVisible();
    const agent = details.getByRole('link', { name: 'Tool runner' });
    await expect(agent).toHaveAttribute('href', '/agents/tool-runner');
    await expect(details.locator('code', { hasText: /^tool-runner$/ })).toBeVisible();
    await expect(details).toContainText(/Started\s*Today, 10:30 AM · last active 10:4\d AM/);

    const asRun = details.getByRole('region', { name: 'As run' });
    await expect(asRun).toContainText('Claude Sonnet 5.5');
    await expect(asRun.locator('code', { hasText: /^claude-sonnet-5-5$/ })).toBeVisible();
    await expect(asRun).toContainText(/Effort\s*Medium/);
    await expect(asRun).toContainText(/Permissions\s*On changes asks/);
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'details popover open',
      source: SOURCE,
    });
  });

  test('opens the Permissions select with a help line under each option (17g)', async ({
    page,
  }) => {
    await openRefundChat(page);
    await page.getByRole('combobox', { name: 'Permissions' }).click();
    const allowAll = page.getByRole('option', { name: /Allow all/ });
    await expect(allowAll).toContainText(
      'Skips the On changes asks for this chat. Tools set to Always still ask; Blocked tools stay blocked.',
    );
    await expect(page.getByRole('option', { name: /^On changes asks/ })).toContainText(
      'Tools set to On changes ask before they run.',
    );
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'permissions select open',
      source: SOURCE,
    });
  });
});
