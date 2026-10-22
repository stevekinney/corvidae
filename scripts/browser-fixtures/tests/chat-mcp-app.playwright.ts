import { expect, test } from '@playwright/test';
import { fixtureRoute } from './editor-fixture.ts';

test.describe('McpApp host', () => {
  test('renders the app, round-trips a tool call, denies permissions and the network, and tears down', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const appRequests: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('request', (request) => {
      if (request.url().includes('example.com')) appRequests.push(request.url());
    });
    await page.goto(fixtureRoute('chat-mcp-app'), { waitUntil: 'load' });
    await expect(page.getByTestId('chat-mcp-app-proof')).toBeVisible();

    // Render: the frame is sandboxed to scripts only and loaded through srcdoc.
    const frameElement = page.locator('iframe[title="Weather app"]');
    await expect(frameElement).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(frameElement).not.toHaveAttribute('src', /.*/);
    await expect(frameElement).not.toHaveAttribute('allow', /.*/);
    const app = page.frameLocator('iframe[title="Weather app"]');
    await expect(app.getByRole('heading', { name: 'Weather app' })).toBeVisible();
    await expect(app.locator('#tool-input')).toHaveText('{"city":"Lisbon"}');

    // Denied permission: the resource asked for the camera and the host granted nothing.
    await expect(app.locator('#permissions')).toHaveText('{}');

    // No direct network path: the deny-all CSP blocks the app's own fetch.
    await expect(app.locator('#network')).toHaveText('blocked');

    // Tool-call round trip, through the host callback only.
    await app.getByRole('button', { name: 'Call get_weather' }).click();
    await expect(app.locator('#tool-result')).toHaveText('Sunny in Lisbon');
    await expect(page.getByTestId('host-tool-calls')).toHaveText('get_weather(Lisbon)');

    // Teardown: removing the app removes the frame and its message listener.
    await expect(page.getByTestId('message-listeners')).toHaveText('1');
    await page.getByTestId('remove-app').click();
    await expect(frameElement).toHaveCount(0);
    await expect(page.getByTestId('message-listeners')).toHaveText('0');

    expect(appRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
    // The only console errors are the browser's reports of the CSP blocking the app's fetch.
    const cspErrors = consoleErrors.filter((text) => text.includes('Content Security Policy'));
    expect(cspErrors.length).toBeGreaterThan(0);
    expect(consoleErrors.filter((text) => !cspErrors.includes(text))).toEqual([]);
  });
});
