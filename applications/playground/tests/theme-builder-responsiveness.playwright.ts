import { expect, test, type Page } from '@playwright/test';

import { trackConsoleProblems } from './support/theme-builder.ts';

/**
 * Cold-start responsiveness (COR-254): the first runtime evaluation after page load must not
 * hold the main thread. The runtime evaluates in a module worker; long tasks are recorded from
 * before any script runs until the draft, the preview and the checks panel are all ready.
 *
 * Measured on the in-thread evaluator before the worker (Chromium, this suite's harness):
 * longest task 234-277ms unthrottled, 996ms at 4x CPU slowdown and 1513ms at 6x. With the
 * worker: 90ms, 365ms and 570ms; what remains is the page's own script start-up.
 */
const UNTHROTTLED_LIMIT_MS = 200;
const SLOWED_LIMIT_MS = 600;
const SLOWDOWN = 4;

async function coldStart(page: Page, slowdown: number): Promise<number[]> {
  if (slowdown !== 1) {
    const client = await page.context().newCDPSession(page);
    await client.send('Emulation.setCPUThrottlingRate', { rate: slowdown });
  }
  await page.addInitScript(() => {
    const longTasks: number[] = [];
    (window as unknown as { __longTasks: number[] }).__longTasks = longTasks;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    }).observe({ type: 'longtask', buffered: true });
  });
  await page.goto('/theme-builder');
  await expect(page.getByTestId('theme-workbench')).toBeVisible();
  await expect(page.getByTestId('draft-ready')).toBeAttached({ timeout: 90_000 });
  await expect(page.getByTestId('preview-revision')).not.toContainText('updating', {
    timeout: 90_000,
  });
  await expect(page.getByTestId('checks-panel')).toHaveAttribute('data-readiness', 'ready', {
    timeout: 120_000,
  });
  return page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks);
}

function report(label: string, longTasks: number[]): number {
  const longest = Math.max(0, ...longTasks);
  test
    .info()
    .annotations.push({ type: 'longest-task', description: `${label}: ${longest.toFixed(0)}ms` });
  process.stdout.write(
    `  longest main-thread task during cold start (${label}): ${longest.toFixed(0)}ms ` +
      `(tasks: ${longTasks.map((duration) => duration.toFixed(0)).join(', ') || 'none'})\n`,
  );
  return longest;
}

test('the runtime evaluates in a pair of workers, not on the main thread', async ({ page }) => {
  const problems = trackConsoleProblems(page);
  await coldStart(page, 1);
  // One worker evaluates the draft; a second serves the checks, export and proposals.
  const workerUrl = expect.stringMatching(/\/theme-builder-bundle\/theme-runtime-worker\.js$/);
  expect(
    page.workers().map((worker) => worker.url()),
    'the evaluation workers',
  ).toEqual([workerUrl, workerUrl]);
  expect(problems).toEqual([]);
});

test('the first evaluation after load does not block the main thread', async ({ page }) => {
  const problems = trackConsoleProblems(page);
  const longest = report('unthrottled', await coldStart(page, 1));
  expect(longest, 'longest main-thread task during cold start').toBeLessThanOrEqual(
    UNTHROTTLED_LIMIT_MS,
  );
  expect(problems).toEqual([]);
});

test(`the page stays responsive at a ${SLOWDOWN}x CPU slowdown`, async ({ page }) => {
  const problems = trackConsoleProblems(page);
  const longest = report(`${SLOWDOWN}x slowdown`, await coldStart(page, SLOWDOWN));
  expect(longest, 'longest main-thread task during a slowed cold start').toBeLessThanOrEqual(
    SLOWED_LIMIT_MS,
  );
  expect(problems).toEqual([]);
});
