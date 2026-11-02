/**
 * What the application does when the server stops answering and when it comes back: the banner, the
 * data kept and dimmed, the controls that change something held back, the full page for a view
 * with nothing to keep, and a chat that gives up reconnecting after eight tries and offers
 * Reconnect (COR-1839).
 *
 * The e2e host is shared by every spec, so none of them stops it. A stopped host is an aborted
 * route: every request to it simply gets no answer, and the browser fires no `offline` event, which
 * is what a host that stopped looks like to a page. Bringing the host back is removing the route,
 * and the page learns it from its own probe of `/v1/health`, which backs off one, two, four and
 * eight seconds. The failures the outage causes are the test's own doing, so each case counts them
 * as it goes and declares exactly that many.
 */
import type { Page } from '@playwright/test';

import { CHAT_COPY, CONNECTION_COPY, TASK_COPY, WORKFLOW_COPY } from '../../src/app/copy.ts';
import { expectWaiting, newThreadId, releaseBarrier, runToEnd, startRun } from './chat-support.ts';
import { expect, test, type PageErrorLog } from './fixtures.ts';
import { expectEngineMissesForRuns, taskOfSession, waitingReviewOf } from './task-support.ts';
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

const HOST_REQUESTS = /\/(v1|bureau|api)\//;
const REFUSED = 'net::ERR_CONNECTION_REFUSED';

/** The host stops: every request to it is refused, while the page's own code still loads. */
const stopHost = (page: Page) =>
  page.route(HOST_REQUESTS, (route) => route.abort('connectionrefused'));
/** The host is back. The page learns it from its probe, not from anything the test does. */
const startHost = (page: Page) => page.unroute(HOST_REQUESTS);
/**
 * The person comes back to the tab, which makes every view ask again. That is the request that finds
 * the host gone: nothing else asks while the page sits still and its open streams stay open.
 */
const refocus = (page: Page) =>
  page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));

/** The JSON-RPC operations the page sends from now on, by name. */
function recordOperations(page: Page): string[] {
  const operations: string[] = [];
  page.on('request', (outgoing) => {
    if (outgoing.method() !== 'POST' || !outgoing.url().endsWith('/jsonrpc')) return;
    const body = outgoing.postDataJSON() as { method?: string } | null;
    if (typeof body?.method === 'string') operations.push(body.method);
  });
  return operations;
}

