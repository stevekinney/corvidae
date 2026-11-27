/**
 * The run page (`/runs/:run`) on the sample world (`fixtures/sample-world-seed.ts`, the showcase
 * host) at the browser's sample clock, Monday, Nov 2, 10:46 AM Central time (COR-2424, design rows
 * 54a to 55m and 06d): the runs the sample world holds in each state, captured for the design review
 * on a desktop and a phone. The failed Release notes run says where it failed ("at step 2 of 4"),
 * shows its failure on the step that failed and the version it ran as older than the current one;
 * the refund run waits on the person; a goal's canceled attempt has no Run again, because the goal
 * owns rerunning; and a finished chat run holds Run again, since no provider is connected, with a link
 * to connect one beneath it.
 *
 * The runs the design names by identifier (`run-8f3c2a` and the others) are the sample world's own
 * runs, whose identifiers the Bureau assigns; they are read from the host
 * (`readSampleWorldRecords`). A state the sample world does not hold, a live run and a run waiting
 * on a signal, is covered where the page is built from a table (`run-detail-engine.test.ts`).
 */
import type { WorkflowTimelineEntry } from '@lostgradient/weft';
import type { Locator, Page } from '@playwright/test';

import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { readSampleWorldRecords } from '../../fixtures/sample-world-records.ts';
import { logLine } from '../../src/routes/workflows/runs/run-log-cases.test-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import { readBoxes } from './read-boxes.ts';
import { openHowItRan, openTab } from './workflow-support.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'run-page-states.spec.ts';
const WIDTHS = [1280, 375] as const;

/** Opens `path` at `width` and waits until the run's header says its status. */
async function openRun(page: Page, path: string, width: number): Promise<void> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
  await expect(page.locator('[data-run-header] [data-status-word]')).toBeVisible();
}

/** Keep the named content in the frame after each capture viewport change. */
async function reveal(target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  await target.scrollIntoViewIfNeeded();
  await expect(target).toBeInViewport();
}

test('/runs/:run desktop content width keeps the failed alert and Details together', async ({
  page,
}) => {
  const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
  await openRun(page, `/runs/${encodeURIComponent(world.runs.failed)}`, 1920);
  const layout = page.locator('.ib-run__layout');
  await expect(page.locator('.ib-run[data-failed-run] > .ib-run__layout')).toHaveCount(1);
  const alert = page.getByTestId('run-step-failure');
  const rail = page.getByRole('complementary', { name: 'Details' });
  await expect(alert.locator('[data-explanation="summary"]')).toBeVisible();
  const { layoutBox, alertBox, railBox } = await readBoxes(page, {
    layoutBox: layout,
    alertBox: alert,
    railBox: rail,
  });
  const contentWidth = await layout.evaluate((element) =>
    parseFloat(getComputedStyle(element).maxInlineSize),
  );
  expect(layoutBox.width).toBeLessThanOrEqual(contentWidth + 1);
  expect(alertBox.x + alertBox.width).toBeLessThanOrEqual(railBox.x);
  expect(railBox.width).toBeCloseTo(320, 0);
  expect(railBox.x + railBox.width).toBeLessThanOrEqual(layoutBox.x + layoutBox.width + 1);
  const header = page.locator('[data-run-header]');
  const { headerBox } = await readBoxes(page, { headerBox: header });
  expect(headerBox.width).toBeLessThanOrEqual(contentWidth + 1);
  expect(headerBox.x + headerBox.width).toBeLessThanOrEqual(layoutBox.x + layoutBox.width + 1);
  const disclosure = alert.getByRole('button', { name: 'Show the error details' });
  await disclosure.click();
  await expect(alert.locator('[data-explanation="stack"]')).toBeVisible();
});

