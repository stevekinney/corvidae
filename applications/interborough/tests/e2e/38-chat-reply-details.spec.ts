/**
 * An agent reply’s details (COR-1983), against the real host. A reply the Bureau recorded as a step
 * of a run offers a popover that says why the step ran on its model and what the model saw, read
 * from `bureau.tasks.inspect`. The seeded agent names its model, so the plan reason reads Named, not
 * ranked. Nothing the Bureau does not carry is printed: no cost, no time. The case runs at a phone’s
 * width and a desktop’s, with axe passing, and the popover stays inside the viewport.
 */
import type { Page } from '@playwright/test';

import { CHAT_COPY } from '../../src/app/copy.ts';
import { newThreadId, runToEnd } from './chat-support.ts';
import { expect, test } from './fixtures.ts';

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 1280, height: 800 },
] as const;

const COPY = CHAT_COPY.replyDetails;
const ASSISTANT_ROW = '[data-message-role="assistant"]';

const detailsAction = (page: Page) => page.getByRole('button', { name: COPY.action });

for (const viewport of VIEWPORTS) {
  test(`opens the details of a reply, with why its model and what it saw, at ${viewport.width} pixels`, async ({
    page,
    request,
    checkA11y,
  }) => {
    await page.setViewportSize(viewport);
    const threadId = newThreadId('reply-details');
    await runToEnd(request, 'demo:assistant', threadId, 'Say hello');
    await page.goto(`/chats/${threadId}`);
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator(ASSISTANT_ROW)).toHaveCount(1);

    await page.locator(ASSISTANT_ROW).first().hover();
    await detailsAction(page).first().click();

    const panel = page.getByTestId('reply-details');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { name: COPY.why })).toBeVisible();
    await expect(panel).toContainText(COPY.planReasons.pinned);
    await expect(panel.getByRole('heading', { name: COPY.saw })).toBeVisible();
    // The count is the Bureau's: the person's question, and whatever the host keeps in the prompt.
    await expect(panel).toContainText(/\d+ messages?/);
    // The run's tokens come from a terminal event this page did not watch, so none are printed; and
    // neither source carries a cost, so none is estimated.
    await expect(panel.locator('[data-part="usage"]')).toHaveCount(0);
    await expect(panel).not.toContainText(/\$|cost:|took /i);

    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    await checkA11y(`a reply’s details, at ${viewport.width} pixels`);
  });
}
