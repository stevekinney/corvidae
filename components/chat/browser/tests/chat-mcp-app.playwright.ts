import { fixtureRoute } from '@lostgradient/testing/playwright/editor-fixture';
import { expect, test } from '@playwright/test';

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
    await app.getByRole('button', { name: 'Probe network' }).click();
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

  test('stops trusting an app that navigates its frame away from its document', async ({
    page,
  }) => {
    await page.goto(fixtureRoute('chat-mcp-app'), { waitUntil: 'load' });
    const app = page.frameLocator('iframe[title="Weather app"]');
    await expect(app.locator('#permissions')).toHaveText('{}');
    await expect(page.getByTestId('message-listeners')).toHaveText('1');
    await app.getByRole('button', { name: 'Navigate away' }).click();
    await expect(page.getByRole('heading', { name: 'Couldn’t open Weather app' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
    await expect(page.locator('iframe[title="Weather app"]')).toHaveCount(0);
    await expect(page.getByTestId('message-listeners')).toHaveText('0');
  });
});

test.describe('McpApp fill and open links', () => {
  test('takes its container’s height whatever the app reports, and admits only a link inside the application', async ({
    page,
  }) => {
    await page.goto(fixtureRoute('chat-mcp-app-fill'), { waitUntil: 'load' });
    const frameElement = page.locator('iframe[title="Fill app"]');
    const app = page.frameLocator('iframe[title="Fill app"]');
    await expect(app.getByRole('heading', { name: 'Fill app' })).toBeVisible();

    // The app reported 3000 pixels, and the container is 800.
    const container = await page.getByTestId('fill-container').boundingBox();
    const frame = await frameElement.boundingBox();
    expect(container?.height).toBe(800);
    expect(Math.round(frame?.height ?? 0)).toBe(800);

    await app.getByRole('button', { name: 'Open inside' }).click();
    await expect(app.locator('#answer')).toHaveText('opened');
    await expect(page.getByTestId('opened-links')).toHaveText('/runs/abc?tab=steps');

    await app.getByRole('button', { name: 'Open outside' }).click();
    await expect(app.locator('#answer')).toHaveText('refused');
    await expect(page.getByTestId('opened-links')).toHaveText('/runs/abc?tab=steps');
    await expect(page.getByTestId('refused-links')).toHaveText('1');
  });
});
