/**
 * What the application does when the server stops answering and when it comes back: the banner, the
 * data kept and dimmed, the controls that change something turned off, the full page for a view
 * with nothing to keep, and a chat that gives up reconnecting after eight tries and offers
 * Reconnect (COR-1839).
 *
 * The e2e host is shared by every spec, so none of them stops it. A stopped host is the page's own
 * network: `setOffline` for the browser's offline event, and an aborted route for requests that
 * simply get no answer. Bringing the host back is removing either. The failures the outage causes
 * are the test's own doing, so each case counts them as it goes and declares exactly that many.
 */
import type { Page } from '@playwright/test';

import { CHAT_COPY, CONNECTION_COPY, WORKFLOW_COPY } from '../../src/app/copy.ts';
import { newThreadId, runToEnd } from './chat-support.ts';
import { expect, test, type PageErrorLog } from './fixtures.ts';
import { TEXT_ECHO_AGENT_NAME } from './text-echo-agent.ts';

/** Counts the console errors and failed requests an outage makes the page report. */
function watchOutage(page: Page, errorText: string) {
  const outage = { requests: 0, consoles: 0 };
  page.on('requestfailed', (request) => {
    if (request.failure()?.errorText === errorText) outage.requests += 1;
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes(errorText)) outage.consoles += 1;
  });
  return outage;
}

/** Declares the reports an outage caused, once it is over and the page has settled. */
function declareOutage(
  pageErrors: PageErrorLog,
  outage: ReturnType<typeof watchOutage>,
  errorText: string,
): void {
  const reason = 'the test took the page’s network away on purpose';
  if (outage.requests > 0) {
    pageErrors.expect({
      pattern: new RegExp(`^request failed: .* \\(${errorText}\\)$`),
      reason,
      count: outage.requests,
    });
  }
  if (outage.consoles > 0) {
    pageErrors.expect({
      pattern: new RegExp(`^console error: .*${errorText}`),
      reason,
      count: outage.consoles,
    });
  }
}

const banner = (page: Page) => page.getByRole('region', { name: 'Connection problem' });

test.describe('the server stops answering while a page with data is open', () => {
  test('keeps the data, dimmed with its age, shows the banner, and clears when the network returns', async ({
    page,
    context,
    pageErrors,
  }) => {
    const outage = watchOutage(page, 'net::ERR_INTERNET_DISCONNECTED');
    await page.goto('/agents');
    const frame = page.locator('[data-view="agents"]');
    await expect(frame).toHaveAttribute('data-state', 'ready');
    const row = page.locator('[data-agent="assistant"]');
    // What the frame dims is the page it frames: its direct children.
    const content = frame.locator(':scope > *').first();
    await expect(row).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    await expect(frame).not.toHaveAttribute('data-stale', 'true');

    await context.setOffline(true);

    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toContainText(CONNECTION_COPY.banner);
    await expect(banner(page)).toContainText('Showing data from');
    await expect(frame).toHaveAttribute('data-stale', 'true');
    await expect(frame).toHaveAttribute('data-stale-since', /^\d{4}-\d{2}-\d{2}T/);
    await expect(frame).toHaveAttribute('data-state', 'ready');
    // The last data is still on screen, and dimmed.
    await expect(row).toBeVisible();
    await expect(content).toHaveCSS('opacity', '0.6');

    await context.setOffline(false);

    await expect(banner(page)).toHaveCount(0);
    await expect(frame).not.toHaveAttribute('data-stale', 'true');
    await expect(content).toHaveCSS('opacity', '1');
    await expect(row).toBeVisible();

    declareOutage(pageErrors, outage, 'net::ERR_INTERNET_DISCONNECTED');
  });

  test('turns off the controls that change something, and turns them on again', async ({
    page,
    context,
    pageErrors,
  }) => {
    const outage = watchOutage(page, 'net::ERR_INTERNET_DISCONNECTED');
    await page.goto('/workflows/new');
    const save = page.getByRole('button', { name: WORKFLOW_COPY.creator.saveAction });
    await expect(save).toBeEnabled();

    await context.setOffline(true);

    await expect(banner(page)).toBeVisible();
    await expect(save).toBeDisabled();
    await expect(save).toHaveAttribute('title', CONNECTION_COPY.changesOff);
    // What reads or moves is not turned off.
    await expect(page.getByRole('button', { name: 'Retry' })).toBeEnabled();
    await expect(page.getByRole('link', { name: 'Agents' }).first()).toBeVisible();

    await context.setOffline(false);

    await expect(banner(page)).toHaveCount(0);
    await expect(save).toBeEnabled();
    await expect(save).not.toHaveAttribute('title', CONNECTION_COPY.changesOff);

    declareOutage(pageErrors, outage, 'net::ERR_INTERNET_DISCONNECTED');
  });
});