test.describe('the server stops answering while a page with data is open', () => {
  test('keeps the data, dimmed with its age, shows the banner, and clears when the probe finds the host', async ({
    page,
    pageErrors,
  }) => {
    const outage = watchOutage(page, REFUSED);
    await page.goto('/agents');
    const frame = page.locator('[data-view="agents"]');
    await expect(frame).toHaveAttribute('data-state', 'ready');
    const row = page.locator('[data-agent="demo:assistant"]');
    // What the frame dims is the page it frames: its direct children.
    const content = frame.locator(':scope > *').first();
    await expect(row).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    await expect(frame).not.toHaveAttribute('data-stale', 'true');

    await stopHost(page);
    await refocus(page);

    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toContainText(CONNECTION_COPY.banner);
    await expect(banner(page)).toContainText('Showing data from');
    await expect(frame).toHaveAttribute('data-stale', 'true');
    await expect(frame).toHaveAttribute('data-stale-since', /^\d{4}-\d{2}-\d{2}T/);
    await expect(frame).toHaveAttribute('data-state', 'ready');
    // The last data is still on screen, and dimmed.
    await expect(row).toBeVisible();
    await expect(content).toHaveCSS('opacity', '0.6');

    await startHost(page);

    await expect(banner(page)).toHaveCount(0);
    await expect(frame).not.toHaveAttribute('data-stale', 'true');
    await expect(content).toHaveCSS('opacity', '1');
    await expect(row).toBeVisible();

    declareOutage(pageErrors, outage, REFUSED);
  });

  test('holds back the controls that change something without touching what the page decided, and gives them back', async ({
    page,
    pageErrors,
  }) => {
    const outage = watchOutage(page, REFUSED);
    await page.goto('/workflows/new');
    const save = page.getByRole('button', { name: WORKFLOW_COPY.creator.saveAction });
    await expect(save).toHaveJSProperty('disabled', false);
    await expect(save).not.toHaveAttribute('aria-disabled', 'true');

    await stopHost(page);
    await refocus(page);

    await expect(banner(page)).toBeVisible();
    await expect(save).toHaveAttribute('aria-disabled', 'true');
    await expect(save).toHaveAttribute('title', CONNECTION_COPY.changesOff);
    // Held, not disabled: the page's own state is the one it had, and the control is still focusable.
    // (Playwright reads `aria-disabled` as disabled, so the property is what says what the page set.)
    await expect(save).toHaveJSProperty('disabled', false);
    // What reads or moves is not held.
    await expect(page.getByRole('button', { name: 'Retry' })).toBeEnabled();
    await expect(page.getByRole('link', { name: 'Agents' }).first()).toBeVisible();

    await startHost(page);

    await expect(banner(page)).toHaveCount(0);
    await expect(save).not.toHaveAttribute('aria-disabled', 'true');
    await expect(save).not.toHaveAttribute('title', CONNECTION_COPY.changesOff);

    declareOutage(pageErrors, outage, REFUSED);
  });

  test('keeps Approve from deciding a review, and decides it once the host is back', async ({
    page,
    request,
    pageErrors,
  }) => {
    const outage = watchOutage(page, REFUSED);
    const threadId = newThreadId('offline-approve');
    await runToEnd(request, 'demo:tool-runner', threadId, 'Refund order-1001');
    const review = await waitingReviewOf(request, threadId);
    await page.goto(`/reviews?review=${encodeURIComponent(`bureau:${review.id}`)}`);
    const row = page.locator(`[data-review-row="bureau:${review.id}"]`);
    const pane = page.locator('.ib-review-pane');
    const approve = pane.getByRole('button', { name: 'Approve' });
    await expect(approve).toBeVisible();
    const operations = recordOperations(page);

    await stopHost(page);
    await refocus(page);

    await expect(banner(page)).toBeVisible();
    await expect(approve).toHaveAttribute('aria-disabled', 'true');
    await expect(pane.getByRole('button', { name: 'Deny' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    // Playwright refuses to click what is `aria-disabled`; a person can, and nothing is sent.
    await approve.click({ force: true });
    await expect(row).toBeVisible();
    expect(operations).not.toContain('bureau.reviews.resolve');

    await startHost(page);

    await expect(banner(page)).toHaveCount(0);
    await expect(approve).not.toHaveAttribute('aria-disabled', 'true');
    await approve.click();
    await expect(row).toHaveCount(0);
    expect(operations).toContain('bureau.reviews.resolve');

    declareOutage(pageErrors, outage, REFUSED);
  });

  test('keeps Cancel from opening its confirmation, and cancels the run once the host is back', async ({
    page,
    request,
    pageErrors,
  }) => {
    expectEngineMissesForRuns(pageErrors);
    const outage = watchOutage(page, REFUSED);
    const threadId = newThreadId('offline-cancel');
    const held = await startRun('barrier', threadId, 'Start the work');
    try {
      await expectWaiting(request, 1);
      const task = await taskOfSession(request, threadId);
      await page.goto(`/runs/${task.id}`);
      const cancel = page.getByRole('button', { name: TASK_COPY.cancelAction });
      await expect(cancel).toBeVisible();
      const operations = recordOperations(page);

      // The run's page replaces itself by its own error when its task cannot be read again, so this
      // outage leaves the run's own requests alone: everything else in the shell stops answering,
      // and the browser reporting a change of network makes the page ask.
      await page.route(HOST_REQUESTS, (route) => {
        const asked = `${route.request().url()} ${route.request().postData() ?? ''}`;
        return /tasks/.test(asked) ? route.continue() : route.abort('connectionrefused');
      });
      await page.evaluate(() => window.dispatchEvent(new Event('online')));

      await expect(banner(page)).toBeVisible();
      await expect(cancel).toHaveAttribute('aria-disabled', 'true');
      // Playwright refuses to click what is `aria-disabled`; a person can, and nothing opens.
      await cancel.click({ force: true });
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(operations).not.toContain('bureau.tasks.cancel');

      await startHost(page);

      await expect(banner(page)).toHaveCount(0);
      await expect(cancel).not.toHaveAttribute('aria-disabled', 'true');
      await cancel.click();
      await page.getByRole('dialog').getByRole('button', { name: TASK_COPY.cancelAction }).click();
      await expect(page.getByText(TASK_COPY.cancel['cleaned-up'])).toBeVisible();
      expect(operations).toContain('bureau.tasks.cancel');
    } finally {
      held.abort();
      await releaseBarrier(request);
    }

    declareOutage(pageErrors, outage, REFUSED);
  });

  test('keeps a chat message from being sent, by the button and by Enter, and sends the next one once the host is back', async ({
    page,
    pageErrors,
  }) => {
    const outage = watchOutage(page, REFUSED);
    const starts: string[] = [];
    page.on('request', (outgoing) => {
      if (outgoing.method() === 'POST' && outgoing.url().includes('/ag-ui/agents/')) {
        starts.push(outgoing.url());
      }
    });
    await page.goto(`/chats/new?agent=${TEXT_ECHO_AGENT_NAME}`);
    const composer = page.getByRole('textbox');
    await expect(composer).toBeVisible();

    await stopHost(page);
    await refocus(page);
    await expect(banner(page)).toBeVisible();

    // The composer stops while the host is down, and nothing leaves.
    await expect(composer).not.toBeEditable();
    expect(starts).toEqual([]);

    await startHost(page);

    await expect(banner(page)).toHaveCount(0);
    await expect(composer).toBeEditable();
    await composer.fill('Sent after the host is back');
    await composer.press('Enter');
    await expect(page.getByText('Sent after the host is back').first()).toBeVisible();
    expect(starts).toHaveLength(1);

    declareOutage(pageErrors, outage, REFUSED);
  });
});

test.describe('requests that get no answer from the host', () => {
  test('replace a view with nothing to keep by the unreachable page, and the banner stays when another view succeeds against the dead host', async ({
    page,
    pageErrors,
  }) => {
    const outage = watchOutage(page, REFUSED);
    await page.goto('/chats/new');
    await expect(page.locator('[data-view="chat"]')).toBeVisible();

    await stopHost(page);
    await page.getByRole('link', { name: 'Schedules' }).first().click();

    const frame = page.locator('[data-view="schedules"]');
    await expect(frame).toHaveAttribute('data-state', 'unreachable');
    await expect(
      frame.getByRole('heading', { level: 1, name: CONNECTION_COPY.page.title }),
    ).toBeVisible();
    await expect(banner(page)).toBeVisible();

    // Reviews swallows its failures, so its query succeeds against a host that is still down. That
    // answers nothing: the banner stays and the changes stay held.
    await page.getByRole('link', { name: 'Reviews' }).first().click();
    await expect(page.locator('[data-view="reviews"]')).toHaveAttribute('data-state', 'ready');
    await expect(banner(page)).toBeVisible();
    await page.getByRole('link', { name: 'Schedules' }).first().click();
    await expect(frame).toHaveAttribute('data-state', 'unreachable');

    // The host is back, and the probe finds it. Try again would only ask the view's own question.
    await startHost(page);
    await expect(banner(page)).toHaveCount(0);
    await expect(frame).toHaveAttribute('data-state', /^(ready|empty)$/);

    declareOutage(pageErrors, outage, REFUSED);
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
      // load-proof: a miss only runs the fake clock further and tries again, so a slow host adds attempts, never a failure.
      await expect(reconnect).toBeVisible({ timeout: 1_000 });
    }).toPass();
    expect(attempts).toBe(8);
    await expect(page.getByText(CHAT_COPY.disconnected.title, { exact: true })).toBeVisible();

    // The composer is disabled while disconnected, and no run POST left it.
    await expect(page.getByRole('textbox')).not.toBeEditable();
    expect(attempts).toBe(8);

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
