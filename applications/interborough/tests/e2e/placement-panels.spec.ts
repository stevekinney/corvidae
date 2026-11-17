/**
 * A plugin's panel on a run's page against the real host (COR-2214): the run inspector, placed
 * with `{ kind: 'run' }`, in its ready, loading and failed states. The failure and the wait are
 * Chat's `McpApp` drawing Cinder's `ErrorState` ("Couldn’t open Run inspector", "Try again") and
 * `Skeleton`. The Chat placement's three states are `workflow-revision-chat.spec.ts`: the same
 * panel component draws them, under the agent tool that places the workflow revision review.
 */
import type { APIRequestContext, Page } from '@playwright/test';

import { deleteChats, newThreadId, runToEnd } from './chat-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';
import { expectEngineMissesForRuns, taskOfSession } from './task-support.ts';

const PANEL_ROUTE = '**/host/plugins/inspectors/apps/run-inspector';

test.describe('a panel placed on a run’s page', () => {
  const threads: string[] = [];

  test.beforeEach(({ pageErrors }) => {
    expectEngineMissesForRuns(pageErrors);
  });

  test.afterEach(async () => {
    await deleteChats(threads.splice(0));
  });

  async function openRun(page: Page, request: APIRequestContext, label: string): Promise<string> {
    const threadId = newThreadId(label);
    threads.push(threadId);
    await runToEnd(request, 'demo:assistant', threadId, 'Say hello');
    const task = await taskOfSession(request, threadId);
    await page.goto(`/runs/${task.id}`);
    const trigger = page.getByRole('button', { name: 'How it ran', exact: true });
    await expect(trigger).toBeVisible();
    if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    // The panels are on How it ran's Inspector tab (COR-2424, row 54i); Steps opens first.
    await page.getByRole('tab', { name: 'Inspector' }).click();
    return task.id;
  }

  test('shows the run inspector once it has loaded', async ({ page, request }) => {
    const taskId = await openRun(page, request, 'run-panels-ready');
    const section = page.locator('[data-section="plugin-panel"][data-plugin="inspectors"]');
    await expect(section.locator('.mcp-app')).toHaveAttribute('data-state', 'ready');
    await expect(section.locator('iframe[title="Run inspector"]')).toBeVisible();
    await captureForDesignReview(page, {
      route: `/runs/${taskId}`,
      state: 'run panel ready',
      source: 'placement-panels.spec.ts',
    });
  });

  test('waits in a labelled skeleton, with no line of its own', async ({ page, request }) => {
    let releaseResource!: () => void;
    const resourceHeld = new Promise<void>((resolve) => {
      releaseResource = resolve;
    });
    await page.route(PANEL_ROUTE, async (route) => {
      await resourceHeld;
      await route.continue();
    });
    const taskId = await openRun(page, request, 'run-panels-loading');
    const section = page.locator('[data-section="plugin-panel"][data-plugin="inspectors"]');
    await expect(section.locator('.mcp-app')).toHaveAttribute('data-state', 'loading');
    await expect(section.getByRole('status')).toHaveText('Loading Run inspector');
    await expect(section.getByText('Loading app…')).toHaveCount(0);
    await captureForDesignReview(page, {
      route: `/runs/${taskId}`,
      state: 'run panel loading',
      source: 'placement-panels.spec.ts',
    });
    releaseResource();
    await expect(section.locator('iframe[title="Run inspector"]')).toBeVisible();
    await page.unroute(PANEL_ROUTE);
  });

  test('says it could not open the panel, and opens it on Try again', async ({
    page,
    request,
    pageErrors,
  }) => {
    let attempts = 0;
    await page.route(PANEL_ROUTE, (route) => {
      attempts += 1;
      return attempts === 1
        ? route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'fixture resource failure' }),
          })
        : route.continue();
    });
    pageErrors.expect({
      pattern: loggedFailedResponse(500, /run-inspector/),
      reason: 'the test returns a failed inspector resource to capture the error state',
    });
    const taskId = await openRun(page, request, 'run-panels-failed');
    const section = page.locator('[data-section="plugin-panel"][data-plugin="inspectors"]');
    await expect(section.locator('.mcp-app')).toHaveAttribute('data-state', 'error');
    await expect(
      section.getByRole('heading', { name: 'Couldn’t open Run inspector' }),
    ).toBeVisible();
    await expect(section.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await captureForDesignReview(page, {
      route: `/runs/${taskId}`,
      state: 'run panel failed',
      source: 'placement-panels.spec.ts',
    });
    await section.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(section.locator('iframe[title="Run inspector"]')).toBeVisible();
    expect(attempts).toBe(2);
    await page.unroute(PANEL_ROUTE);
  });
});
