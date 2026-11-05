/**
 * One schedule's page on the sample world's four schedules (`fixtures/sample-world-seed.ts`, the
 * showcase host; COR-2018, the heading, its actions and the details card of `ScheduleDetail`, rows
 * 72a to 72g, 72l to 72q, 72s to 72u and 73r to 73t): the Active switch named with its visible label
 * first beside the one status word, the sentence under the heading, Edit and Run now and a menu that
 * holds Delete schedule, a schedule whose workflow is paused, Run now held off for a workflow that
 * cannot load, and the details card beside the runs at a desktop width and below them under 1024
 * pixels. Nothing here changes the world every other specification reads: Delete is only asked, and
 * the run that Run now starts is answered by the specification (the Bureau's `bureau.workflows.start`),
 * so no run is made.
 */
import type { Page, Route } from '@playwright/test';

import { SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'schedules-detail.spec.ts';
const WIDTHS = [1280, 768, 375] as const;

/** The address of a schedule's page, read from its link in the list. */
async function openSchedule(page: Page, name: string): Promise<void> {
  await page.goto('/schedules');
  await page.getByRole('link', { name }).first().click();
  await expect(page.locator('main').getByRole('heading', { level: 1, name })).toBeVisible();
}

for (const width of WIDTHS) {
  test(`Daily summary has its heading, sentence, summary line and details card, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await openSchedule(page, 'Daily summary');
    const main = page.locator('main');

    // The breadcrumb names the schedule, not its identifier.
    await expect(page.getByRole('navigation', { name: /breadcrumb/i })).toContainText('Schedules');
    await expect(page.getByRole('navigation', { name: /breadcrumb/i })).toContainText(
      'Daily summary',
    );
    // The heading row: the switch (named visible label first), a divider, one status word.
    const toggle = main.getByRole('switch', { name: 'Active, Daily summary schedule' });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(main.locator('.cinder-page-header')).toContainText('Missed runs · 4');
    // The actions: secondary Edit and Run now, and the menu.
    for (const name of ['Edit', 'Run now']) {
      await expect(main.getByRole('button', { name })).toHaveAttribute(
        'data-cinder-variant',
        'secondary',
      );
    }
    await expect(main.getByRole('button', { name: 'More actions' })).toBeVisible();
    // The sentence, and the line that says when it runs next and when it last ran.
    const sentence = main.getByTestId('schedule-status-line');
    await expect(sentence).toContainText(
      'Runs Chat with an agent with Assistant every day at 3:00 AM (9:00 AM UTC).',
    );
    await expect(sentence.getByRole('link', { name: 'Chat with an agent' })).toBeVisible();
    await expect(sentence.getByRole('link', { name: 'Assistant' })).toBeVisible();
    await expect(main.getByTestId('schedule-summary')).toHaveText(
      'Next Tue Nov 3, 3:00 AM (in 16 hours) · Last ran Oct 29, done',
    );
    await expect(main.getByRole('heading', { level: 2, name: 'Runs' })).toBeVisible();
    await expect(main.getByTestId('schedule-zone')).toHaveText(
      'Upcoming above, past below · times in Central time',
    );

    // The details card: What runs, Input (Fields and JSON, one copy button), When, Behaviour, Created.
    const card = main.getByTestId('schedule-details');
    await expect(card.getByTestId('schedule-workflow')).toContainText(
      'Chat with an agent (built in) agentRun',
    );
    await expect(card.getByTestId('schedule-agents')).toHaveText('Assistant');
    const input = card.getByTestId('schedule-input');
    await expect(input.getByRole('radio', { name: 'Fields' })).toBeChecked();
    await expect(input.getByRole('button', { name: 'Copy input' })).toBeVisible();
    await expect(input).toContainText('Message');
    await expect(input).toContainText('Summarize yesterday’s chats and open reviews.');
    const when = card.getByRole('heading', { level: 3, name: 'When' });
    await expect(when).toBeVisible();
    await expect(card.getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      /\/schedules\/.+\/edit$/,
    );
    for (const [label, value] of [
      ['Repeats', 'Every day'],
      ['At', '9:00 AM'],
      ['Time zone', 'UTC'],
    ] as const) {
      await expect(card.locator('dt', { hasText: new RegExp(`^${label}$`) })).toBeVisible();
      await expect(card.getByText(value, { exact: true })).toBeVisible();
    }
    await expect(card.getByTestId('schedule-viewer-clock')).toHaveText(
      'That is 3:00 AM in Central time.',
    );
    await expect(card.getByTestId('schedule-overlap')).toHaveText('Skip this one');
    await expect(card.getByTestId('schedule-catch-up')).toHaveText('Don’t catch up on missed runs');
    await expect(card.getByTestId('schedule-revision')).toHaveText('Latest');
    await card.getByRole('button', { name: 'About the workflow version' }).focus();
    await expect(page.getByRole('tooltip')).toHaveText(
      'Scheduled runs start on the latest version of the workflow. A run that is already going keeps the version it started on.',
    );
    await expect(card.getByTestId('schedule-created')).toHaveText('Created Oct 28');

    // The card sits beside the runs at a desktop width and below them under 1024 pixels.
    const runs = await main.getByRole('heading', { level: 2, name: 'Runs' }).boundingBox();
    const cardBox = await card.boundingBox();
    if (runs === null || cardBox === null) throw new Error('the runs and the card are drawn');
    if (width >= 1024) expect(cardBox.x).toBeGreaterThan(runs.x + 300);
    else expect(cardBox.y).toBeGreaterThan(runs.y);

    // The Input group's switch shows the JSON that is stored behind the fields.
    await input.getByRole('radio', { name: 'JSON' }).check({ force: true });
    await expect(input.locator('dt')).toHaveCount(0);
    await expect(input).toContainText('message');
    await expect(input).toContainText('Summarize yesterday’s chats and open reviews.');
    await input.getByRole('radio', { name: 'Fields' }).check({ force: true });

    await captureForDesignReview(page, {
      route: '/schedules/:schedule',
      state: 'daily summary',
      source: SOURCE,
    });
    await checkA11y(`schedule detail at ${width}px`);
  });
}

test('Inbox triage is paused and its workflow is paused too, with the link that resumes the workflow', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await openSchedule(page, 'Inbox triage');
  const main = page.locator('main');

  const toggle = main.getByRole('switch', { name: 'Active, Inbox triage schedule' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(main.locator('.cinder-page-header')).toContainText('Paused');
  await expect(main.getByTestId('schedule-status-line')).toContainText(
    'Runs Triage inbox with Assistant every day at 8:00 AM.',
  );
  const note = main.getByTestId('schedule-workflow-paused');
  await expect(note).toContainText('Triage inbox is paused, so this schedule won’t run it.');
  await expect(note.getByRole('button', { name: 'Resume workflow' })).toBeVisible();
  // The switch is described by what resuming it would do, and offers the workflow's resume.
  const described = await toggle.getAttribute('aria-describedby');
  await expect(page.locator(`[id="${described}"]`)).toContainText(
    'Resuming this schedule would schedule runs that won’t start',
  );
  await expect(main.getByTestId('schedule-summary')).toContainText(
    'No next run while paused · Last ran Oct 24, done',
  );
  // Edit opens the workflow's editor, so it is a link; the rest are buttons.
  await expect(
    main.locator('.cinder-page-header').getByRole('link', { name: 'Edit' }),
  ).toBeVisible();
  for (const name of ['Run now', 'More actions']) {
    await expect(main.getByRole('button', { name })).toBeVisible();
  }

  await captureForDesignReview(page, {
    route: '/schedules/:schedule',
    state: 'paused, workflow paused',
    source: SOURCE,
  });
  await checkA11y('schedule detail, paused workflow');
});

test('Weekly refund audit holds Run now off with its reason as its description, and Assistant never does', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await openSchedule(page, 'Weekly refund audit');
  const main = page.locator('main');

  const runNow = main.getByRole('button', { name: 'Run now' });
  await expect(runNow).toHaveAttribute('aria-disabled', 'true');
  await expect(runNow).toHaveAccessibleDescription(
    'Order refund can’t load. No model provider is connected.',
  );
  await expect(main.getByTestId('schedule-status-line')).toContainText(
    'Runs order-refund with Tool runner every Monday at 11:00 AM.',
  );
  await expect(main.locator('.cinder-page-header')).toContainText('Active');
  await expect(main.getByTestId('schedule-summary')).toContainText('won’t start');

  await captureForDesignReview(page, {
    route: '/schedules/:schedule',
    state: 'run now held off',
    source: SOURCE,
  });
  await checkA11y('schedule detail, run now held off');

  await openSchedule(page, 'Daily summary');
  const assistant = page.locator('main').getByRole('button', { name: 'Run now' });
  await expect(assistant).toBeEnabled();
  await expect(assistant).not.toHaveAttribute('aria-disabled', 'true');
});

test('the menu holds Delete schedule only, below its button, and deleting asks first', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await openSchedule(page, 'Daily summary');
  const main = page.locator('main');

  const more = main.getByRole('button', { name: 'More actions' });
  await more.click();
  await expect(more).toBeFocused();
  const items = page.getByRole('menuitem');
  await expect(items).toHaveCount(1);
  await expect(items).toHaveText('Delete schedule');
  const moreBox = await more.boundingBox();
  const itemBox = await items.boundingBox();
  if (moreBox === null || itemBox === null) throw new Error('the button and the menu are drawn');
  expect(itemBox.y).toBeGreaterThan(moreBox.y + moreBox.height - 1);
  await captureForDesignReview(page, {
    route: '/schedules/:schedule',
    state: 'more actions',
    source: SOURCE,
  });
  await checkA11y('schedule detail, actions menu');

  await items.click();
  const dialog = page.getByRole('dialog', { name: 'Delete Daily summary?' });
  await expect(dialog).toContainText(
    'It stops running and its upcoming runs are removed. Past runs stay on Runs. This can’t be undone.',
  );
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toHaveAttribute(
    'data-cinder-variant',
    'secondary',
  );
  await expect(dialog.getByRole('button', { name: 'Delete schedule' })).toHaveAttribute(
    'data-cinder-variant',
    'danger',
  );
  await captureForDesignReview(page, {
    route: '/schedules/:schedule',
    state: 'delete dialog',
    source: SOURCE,
  });
  await checkA11y('schedule detail, delete dialog');

  // Cancel changes nothing: the schedule is still there.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(main.getByRole('heading', { level: 1, name: 'Daily summary' })).toBeVisible();
});

/** Answers the Bureau's start of a workflow with a run, so Run now makes none in the world. */
async function answerStart(page: Page): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route: Route) => {
    const body = route.request().postDataJSON() as { id?: unknown; method?: string };
    if (body.method !== 'bureau.workflows.start') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: {
        jsonrpc: '2.0',
        id: body.id,
        result: { runId: 'run-release-notes-now', workflow: 'release-notes', workflowVersion: '1' },
      },
    });
  });
}

test('Run now on Release notes digest says so in a toast that opens the run, and its actions are Open file and Run now', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await answerStart(page);
  await openSchedule(page, 'Release notes digest');
  const main = page.locator('main');

  await expect(main.getByRole('link', { name: 'Open file' })).toBeVisible();
  const runNow = main.getByRole('button', { name: 'Run now' });
  await expect(runNow).toHaveAttribute('data-cinder-variant', 'secondary');
  await expect(main.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expect(main.getByRole('button', { name: 'More actions' })).toHaveCount(0);

  await runNow.click();
  const toast = page.getByText('Started Release notes digest.');
  await expect(toast).toBeVisible();
  const open = page.getByRole('button', { name: 'Open run' });
  await expect(open).toBeVisible();
  // Docked at the bottom right of the page, and it dismisses itself.
  const box = await toast.boundingBox();
  const viewport = page.viewportSize();
  if (box === null || viewport === null) throw new Error('the toast is drawn');
  expect(box.x).toBeGreaterThan(viewport.width / 2);
  expect(box.y).toBeGreaterThan(viewport.height / 2);
  await captureForDesignReview(page, {
    route: '/schedules/:schedule',
    state: 'run now toast',
    source: SOURCE,
  });
  await checkA11y('schedule detail, run now toast');
  await expect(toast).toBeHidden();

  await runNow.click();
  await expect(page.getByText('Started Release notes digest.')).toBeVisible();
  await page.getByRole('button', { name: 'Open run' }).click();
  await expect(page).toHaveURL(/\/runs\/run-release-notes-now$/);
});
