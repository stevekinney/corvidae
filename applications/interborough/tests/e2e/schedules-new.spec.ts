/**
 * The page that makes a schedule, at `/schedules/new` (COR-2018, rows 74a–75o, 06i–06k), on the
 * sample world: the initial form, the picker, Chat with an agent and the model agent that waits for
 * a provider, a workflow with input, a cron field out of range, a name another schedule has, the
 * reads that are slow or failed, and leaving after typing. Nothing here makes a schedule, because
 * the showcase host's four schedules are the world every other specification reads; creating is
 * proved against the application's own host (`03-create-backfill-schedule.spec.ts`,
 * `28-schedule-owners.spec.ts`) and with fake timers in `new-schedule.test.ts`.
 *
 * The slow reads are held by answering the engine's catalog differently, which is also what the
 * page waits on; the ten-second statuses are proved in the unit test, not slept here.
 */
import type { Page } from '@playwright/test';

import { SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'schedules-new.spec.ts';
const WIDTHS = [1280, 768, 375] as const;
const ROUTE = '/schedules/new';

const workflowField = (page: Page) => page.getByRole('combobox', { name: /^Workflow/ });
const createButton = (page: Page) => page.getByRole('button', { name: /^Create schedule$/ });
const cancelLink = (page: Page) => page.getByRole('link', { name: 'Cancel' });
const footer = (page: Page) => page.getByTestId('new-schedule-summary');

/** Opens the picker and chooses the option with this name. */
async function choose(page: Page, name: RegExp): Promise<void> {
  await workflowField(page).click();
  await page.getByRole('option', { name }).click();
}

/** The top of an element, in pixels, so two fields can be told to share a row or to stack. */
async function topOf(page: Page, label: RegExp): Promise<number> {
  const box = await page.getByLabel(label).first().boundingBox();
  return Math.round(box?.y ?? -1);
}

for (const width of WIDTHS) {
  test(`opens at the initial form, in one column, with Create enabled and the footer saying to pick, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(ROUTE);
    const main = page.locator('main');

    await expect(main.getByRole('heading', { level: 1, name: 'New schedule' })).toBeVisible();
    await expect(main).toContainText(
      'Pick what runs, then when, then name it. Next runs show in Central time before you save.',
    );
    await expect(main.getByRole('heading', { level: 2 })).toHaveText(['What runs', 'When']);
    // Section headings are sentence case and not uppercase labels.
    await expect(main.getByRole('heading', { level: 2, name: 'What runs' })).toHaveCSS(
      'text-transform',
      'none',
    );
    await expect(workflowField(page)).toContainText('Pick a workflow');
    await expect(main.getByLabel(/^Name/)).toHaveAttribute(
      'placeholder',
      'For example, Daily summary',
    );
    await expect(footer(page)).toHaveText('Pick a workflow to see what it will start.');
    await expect(createButton(page)).toBeEnabled();
    // The required dot stands in for the word.
    await expect(main).not.toContainText(/\brequired\b/i);

    // One reading column, at most 720px wide.
    const column = await main.locator('[data-page="schedule-new"]').boundingBox();
    expect(Math.round(column?.width ?? 0)).toBeLessThanOrEqual(720);

    const repeats = await topOf(page, /^Repeats/);
    const at = await topOf(page, /^At/);
    const overlap = await topOf(page, /^If a run is still going/);
    const catchUp = await topOf(page, /^If Interborough was off/);
    if (width >= 768) {
      // Repeats and At share a row, and so do the two policy selects.
      expect(at).toBe(repeats);
      expect(catchUp).toBe(overlap);
      const buttons = await Promise.all([
        cancelLink(page).boundingBox(),
        createButton(page).boundingBox(),
      ]);
      // Cancel first, Create schedule last, on one row.
      expect(buttons[0]?.x ?? 0).toBeLessThan(buttons[1]?.x ?? 0);
      expect(Math.round(buttons[0]?.y ?? 0)).toBe(Math.round(buttons[1]?.y ?? 1));
    } else {
      expect(at).toBeGreaterThan(repeats);
      expect(catchUp).toBeGreaterThan(overlap);
      // Create schedule is above Cancel, and each is the width of the column.
      const create = await createButton(page).boundingBox();
      const cancel = await cancelLink(page).boundingBox();
      expect(create?.y ?? 0).toBeLessThan(cancel?.y ?? 0);
      expect(Math.round(create?.width ?? 0)).toBeGreaterThan(300);
    }

    await captureForDesignReview(page, { route: ROUTE, state: 'initial', source: SOURCE });
    await checkA11y(`new schedule initial at ${width}px`);
  });
}

for (const width of [1280, 375] as const) {
  test(`opens the picker with Built in, Recent and All workflows, each with its description and the Create one footer, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(ROUTE);
    await workflowField(page).click();

    const panel = page.locator('.cinder-combobox__panel');
    await expect(panel.getByPlaceholder('Search workflows')).toBeVisible();
    await expect(panel.getByRole('option', { name: /Chat with an agent/ })).toContainText(
      'Send a message to an agent each time it runs.',
    );
    await expect(panel).toContainText('Built in');
    await expect(panel).toContainText('All workflows');
    await expect(panel).toContainText('No match? Create one');
    await expect(panel.getByRole('link', { name: 'Create one' })).toBeVisible();

    await captureForDesignReview(page, { route: ROUTE, state: 'picker open', source: SOURCE });
    await checkA11y(`new schedule picker open at ${width}px`);

    await panel.getByPlaceholder('Search workflows').fill('refnud');
    await expect(panel).toContainText('No workflows match “refnud”.');
    await expect(panel.getByRole('link', { name: 'Create one' })).toBeVisible();
    await captureForDesignReview(page, { route: ROUTE, state: 'picker no match', source: SOURCE });
  });
}

