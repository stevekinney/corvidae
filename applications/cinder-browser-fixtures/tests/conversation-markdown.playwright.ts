import { expect, test } from '@playwright/test';
import { fixtureRoute } from './editor-fixture.ts';

test.describe('conversation Markdown root API', () => {
  test('round-trips ordered messages, IDs, and metadata through YAML Markdown', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => {
      failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`);
    });
    await page.goto(fixtureRoute('conversation-markdown'), { waitUntil: 'load' });
    const proof = page.getByTestId('conversation-markdown-proof');
    await expect(proof).toBeVisible();

    const messageOrder = await page.getByTestId('message-order').textContent();
    await expect(page.getByTestId('parsed-message-order')).toHaveText(messageOrder ?? '');
    await expect(page.getByTestId('controller-message-order')).toHaveText(messageOrder ?? '');
    await expect(page.getByTestId('conversation-metadata')).toHaveText('corvidae');
    await expect(page.getByTestId('message-metadata')).toHaveText('1 → true');
    await expect(page.getByTestId('role-labels')).toHaveText('User → Assistant');

    const markdown = await page.getByTestId('markdown-output').textContent();
    expect(markdown).toContain('id: conversation-fixture');
    expect(markdown).toContain('### User (fixture-id-1)');
    expect(markdown).toContain('### Assistant (fixture-id-2)');
    expect(markdown).toContain('Please review the release notes.');
    expect(markdown).toContain('The release notes are ready for approval.');
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });
});