test('/runs/:run desktop content width preserves completed runs', async ({ page }) => {
  const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
  await openRun(page, `/runs/${encodeURIComponent(world.runs.done)}`, 1920);
  const layout = page.locator('.ib-run:not([data-failed-run]) > .ib-run__layout');
  const main = layout.locator('.ib-run__main');
  const rail = page.getByRole('complementary', { name: 'Details' });
  await expect(layout).toHaveCount(1);
  expect(await layout.evaluate((element) => getComputedStyle(element).maxInlineSize)).toBe('none');
  const { mainBox, railBox } = await readBoxes(page, { mainBox: main, railBox: rail });
  expect(mainBox.x + mainBox.width).toBeLessThanOrEqual(railBox.x);
  expect(railBox.width).toBeCloseTo(320, 0);
});

for (const width of WIDTHS) {
  test(`/runs/:run COR-2762 Run again destination at ${String(width)} pixels`, async ({ page }) => {
    const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
    await openRun(page, `/runs/${encodeURIComponent(world.runs.failed)}`, width);
    const again = page.locator('[data-run-header]').getByRole('link', { name: 'Run again' });
    await expect(again).toHaveAttribute('href', /\/workflows\/.*\/run/);
    await again.click();
    await expect(page).toHaveURL(/\/workflows\/.*\/run/);
    await expect(page.getByRole('heading', { level: 1, name: 'Run Release notes' })).toBeVisible();
    await expect(page.getByLabel(/^Branch/)).toBeVisible();
    await expect(page.getByLabel(/^Since/)).toBeVisible();
    await captureForDesignReview(page, {
      route: '/runs/:run',
      state: 'COR-2762 run again destination',
      source: SOURCE,
      ready: async () => {
        await expect(
          page.getByRole('heading', { level: 1, name: 'Run Release notes' }),
        ).toBeVisible();
        await expect(page.getByLabel(/^Branch/)).toBeVisible();
        await expect(page.getByLabel(/^Since/)).toBeVisible();
        await reveal(page.getByLabel(/^Branch/));
      },
    });
  });

  test(`/runs/:run COR-2762 failed run open controls at ${String(width)} pixels`, async ({
    page,
  }) => {
    const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
    await openRun(page, `/runs/${encodeURIComponent(world.runs.failed)}`, width);
    const alert = page.getByTestId('run-step-failure');
    const header = page.locator('[data-run-header]');
    await expect(alert.locator('[data-explanation="summary"]')).toBeVisible();
    await expect(header.getByRole('button', { name: 'Retry from this step' })).toHaveCount(1);
    await expect(header.getByRole('link', { name: 'Run again' })).toHaveCount(1);
    await expect(header.locator('[data-run-beside]')).toContainText('Retry from this step runs on');
    await expect(header.locator('[data-run-beside]')).toContainText('Run again runs on');
    await expect(alert.getByRole('button', { name: /Retry from step/ })).toHaveCount(0);
    await expect(alert.getByRole('link', { name: 'Run again' })).toHaveCount(0);
    const details = alert.getByRole('button', { name: 'Show the error details' });
    await details.focus();
    await details.press('Enter');
    await expect(alert.locator('[data-explanation="stack"]')).toBeVisible();
    await expect(alert.locator('[data-explanation="stack"]')).not.toContainText('/Users/');
    await expect(alert.locator('[data-explanation="stack"]')).not.toContainText('file:///');
    expect(await alert.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await captureForDesignReview(page, {
      route: '/runs/:run',
      state: 'COR-2762 open error details',
      source: SOURCE,
      ready: async () => {
        await expect(details).toHaveAttribute('aria-expanded', 'true');
        await reveal(alert.locator('[data-explanation="stack"]'));
      },
    });
    await details.click();
    await expect(alert.locator('[data-explanation="stack"]')).not.toBeVisible();

    const payload = page.locator('[data-section="input-output"]');
    await expect(payload).toContainText('No output. The run failed');
    await expect(payload).toContainText('Branch');
    const fields = payload.getByRole('radio', { name: 'Fields' }).first();
    await expect(fields).toHaveAttribute('aria-checked', 'true');
    await captureForDesignReview(page, {
      route: '/runs/:run',
      state: 'COR-2762 input output fields',
      source: SOURCE,
      ready: async () => {
        await expect(fields).toHaveAttribute('aria-checked', 'true');
        await reveal(fields);
        await expect(payload).toContainText(/branch/i);
      },
    });
    await fields.focus();
    await fields.press('ArrowRight');
    await expect(payload.getByRole('radio', { name: 'JSON' }).first()).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await captureForDesignReview(page, {
      route: '/runs/:run',
      state: 'COR-2762 input output JSON',
      source: SOURCE,
      ready: async () => {
        const json = payload.getByRole('radio', { name: 'JSON' }).first();
        await expect(json).toHaveAttribute('aria-checked', 'true');
        const input = payload.getByRole('treeitem', { name: /^input: object,/ });
        await expect(input).toBeVisible();
        if ((await input.getAttribute('aria-expanded')) !== 'true') {
          await input.getByRole('button', { name: /^input: object,/ }).click();
        }
        await expect(input).toHaveAttribute('aria-expanded', 'true');
        await reveal(input.getByRole('treeitem', { name: /^branch:/i }));
      },
    });

    const rail = page.getByRole('complementary', { name: 'Details' });
    const addTag = rail.getByRole('button', { name: 'Add a tag' });
    await addTag.click();
    const tagInput = rail.getByRole('textbox', { name: 'Tags' });
    await tagInput.focus();
    await expect(tagInput).toBeFocused();
    await captureForDesignReview(page, {
      route: '/runs/:run',
      state: 'COR-2762 add tag focused',
      source: SOURCE,
      ready: async () => {
        await reveal(tagInput);
        await tagInput.focus();
        await expect(tagInput).toBeFocused();
      },
    });
    await tagInput.press('Escape');
    await expect(addTag).toBeFocused();

    const how = await openHowItRan(page);
    await captureForDesignReview(page, {
      route: '/runs/:run',
      state: 'COR-2762 how it ran',
      source: SOURCE,
      ready: async () => {
        await expect(how.getByRole('button', { name: /^How it ran/ }).first()).toHaveAttribute(
          'aria-expanded',
          'true',
        );
        await reveal(how.locator('[data-step-row]').first());
      },
    });
    await how.locator('[data-step-row]').first().click();
    await expect(how.locator('article[data-step]')).toBeVisible();
    await expect(how.locator('article[data-step] [aria-label="Input"]')).not.toContainText(
      world.runs.failed,
    );
    await captureForDesignReview(page, {
      route: '/runs/:run',
      state: 'COR-2762 selected step',
      source: SOURCE,
      ready: () => reveal(how.locator('article[data-step]')),
    });
    await rail.locator('[data-section="logs"]').getByRole('button', { name: /^Logs/ }).click();
    await captureForDesignReview(page, {
      route: '/runs/:run',
      state: 'COR-2762 logs open',
      source: SOURCE,
      ready: async () => {
        const logs = rail.locator('[data-section="logs"]');
        await expect(logs.getByRole('button', { name: /^Logs/ })).toHaveAttribute(
          'aria-expanded',
          'true',
        );
        await reveal(logs);
      },
    });
    await header.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Copy run ID' })).toBeVisible();
    await captureForDesignReview(page, {
      route: '/runs/:run',
      state: 'COR-2762 more actions open',
      source: SOURCE,
      ready: async () => {
        const trigger = header.getByRole('button', { name: 'More actions' });
        if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
        await reveal(page.getByRole('menu'));
      },
    });
  });
}

const FAILED_STEP_VIEWS = [
  ['Input', 'Fields'],
  ['Input', 'JSON'],
  ['Error', 'Fields'],
  ['Error', 'JSON'],
] as const;

async function tapDisclosureEdge(page: Page, disclosure: Locator): Promise<void> {
  await disclosure.scrollIntoViewIfNeeded();
  const point = await disclosure.evaluate((button) => {
    const { left, top, width, height } = button.getBoundingClientRect();
    const x = left + width / 2;
    const y = top + height / 2 + 21;
    return { x, y, owned: button.contains(document.elementFromPoint(x, y)) };
  });
  expect(point.owned).toBe(true);
  await page.touchscreen.tap(point.x, point.y);
}

for (const width of [1280, 1920, 375, 320] as const) {
  const phone = width < 400;
  test.describe(`/runs/:run step inspector at ${width}px`, () => {
    test.use({ hasTouch: phone });
    test(`failed-run inspector keeps selected-step payloads readable at ${width}px`, async ({
      page,
      request,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      const runId = encodeURIComponent(world.runs.failed);
      const workflowPath = `/v1/workflows/${runId}`;
      const timeline = await request.get(`${E2E_SHOWCASE_URL}${workflowPath}/timeline`);
      expect(timeline.ok()).toBe(true);
      const entries = (await timeline.json()) as WorkflowTimelineEntry[];
      const failed = entries.find((entry) => entry.status === 'failed');
      if (failed?.stepIndex === undefined) throw new Error('The failed step has no log index');
      const stepIndex = failed.stepIndex;
      const message = 'Finished reading the merged pull requests';
      type WorkflowCall = {
        readonly id?: string | number;
        readonly method?: string;
        readonly params?: { readonly workflowId?: string };
      };
      const calls: string[] = [];
      await page.route('**/jsonrpc', async (route) => {
        const call = route.request().postDataJSON() as WorkflowCall | null;
        if (call?.params?.workflowId !== world.runs.failed || call.method === undefined) {
          await route.fallback();
          return;
        }
        calls.push(call.method);
        if (call.method !== 'weft.workflows.logs.list') {
          await route.fallback();
          return;
        }
        await route.fulfill({
          json: {
            jsonrpc: '2.0',
            id: call.id,
            result: { lines: [logLine(0, stepIndex, message)], dropped: 0 },
          },
        });
      });

      await openRun(page, `/runs/${runId}`, width);
      await page.setViewportSize({
        width,
        height: width < 400 ? (width === 320 ? 640 : 812) : 900,
      });
      const how = await openHowItRan(page);
      const steps = how.getByTestId('run-steps');
      await steps.locator(`[data-step-row="${failed.step}"]`).click();
      const detail = steps.locator(`article[data-step="${failed.step}"]`);
      const fields = detail.locator('.ib-step-detail__fields');
      const input = detail.getByRole('group', { name: 'Input', exact: true });
      const error = detail.getByRole('group', { name: 'Error', exact: true });
      const log = detail.getByRole('list', { name: 'Log lines' });
      const logs = detail.getByRole('button', { name: 'Logs', exact: true });
      await expect(log).toContainText(message);
      const loadedReads = calls.length;
      expect(calls).toContain('weft.workflows.timeline.get');
      expect(calls).toContain('weft.workflows.logs.list');

      const boxes = await readBoxes(page, { fields, input, error });
      for (const payload of [boxes.input, boxes.error]) {
        expect(Math.abs(payload.x - boxes.fields.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(payload.width - boxes.fields.width)).toBeLessThanOrEqual(1);
      }

      if (phone) {
        expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);
        const nested = input.getByRole('button', { name: 'Input, 2 fields', exact: true });
        const expanded = await nested.getAttribute('aria-expanded');
        await tapDisclosureEdge(page, nested);
        await expect(nested).toHaveAttribute(
          'aria-expanded',
          expanded === 'true' ? 'false' : 'true',
        );
        await tapDisclosureEdge(page, nested);
        await expect(nested).toHaveAttribute('aria-expanded', expanded ?? '');

        const showAll = error.getByRole('button', { name: 'Show all', exact: true });
        await tapDisclosureEdge(page, showAll);
        const showLess = error.getByRole('button', { name: 'Show less', exact: true });
        await expect(showLess).toHaveAttribute('aria-expanded', 'true');
        await showLess.tap();
        await expect(showAll).toHaveAttribute('aria-expanded', 'false');
      }

      for (const [label, view] of FAILED_STEP_VIEWS) {
        const payload = detail.getByRole('group', { name: label, exact: true });
        const option = payload.getByRole('radio', { name: view, exact: true });
        await option.click();
        await expect(option).toBeChecked();
        if (label === 'Input' && view === 'JSON') {
          await payload.getByRole('button', { name: /^input: object/ }).click();
          await payload.getByRole('button', { name: /^trigger: object/ }).click();
        }
        await expect(payload).toContainText(
          label === 'Input' ? 'assistant' : 'GitHub didn’t answer',
        );
        if (label === 'Input') await expect(payload).toContainText('[REDACTED]');
        if (label === 'Error' && view === 'JSON') {
          await expect(payload.locator('.cinder-json-viewer__value')).toHaveText(
            failed.outputSummary ?? '',
            { useInnerText: true },
          );
          const sideways = await payload
            .getByRole('tree')
            .evaluate((element) => element.scrollWidth - element.clientWidth);
          expect(sideways).toBeLessThanOrEqual(0);
        }
        if (label === 'Input' && view === 'Fields' && width >= 1280) {
          const value = payload.getByText('assistant', { exact: true });
          await expect(value).toBeVisible();
          const lineCount = await value.evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return range.getClientRects().length;
          });
          expect(lineCount).toBe(1);
        }

        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width,
        );
        if (width === 1280 || width === 375) {
          await captureForDesignReview(page, {
            route: '/runs/:run',
            state: `selected failed step ${label} ${view}`,
            source: SOURCE,
            ready: async () => {
              await expect(option).toBeChecked();
              await option.scrollIntoViewIfNeeded();
            },
          });
        }
      }

      await logs.click();
      await expect(logs).toHaveAttribute('aria-expanded', 'false');
      await expect(log).toBeHidden();
      await logs.click();
      await expect(logs).toHaveAttribute('aria-expanded', 'true');
      await expect(log).toContainText(message);
      await error.getByRole('radio', { name: 'Fields', exact: true }).click();
      await expect(error.getByRole('radio', { name: 'Fields', exact: true })).toBeChecked();
      expect(calls.slice(loadedReads)).toEqual([]);
    });
  });
}

