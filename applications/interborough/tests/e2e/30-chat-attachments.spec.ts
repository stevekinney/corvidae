/**
 * Attaching a file in a chat, against the real host (COR-1548). The echo agent (`echo-agent.ts`)
 * takes an attached image and sends it back, so one case covers the whole path: the file uploads
 * through the Bureau's upload operations as it is attached, the message goes out naming the asset,
 * and the image the agent returns is a new asset the page shows from the Bureau's content route.
 * The case runs at a phone's width and a desktop's, with axe passing on each.
 */
import type { Page } from '@playwright/test';

import { ECHO_NOTHING_REPLY, IMAGE_ECHO_AGENT_NAME } from './echo-agent.ts';
import { expect, test } from './fixtures.ts';

/** A 1 x 1 PNG: real bytes, so the Bureau detects its type and a browser decodes it. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const CONTENT_ROUTE = /\/bureau\/assets\/[^/]+\/content$/;

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 1280, height: 800 },
] as const;

/** Whether the image at `selector` has loaded and decoded. */
async function decoded(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate((image) => (image as HTMLImageElement).naturalWidth);
}

for (const viewport of VIEWPORTS) {
  test(`attaches an image and sees the echo, at ${viewport.width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/chat/new?agent=${IMAGE_ECHO_AGENT_NAME}`);
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');

    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PIXEL });
    const attachment = page.locator('.chat-attachment-preview');
    await expect(attachment).toHaveAttribute('data-state', 'ready');
    await checkA11y(`an attached image, at ${viewport.width} pixels`);

    await page.getByRole('textbox').fill('Say it back');
    await page.getByRole('textbox').press('Enter');

    const echoed = 'ul.weft-chat-assets[data-role="assistant"] img';
    await expect(page.getByText('Echoed 1 image.')).toBeVisible();
    await expect(page.locator(echoed)).toHaveAttribute('src', CONTENT_ROUTE);
    await expect.poll(() => decoded(page, echoed)).toBeGreaterThan(0);
    // The composer is empty again, and the person's own image is on their row.
    await expect(attachment).toHaveCount(0);
    const own = 'ul.weft-chat-assets[data-role="user"] img';
    await expect(page.locator(own)).toHaveAttribute('src', CONTENT_ROUTE);
    await expect.poll(() => decoded(page, own)).toBeGreaterThan(0);
    await checkA11y(`the echoed image, at ${viewport.width} pixels`);

    // Reloaded, the thread shows the same two images from the Bureau's snapshot.
    const returned = await page.locator(echoed).getAttribute('src');
    await page.reload();
    await expect(page.getByText('Echoed 1 image.')).toBeVisible();
    await expect(page.locator(echoed)).toHaveAttribute('src', returned ?? '');
    await expect.poll(() => decoded(page, echoed)).toBeGreaterThan(0);
    await expect.poll(() => decoded(page, own)).toBeGreaterThan(0);
  });
}

test('offers no way to attach to an agent that names no model', async ({ page }) => {
  await page.goto('/chat/new?agent=assistant');
  await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');

  await expect(page.getByRole('textbox')).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Attach file' })).toHaveCount(0);
});

test('takes a text file the picker offers, and shows it as a download on the person’s row', async ({
  page,
}) => {
  await page.goto(`/chat/new?agent=${IMAGE_ECHO_AGENT_NAME}`);
  await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');

  await page.locator('input[type="file"]').setInputFiles({
    name: 'note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello there'),
  });
  await expect(page.locator('.chat-attachment-preview')).toHaveAttribute('data-state', 'ready');
  await page.getByRole('textbox').fill('Read this');
  await page.getByRole('textbox').press('Enter');

  // The run is accepted, not refused over the file's type: the echo reads it and has no image to send.
  await expect(page.getByText(ECHO_NOTHING_REPLY)).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'The agent did not answer' })).toHaveCount(
    0,
  );
  const download = page.locator('ul.weft-chat-assets[data-role="user"] a[download]');
  await expect(download).toHaveAttribute('href', CONTENT_ROUTE);
});