for (const width of WIDTHS) {
  test(`Chat with an agent asks for the agent, the message and Continue one chat, and names the agent in the footer, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(ROUTE);
    const main = page.locator('main');
    await choose(page, /Chat with an agent/);

    // The closed field shows the name and its description on two lines.
    await expect(workflowField(page)).toContainText('Chat with an agent');
    await expect(workflowField(page)).toContainText(
      'Send a message to an agent each time it runs.',
    );
    await expect(main.getByRole('heading', { level: 2 })).toHaveText([
      'What runs',
      'Input',
      'When',
    ]);
    await expect(main).toContainText('What Chat with an agent needs each time it runs.');
    await expect(main.getByLabel(/^Agent/)).toHaveValue(/assistant$/);
    await expect(main.getByText('Sent as the first message of each run.')).toBeVisible();
    await expect(main.getByRole('switch', { name: 'Continue one chat' })).not.toBeChecked();
    // Assistant is scripted, so there is no provider notice.
    await expect(main).not.toContainText('Won’t run until a provider is connected');
    await expect(main.getByLabel(/^Name/)).toHaveValue('Assistant');
    await expect(footer(page)).toHaveText('Creates a schedule that starts a chat with Assistant.');

    await main.getByLabel(/^Message/).fill('Summarize yesterday’s chats and open reviews.');
    await main.getByLabel(/^Name/).fill('Daily summary');
    await captureForDesignReview(page, { route: ROUTE, state: 'chat', source: SOURCE });
    await checkA11y(`new schedule chat at ${width}px`);
  });
}

test('a model agent with no provider connected says it will not run, with a link that fixes it, in the field and the footer', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(ROUTE);
  const main = page.locator('main');
  await choose(page, /Chat with an agent/);
  await main.getByLabel(/^Message/).fill('Check the refund queue.');
  await main.getByLabel(/^Agent/).selectOption({ label: 'Tool runner' });

  const notice = main.locator('.cinder-form-field__warning');
  await expect(notice).toContainText('Won’t run until a provider is connected ·');
  await expect(notice.getByRole('link', { name: 'Connect a provider' })).toHaveAttribute(
    'href',
    '/settings/models',
  );
  // It is a line under the field, not a banner and not the blocked composer row.
  await expect(main.getByRole('alert')).toHaveCount(0);
  await expect(footer(page)).toHaveText('Won’t run until a provider is connected.');

  await captureForDesignReview(page, { route: ROUTE, state: 'no provider', source: SOURCE });
  await checkA11y('new schedule no provider');

  // A cron field out of range leaves Create enabled, and the footer says where focus will go.
  await main.getByLabel('Repeats').selectOption({ label: 'Custom cron' });
  await main.getByLabel('Day of week').fill('8');
  await main.getByLabel('Day of week').blur();
  await expect(footer(page)).toHaveText(
    'Won’t run until a provider is connected. Create schedule stays enabled; on submit, focus moves to Day of week.',
  );
  await expect(createButton(page)).toBeEnabled();
  await captureForDesignReview(page, { route: ROUTE, state: 'cron error', source: SOURCE });
  await createButton(page).click();
  await expect(main.getByLabel('Day of week')).toBeFocused();
  await expect(page).toHaveURL(/\/schedules\/new$/);
});

test('a name another schedule has is said at the field with a link to it, with no banner and the rest kept', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(ROUTE);
  const main = page.locator('main');
  await choose(page, /Chat with an agent/);
  await main.getByLabel(/^Message/).fill('Summarize yesterday’s chats and open reviews.');
  await main.getByLabel(/^Name/).fill('Daily summary');
  await createButton(page).click();

  await expect(main).toContainText('A schedule with this name already exists.');
  await expect(main.getByRole('link', { name: 'Open Daily summary' })).toHaveAttribute(
    'href',
    /\/schedules\/.+/,
  );
  await expect(main.getByLabel(/^Name/)).toBeFocused();
  await expect(main.getByLabel(/^Message/)).toHaveValue(
    'Summarize yesterday’s chats and open reviews.',
  );
  await expect(footer(page)).toHaveText('Creates a schedule that starts a chat with Assistant.');
  await expect(createButton(page)).toBeEnabled();
  await expect(main.getByTestId('new-schedule-failed')).toHaveCount(0);

  await captureForDesignReview(page, { route: ROUTE, state: 'name taken', source: SOURCE });
  await checkA11y('new schedule name taken');
});

test('leaving after typing asks first, with Keep editing focused', async ({ page, checkA11y }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(ROUTE);
  await choose(page, /Chat with an agent/);
  await cancelLink(page).click();

  const dialog = page.getByRole('dialog', { name: 'Discard this schedule?' });
  await expect(dialog).toContainText(
    'You have started a schedule. If you leave now, what you typed is lost.',
  );
  await expect(dialog.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Discard and leave' })).toHaveAttribute(
    'data-cinder-variant',
    'danger',
  );
  await captureForDesignReview(page, { route: ROUTE, state: 'discard dialog', source: SOURCE });
  await checkA11y('new schedule discard dialog');

  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page).toHaveURL(/\/schedules\/new$/);
  await cancelLink(page).click();
  await dialog.getByRole('button', { name: 'Discard and leave' }).click();
  await expect(page).toHaveURL(/\/schedules$/);
});

test('a workflow with input draws its fields from its schema under an Input section that names it', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(ROUTE);
  const main = page.locator('main');
  await choose(page, /Release notes/);

  await expect(main.getByRole('heading', { level: 2 })).toHaveText(['What runs', 'Input', 'When']);
  await expect(main).toContainText('What Release notes needs each time it runs.');
  await expect(main.getByLabel(/^Branch/)).toBeVisible();
  await expect(main.getByLabel(/^Name/)).toHaveValue('Release notes');
  await expect(footer(page)).toHaveText('Creates a schedule that starts Release notes.');
  await captureForDesignReview(page, { route: ROUTE, state: 'workflow input', source: SOURCE });
  await checkA11y('new schedule workflow input');
});

test('the workflow list is waited for in the field and the footer, with Cancel live and Create off', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/jsonrpc', async (route) => {
    if ((route.request().postData() ?? '').includes('"weft.workflows.definitions.list"'))
      await held;
    await route.fallback();
  });
  await page.goto(ROUTE);
  const main = page.locator('main');

  await expect(workflowField(page)).toContainText('Loading workflows…');
  await expect(footer(page)).toHaveText('Waiting for the workflow list');
  await expect(createButton(page)).toBeDisabled();
  await expect(cancelLink(page)).toBeEnabled();
  await main.getByLabel(/^Name/).fill('Daily summary');
  await captureForDesignReview(page, { route: ROUTE, state: 'workflows loading', source: SOURCE });
  await checkA11y('new schedule workflows loading');

  release();
  await expect(workflowField(page)).toContainText('Pick a workflow');
  await expect(createButton(page)).toBeEnabled();
});

test('a failed workflow list keeps the field a combobox, with the error in its list and Chat with an agent still there', async ({
  page,
  checkA11y,
  pageErrors,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  pageErrors.expectEvery({
    pattern: loggedFailedResponse(500, /\/jsonrpc/),
    reason: 'the test answers the engine’s workflow definitions with a 500',
  });
  await page.route('**/jsonrpc', async (route) => {
    if ((route.request().postData() ?? '').includes('"weft.workflows.definitions.list"')) {
      await route.fulfill({ status: 500, json: { error: 'The server broke.' } });
      return;
    }
    await route.fallback();
  });
  await page.goto(ROUTE);
  await expect(workflowField(page)).toContainText('Pick a workflow');
  await workflowField(page).click();

  const panel = page.locator('.cinder-combobox__panel');
  await expect(panel).toContainText('Couldn’t load workflows.');
  await expect(panel).toContainText(
    'Interborough didn’t answer. Chat with an agent is built in and still works.',
  );
  await expect(panel.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(panel.getByRole('option', { name: /Chat with an agent/ })).toBeVisible();
  await captureForDesignReview(page, { route: ROUTE, state: 'workflows failed', source: SOURCE });
  await checkA11y('new schedule workflows failed');
});

test('a workflow’s input fields are waited for with placeholders and the footer says so', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/jsonrpc', async (route) => {
    if ((route.request().postData() ?? '').includes('"weft.workflows.definitions.get"')) await held;
    await route.fallback();
  });
  await page.goto(ROUTE);
  const main = page.locator('main');
  await choose(page, /Release notes/);

  await expect(main).toContainText('What Release notes needs each time it runs.');
  await expect(main.locator('.cinder-skeleton-group[data-cinder-variant="form"]')).toBeVisible();
  await expect(footer(page)).toHaveText('Waiting for the workflow’s input fields');
  await expect(createButton(page)).toBeDisabled();
  await expect(cancelLink(page)).toBeEnabled();
  await captureForDesignReview(page, { route: ROUTE, state: 'input loading', source: SOURCE });
  await checkA11y('new schedule input loading');

  release();
  await expect(main.getByLabel(/^Branch/)).toBeVisible();
});
