import { expect, test } from '@playwright/test';
import { gotoHydrated } from '../hydration';

test('ChatConversationHeader renders its built-in export actions by default', async ({
  context,
  page,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await gotoHydrated(page, '/exercises/conversation-list');

  const header = page.getByTestId('header-default-export');
  await expect(header.getByRole('heading', { name: 'Header demo conversation' })).toBeVisible();

  // 3 participant names truncate to "first two + N" in the display label,
  // with the full list available via the title attribute.
  const participants = header.getByText('Priya Patel, Sam Osei +1');
  await expect(participants).toBeVisible();
  await expect(participants).toHaveAttribute('title', 'Priya Patel, Sam Osei, Lee Kim');

  await header.getByRole('button', { name: 'Export conversation' }).click();
  await header.getByRole('menuitem', { name: /Copy as Markdown/ }).click();

  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toContain('Testing the header export actions.');
  await expect(page.getByText('Copied as Markdown')).toBeAttached();
});