for (const width of WIDTHS) {
  // The route leads the title, so a design review's route filter (`--grep '/runs/:run'`) runs these.
  test.describe(`/runs/:run at ${String(width)} pixels`, () => {
    test('a failed instance says where it failed, shows the failure on its step, and the older version it ran (54y, 14t, 55b, 55d)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await openRun(page, `/runs/${encodeURIComponent(world.runs.failed)}`, width);

      const header = page.locator('[data-run-header]');
      await expect(header).toContainText(/Failed\s*, at step 2 of 4/);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Release notes');
      // The failure is told once, on the step, and no banner repeats it.
      // The step is named by its title on the version the run ran (14t), never by its message.
      await expect(page.getByTestId('run-step-failure')).toContainText(
        'Step 2, Collect merged changes, failed',
      );
      // Why it failed is the Bureau's explanation (COR-2533): its sentence leads, and what to do
      // next follows. The page words neither.
      await expect(
        page.getByTestId('run-step-failure').locator('[data-explanation="summary"]'),
      ).toContainText('GitHub returned HTTP 503');
      await expect(page.getByTestId('run-step-failure')).toContainText('What to do next');
      // The words on which version each button runs on are the header's caption, under the
      // buttons, and the title keeps its line (54z).
      const beside = page.locator('[data-run-beside]');
      await expect(beside).toBeVisible();
      const { title, caption, retry } = await readBoxes(page, {
        title: page.getByRole('heading', { level: 1 }),
        caption: beside,
        retry: page.getByRole('button', { name: 'Retry from this step' }),
      });
      expect(caption.y).toBeGreaterThanOrEqual(retry.y + retry.height - 1);
      expect(caption.y).toBeGreaterThan(title.y);
      await expect(page.locator('.weft-overview-tab__failure')).toHaveCount(1);
      await expect(page.locator('[data-version-state="older"]')).toBeVisible();
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'failed instance',
        source: SOURCE,
        ready: async () => {
          await expect(page.locator('.ib-run__layout')).toHaveCount(1);
          await expect(page.locator('.ib-run[data-failed-run] > .ib-run__layout')).toHaveCount(1);
        },
      });
    });

    test('a run waiting on the person leads with what the person can do (06d)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await openRun(page, `/runs/${encodeURIComponent(world.runs.waiting)}`, width);

      await expect(page.locator('[data-run-header]')).toContainText('Waiting on you');
      await expect(page.locator('[data-section]').first()).toHaveAttribute(
        'data-section',
        'waiting',
      );
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'waiting on you',
        source: SOURCE,
      });
    });

    test('a finished chat run offers Open chat and Run again, and the Run inspector says nothing is left to do (54e, 54i)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await openRun(page, `/runs/${encodeURIComponent(world.runs.done)}`, width);

      await expect(page.locator('[data-run-header]')).toContainText('Done');
      await expect(page.getByRole('link', { name: 'Open chat' })).toBeVisible();
      // The sample world has no provider connected and Tool runner needs a model, so Run again is
      // held, with the link to Settings › Models beneath it that says why (54f).
      const again = page.getByRole('button', { name: 'Run again' });
      await expect(again).toHaveAttribute('aria-disabled', 'true');
      const connect = page.getByRole('link', { name: 'Connect a provider' });
      await expect(connect).toHaveAttribute('href', '/settings/models');
      await expect(again).toHaveAttribute(
        'aria-describedby',
        (await connect.getAttribute('id')) ?? '',
      );
      // The page as it opens: How it ran closed (54a, 54e), the rail's facts (54j).
      await expect(page.getByRole('button', { name: /^How it ran/ })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'finished chat run',
        source: SOURCE,
      });
      const howItRan = await openHowItRan(page);
      // The Run inspector card is on How it ran's Inspector tab (row 54i), which a phone chooses
      // from the select the tab bar folds into.
      await openTab(howItRan, 'Inspector');
      await expect(page.locator('[data-section="run-inspector"]')).toContainText(
        'Finished; nothing left to do',
      );
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'finished chat run inspector',
        source: SOURCE,
      });
      // A Bureau run's Raw payloads (28e): its input and output cards, internals in JSON only.
      await openTab(howItRan, 'Raw payloads');
      await expect(page.locator('[data-section="raw-payloads"]')).toBeVisible();
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'raw payloads',
        source: SOURCE,
      });
    });

    test('a schedule’s run says its schedule and when it runs, offers Open schedule and Run again, and has no Tags row (55i, 55j, 55m)', async ({
      page,
      request,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      const listed = await request.post(`${E2E_SHOWCASE_URL}/bureau/jsonrpc`, {
        data: {
          jsonrpc: '2.0',
          id: 'tasks',
          method: 'bureau.tasks.list',
          params: { origin: 'schedule', limit: 100 },
        },
      });
      const { result } = (await listed.json()) as {
        result: { tasks: Array<{ id: string; origin?: { scheduleId?: string } }> };
      };
      const fire = result.tasks.find(
        (task) => task.origin?.scheduleId === world.schedules.dailySummary,
      );
      expect(fire, 'the sample world holds a Daily summary run').toBeDefined();
      await openRun(page, `/runs/${encodeURIComponent(fire!.id)}`, width);

      await expect(page.getByRole('link', { name: 'Open schedule' })).toBeVisible();
      const lineage = page.getByTestId('run-lineage');
      await expect(lineage).toContainText('Daily summary');
      await expect(lineage).toContainText('every day at');
      const rail = page.getByRole('complementary', { name: 'Details' });
      await expect(rail.getByText('Tags', { exact: true })).toHaveCount(0);
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'schedule run',
        source: SOURCE,
      });
    });

    test('a goal’s canceled attempt has Open goal and no Run again, since the goal owns rerunning (55f)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await openRun(page, `/runs/${encodeURIComponent(world.runs.canceled)}`, width);

      await expect(page.getByRole('link', { name: 'Open goal' })).toBeVisible();
      // The header has Open goal and the menu only (55f); the attempt's session, which no Chats
      // list holds, is opened from the Details rail's Session row.
      const header = page.locator('[data-run-header]');
      await expect(header.getByRole('link', { name: 'Open the session' })).toHaveCount(0);
      const rail = page.getByRole('complementary', { name: 'Details' });
      await expect(rail.getByRole('link', { name: 'Open the session' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Run again' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Run again' })).toHaveCount(0);
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'canceled goal attempt',
        source: SOURCE,
      });
    });
  });
}