test.describe('requests that get no answer from the host', () => {
  test('replace a view with nothing to keep by the unreachable page, and Retry brings it back', async ({
    page,
    pageErrors,
  }) => {
    const outage = watchOutage(page, 'net::ERR_CONNECTION_REFUSED');
    await page.goto('/chats/new');
    await expect(page.locator('[data-view="chat"]')).toBeVisible();

    // The host stops: every request to it is refused, the page's code still loads.
    await page.route(/\/(v1|bureau|api)\//, (route) => route.abort('connectionrefused'));
    await page.getByRole('link', { name: 'Schedules' }).first().click();

    const frame = page.locator('[data-view="schedules"]');
    await expect(frame).toHaveAttribute('data-state', 'unreachable');
    await expect(
      frame.getByRole('heading', { level: 1, name: CONNECTION_COPY.page.title }),
    ).toBeVisible();
    await expect(banner(page)).toBeVisible();

    // The host is back.
    await page.unroute(/\/(v1|bureau|api)\//);
    await frame.getByRole('button', { name: 'Try again' }).click();

    await expect(frame).toHaveAttribute('data-state', /^(ready|empty)$/);
    await expect(banner(page)).toHaveCount(0);

    declareOutage(pageErrors, outage, 'net::ERR_CONNECTION_REFUSED');
  });
});

test.describe('a chat that cannot reach its thread', () => {
  test('gives up after eight tries, says so, and Reconnect reads the thread again', async ({
    page,
    request,
    pageErrors,
  }) => {
    const outage = watchOutage(page, 'net::ERR_CONNECTION_REFUSED');
    const threadId = newThreadId('reconnect');
    await runToEnd(request, TEXT_ECHO_AGENT_NAME, threadId, 'Say this again after the outage');

    // The retries wait up to ten seconds each; the page's clock runs them in moments.
    await page.clock.install();
    let attempts = 0;
    let hostIsDown = true;
    await page.route(`**/bureau/ag-ui/threads/${threadId}/run`, (route) => {
      if (!hostIsDown) return route.continue();
      attempts += 1;
      return route.abort('connectionrefused');
    });

    await page.goto(`/chats/${threadId}`);
    const reconnect = page.getByRole('button', { name: CHAT_COPY.disconnected.reconnect });

    // Seven retries follow the first try, and only after the last is the chat disconnected.
    await expect(async () => {
      await page.clock.runFor(11_000);
      await expect(reconnect).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 60_000 });
    expect(attempts).toBe(8);
    await expect(page.getByText(CHAT_COPY.disconnected.title, { exact: true })).toBeVisible();

    // A Reconnect while the host is still down fails, stays disconnected, and tries once.
    await reconnect.click();
    await expect.poll(() => attempts).toBe(9);
    await expect(reconnect).toBeVisible();
    await page.clock.runFor(60_000);
    expect(attempts).toBe(9);

    // The host is back.
    hostIsDown = false;
    await reconnect.click();
    await expect(reconnect).toHaveCount(0);
    await expect(page.getByText('Say this again after the outage').first()).toBeVisible();

    declareOutage(pageErrors, outage, 'net::ERR_CONNECTION_REFUSED');
  });
});
