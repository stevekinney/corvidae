/**
 * (The file-defined schedule and the run in progress of `ScheduleDetail`, rows 73c, 73d, 73e, 73i
 * and 73j, are asserted after the Release notes digest's failed run.)
 * (The runs timeline of `ScheduleDetail`, rows 72k, 72v, 72w, 72x to 72z, 73a, 73b, 73f, 73g, 73h,
 * 73k, 73l, 73m and 73p, is asserted at the end of this file.)
 *
 * One schedule's page on the sample world's four schedules (`fixtures/sample-world-seed.ts`, the
 * showcase host; COR-2018, the heading, its actions and the details card of `ScheduleDetail`, rows
 * 72a to 72g, 72l to 72q, 72s to 72u and 73r to 73t): the Active switch named with its visible label
 * first beside the one status word, the sentence under the heading, Edit and Run now and a menu that
 * holds Delete schedule, a schedule whose workflow is paused, Run now held off for a workflow that
 * cannot load, and the details card beside the runs at a desktop width and below them under 1024
 * pixels. Nothing here leaves the world every other specification reads changed: Delete is only
 * asked, the run that Run now starts is answered by the specification (the Bureau's
 * `bureau.workflows.start`), so no run is made, and a test that skips a run takes the skip back
 * before it ends, whether or not its assertions pass.
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

/** The Runs list of the page that is open. */
function runsList(page: Page) {
  return page.getByTestId('schedule-runs');
}

for (const width of WIDTHS) {
  test(`Daily summary's runs: three upcoming above Now, one band of misses, the clock break and the Done run, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await openSchedule(page, 'Daily summary');
    const list = runsList(page);

    // Upcoming runs are listed farthest first, with how far away each is; each offers Skip.
    const upcoming = list.locator('li[data-cinder-tone="pending"]');
    await expect(upcoming).toHaveCount(3);
    await expect(upcoming.nth(0)).toContainText('Thu Nov 5, 3:00 AM');
    await expect(upcoming.nth(0)).toContainText('in 3 days');
    await expect(upcoming.nth(1)).toContainText('Wed Nov 4, 3:00 AM');
    await expect(upcoming.nth(2)).toContainText('Tue Nov 3, 3:00 AM');
    await expect(upcoming.nth(2)).toContainText('in 16 hours');
    await expect(list.getByRole('button', { name: /^Skip / })).toHaveCount(3);
    for (let index = 0; index < 3; index += 1) {
      await expect(upcoming.nth(index).getByRole('button', { name: /^Skip / })).toBeVisible();
    }

    // The Now marker splits upcoming from past, with the time the page reads.
    const now = list.locator('li[data-cinder-kind="now"]');
    await expect(now).toContainText('Now');
    await expect(now).toContainText('Mon Nov 2, 10:46 AM');

    // The four misses are one collapsed amber band, with a break where the clock changed under it.
    const band = list.locator('li[data-cinder-kind="band"]');
    await expect(band).toContainText('Missed 4 times since Oct 30');
    await expect(band).toContainText('Interborough was off');
    const toggle = band.locator('button[aria-expanded]').first();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(list.locator('> li[data-cinder-kind="separator"]')).toHaveText(
      'Daylight saving time ended Nov 1',
    );

    // The one past run is a status-first row that links to the run, with how long it took.
    const done = list.locator('li[data-cinder-kind="run"]');
    await expect(done).toHaveCount(1);
    await expect(done).toContainText('Done');
    await expect(done).toContainText('Thu Oct 29, 4:00 AM');
    await expect(done).toContainText('14 s');
    await expect(done.getByRole('link')).toHaveAttribute('href', /\/runs\/.+/);

    await captureForDesignReview(page, {
      route: '/schedules/:schedule',
      state: 'daily summary runs',
      source: SOURCE,
    });

    // Open, the band lists each miss in the viewer's zone and offers one run, not four; the break
    // moves inside it, between the misses either side of the change, and the Done run follows.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(band.getByText('Hide')).toBeVisible();
    await expect(band.getByRole('button', { name: 'Run once now' })).toBeVisible();
    const misses = band.locator('li[data-cinder-plain]');
    await expect(misses).toHaveCount(4);
    await expect(misses.nth(0)).toContainText('Mon Nov 2, 3:00 AM');
    await expect(misses.nth(1)).toContainText('Sun Nov 1, 3:00 AM');
    await expect(misses.nth(2)).toContainText('Sat Oct 31, 4:00 AM');
    await expect(misses.nth(3)).toContainText('Fri Oct 30, 4:00 AM');
    for (let index = 0; index < 4; index += 1) {
      await expect(misses.nth(index)).toContainText('Missed · Interborough was off');
    }
    await expect(band.locator('li[data-cinder-kind="separator"]')).toHaveText(
      'Daylight saving time ended Nov 1',
    );
    await expect(list.locator('> li[data-cinder-kind="separator"]')).toHaveCount(0);
    await expect(done).toContainText('Thu Oct 29, 4:00 AM');
    await captureForDesignReview(page, {
      route: '/schedules/:schedule',
      state: 'daily summary misses expanded',
      source: SOURCE,
    });
    await checkA11y(`schedule detail, runs at ${width}px`);

    // No row makes the page scroll sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

for (const width of WIDTHS) {
  test(`a skipped occurrence is struck through, says Skipped and offers Undo on its row, and Undo restores it, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await openSchedule(page, 'Daily summary');
    const list = runsList(page);
    const upcoming = list.locator('li[data-cinder-tone="pending"]');
    await expect(upcoming).toHaveCount(3);
    const undo = list.getByRole('button', { name: 'Undo skipping Tue Nov 3, 3:00 AM' });
    try {
      await upcoming.nth(2).getByRole('button', { name: 'Skip Tue Nov 3, 3:00 AM' }).click();

      // The Tue Nov 3 run is struck through and says Skipped, with Undo in place of its Skip.
      await expect(upcoming.nth(2).locator('time')).toHaveAttribute('data-cinder-struck', '');
      await expect(upcoming.nth(2).getByTestId('schedule-skipped')).toHaveText('Skipped');
      await expect(upcoming.nth(2)).toContainText('in 16 hours');
      await expect(undo).toBeVisible();
      await expect(undo).toHaveText('Undo');
      await expect(undo.locator('svg')).toHaveCount(1);
      await expect(upcoming.nth(2).getByRole('button', { name: /^Skip / })).toHaveCount(0);
      // The Thu Nov 5 and Wed Nov 4 rows keep Skip, and nothing but the row says so: no toast.
      await expect(
        upcoming.nth(0).getByRole('button', { name: 'Skip Thu Nov 5, 3:00 AM' }),
      ).toBeVisible();
      await expect(
        upcoming.nth(1).getByRole('button', { name: 'Skip Wed Nov 4, 3:00 AM' }),
      ).toBeVisible();
      await expect(list.locator('time[data-cinder-struck]')).toHaveCount(1);
      await expect(page.locator('[data-cinder-toast-id]')).toHaveCount(0);
      // The heading, its status and the Now marker are as the main frame draws them.
      await expect(
        page.getByRole('switch', { name: 'Active, Daily summary schedule' }),
      ).toBeChecked();
      await expect(page.locator('main')).toContainText('Missed runs · 4');
      await expect(list.locator('li[data-cinder-kind="now"]')).toContainText('Mon Nov 2, 10:46 AM');
      // The pointer leaves the row, so the capture shows Undo at rest rather than hovered.
      await page.mouse.move(0, 0);
      await captureForDesignReview(page, {
        route: '/schedules/:schedule',
        state: 'skipped occurrence',
        source: SOURCE,
      });
      await checkA11y(`schedule detail, skipped occurrence at ${width}px`);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);

      // The skip is the engine's, so it is there after a reload.
      await page.reload();
      await expect(undo).toBeVisible();

      await undo.click();
      await expect(list.locator('time[data-cinder-struck]')).toHaveCount(0);
      await expect(list.getByRole('button', { name: /^Skip / })).toHaveCount(3);
      await expect(undo).toHaveCount(0);
    } finally {
      // Leave the world as every other specification reads it.
      if ((await undo.count()) > 0) await undo.click();
      await expect(list.locator('time[data-cinder-struck]')).toHaveCount(0);
    }
  });
}

test('Weekly refund audit, held for its workflow, skips a run and takes the skip back', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await openSchedule(page, 'Weekly refund audit');
  const upcoming = runsList(page).locator('li[data-cinder-tone="pending"]');
  await expect(upcoming).toHaveCount(2);
  const undo = upcoming.nth(0).getByRole('button', { name: 'Undo skipping Mon Nov 9, 11:00 AM' });
  try {
    await upcoming.nth(0).getByRole('button', { name: 'Skip Mon Nov 9, 11:00 AM' }).click();
    await expect(upcoming.nth(0).locator('time')).toHaveAttribute('data-cinder-struck', '');
    await expect(upcoming.nth(0).getByTestId('schedule-skipped')).toHaveText('Skipped');
    // The run that is due keeps its note and its Skip.
    await expect(upcoming.nth(1).getByTestId('schedule-fire-note')).toBeVisible();
    await expect(upcoming.nth(1).getByRole('button', { name: /^Skip / })).toBeVisible();

    await undo.click();
    await expect(runsList(page).locator('time[data-cinder-struck]')).toHaveCount(0);
    await expect(runsList(page).getByRole('button', { name: /^Skip / })).toHaveCount(2);
  } finally {
    if ((await undo.count()) > 0) await undo.click();
    await expect(runsList(page).locator('time[data-cinder-struck]')).toHaveCount(0);
  }
});

test('Run once now starts one run, not one per miss', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  // The Bureau's run now is answered by the specification, so no run is made in the world.
  const starts: string[] = [];
  await page.route('**/bureau/jsonrpc', async (route: Route) => {
    const body = route.request().postDataJSON() as { id?: unknown; method?: string };
    if (body.method !== 'bureau.schedules.runnow') {
      await route.fallback();
      return;
    }
    starts.push(body.method);
    await route.fulfill({
      json: {
        jsonrpc: '2.0',
        id: body.id,
        result: { outcome: 'started', taskId: 'run-daily-summary-now' },
      },
    });
  });
  await openSchedule(page, 'Daily summary');
  await runsList(page)
    .getByRole('button', { name: /Show each/ })
    .click();
  await runsList(page).getByRole('button', { name: 'Run once now' }).click();
  await expect(page.getByRole('button', { name: 'Open run' })).toBeVisible();
  expect(starts).toEqual(['bureau.schedules.runnow']);
});

test('Inbox triage, paused with its workflow, has no upcoming runs and two Done runs', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await openSchedule(page, 'Inbox triage');
  const list = runsList(page);

  await expect(page.getByTestId('schedule-no-upcoming')).toHaveText(
    'No upcoming runs while the schedule is paused.',
  );
  await expect(list.locator('li[data-cinder-tone="pending"]')).toHaveCount(0);
  await expect(list.locator('li[data-cinder-kind="now"]')).toHaveCount(0);
  const done = list.locator('li[data-cinder-kind="run"]');
  await expect(done).toHaveCount(2);
  await expect(done.nth(0)).toContainText('Sat Oct 24, 8:00 AM');
  await expect(done.nth(0)).toContainText('41 s');
  await expect(done.nth(1)).toContainText('Fri Oct 23, 8:00 AM');
  await expect(done.nth(1)).toContainText('38 s');
  for (const row of await done.all()) {
    await expect(row).toContainText('Done');
    await expect(row.getByRole('link')).toHaveAttribute('href', /\/runs\/.+/);
  }
  await captureForDesignReview(page, {
    route: '/schedules/:schedule',
    state: 'paused runs',
    source: SOURCE,
  });
  await checkA11y('schedule detail, paused runs');
});

test('Release notes digest: a failed run says where it stopped and why, in one line', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await openSchedule(page, 'Release notes digest');
  const list = runsList(page);

  const upcoming = list.locator('li[data-cinder-tone="pending"]');
  await expect(upcoming).toHaveCount(1);
  await expect(upcoming).toContainText('Fri Nov 6, 11:00 AM');
  await expect(upcoming).toContainText('in 4 days');
  await expect(list.locator('li[data-cinder-kind="now"]')).toContainText('Mon Nov 2, 10:46 AM');
  const failed = list.locator('li[data-cinder-kind="run"]');
  await expect(failed).toHaveCount(1);
  await expect(failed).toContainText('Failed');
  await expect(failed).toContainText('Fri Oct 30, 11:00 AM');
  await expect(failed).toContainText('Failed at step 2 · GitHub didn’t answer');
  await expect(failed).toContainText('3 s');
  // The Release notes cadence follows the viewer's own clock, so nothing marks a change in it.
  await expect(list.locator('li[data-cinder-kind="separator"]')).toHaveCount(0);
  await captureForDesignReview(page, {
    route: '/schedules/:schedule',
    state: 'file-defined runs',
    source: SOURCE,
  });
  await checkA11y('schedule detail, a failed run');
});

for (const width of WIDTHS) {
  test(`Release notes digest, defined in its file: Active, the chip, and Open file and Run now only, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await openSchedule(page, 'Release notes digest');
    const main = page.locator('main');

    // The switch only shows its state, beside the one green status word.
    const toggle = main.getByRole('switch', { name: 'Active, Release notes digest schedule' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(toggle).toHaveAttribute('aria-readonly', 'true');
    await expect(main.locator('.cinder-page-header [data-status-word]')).toHaveAttribute(
      'data-status-word',
      'Active',
    );
    // The file's trigger says America/Chicago, the viewer's own zone, so no second time follows.
    await expect(main.getByTestId('schedule-status-line')).toHaveText(
      'Runs Release notes every Friday at 11:00 AM.',
    );
    // The chip: the path relative to the home, the full path on hover, no callout.
    const chip = main.getByTestId('schedule-file');
    await expect(chip).toHaveText('Defined in workflows/release-notes.json');
    await expect(chip.locator('svg')).toBeVisible();
    await expect(chip.getByTestId('schedule-file-path')).toHaveAttribute(
      'title',
      /\/workflows\/release-notes\.json$/,
    );
    await expect(chip.getByTestId('schedule-file-path')).toHaveCSS(
      'font-family',
      /mono|Menlo|Courier/i,
    );
    await expect(main.locator('.cinder-callout')).toHaveCount(0);
    // The only actions: Open file and Run now, both secondary.
    await expect(main.getByRole('link', { name: 'Open file' })).toBeVisible();
    await expect(main.getByRole('button', { name: 'Run now' })).toHaveAttribute(
      'data-cinder-variant',
      'secondary',
    );
    await expect(main.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'More actions' })).toHaveCount(0);
    await expect(main.getByTestId('schedule-run-now-second')).toHaveCount(0);
    // Nothing is going, so the summary line leads with the next run.
    await expect(main.getByTestId('schedule-summary')).toHaveText(
      'Next Fri Nov 6, 11:00 AM (in 4 days) · Last ran Oct 30, failed at step 2',
    );
    await captureForDesignReview(page, {
      route: '/schedules/:schedule',
      state: 'file-defined',
      source: SOURCE,
    });
    await checkA11y(`schedule detail, file-defined, at ${width}px`);
  });
}

const GOING_RUN = 'run-release-notes-going';

/**
 * Makes the Release notes digest's runs as the captioned state draws them: one that Run now
 * started 38 seconds ago and that is on "Collecting merged changes", ahead of the runs the host
 * holds. The world has no run going (`tmp/design-review/decisions.md`: "Captioned state outside the
 * sample world"), so the specification answers the reads the page makes of it.
 */
async function answerGoingRun(page: Page): Promise<void> {
  const clock = await page.evaluate(() => Date.now());
  const startedAt = clock - 38_000;
  await page.route(
    (url) => url.pathname.endsWith('/workflows') && url.searchParams.has('schedule_id'),
    async (route: Route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { items: unknown[]; total: number };
      await route.fulfill({
        response,
        json: {
          ...body,
          items: [
            {
              id: GOING_RUN,
              type: 'release-notes',
              status: 'running',
              version: '1',
              createdAt: startedAt,
              updatedAt: startedAt,
            },
            ...body.items,
          ],
          total: body.total + 1,
        },
      });
    },
  );
  await page.route(
    (url) => url.pathname.endsWith(`/workflows/${GOING_RUN}/timeline`),
    async (route: Route) => {
      await route.fulfill({
        json: [
          { step: 1, stepIndex: 1, status: 'running', operationLabel: 'Collecting merged changes' },
        ],
      });
    },
  );
  await page.route(
    (url) => url.pathname.endsWith(`/workflows/${GOING_RUN}`),
    async (route: Route) => {
      await route.fulfill({
        json: {
          id: GOING_RUN,
          type: 'release-notes',
          status: 'running',
          version: '1',
          createdAt: startedAt,
          updatedAt: startedAt,
        },
      });
    },
  );
  await page.route('**/jsonrpc', async (route: Route) => {
    const body = route.request().postDataJSON() as {
      id?: unknown;
      method?: string;
      params?: unknown;
    };
    const params = body.params as { workflowId?: string } | undefined;
    if (
      body.method !== 'weft.workflows.scheduleprovenance.get' ||
      params?.workflowId !== GOING_RUN
    ) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: {
        jsonrpc: '2.0',
        id: body.id,
        result: { scheduleId: 'release-notes-digest', manual: true },
      },
    });
  });
}

for (const width of WIDTHS) {
  test(`Release notes digest while a run is going: Running, Running now with a link, and Run now beside its note, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await answerGoingRun(page);
    await openSchedule(page, 'Release notes digest');
    const main = page.locator('main');

    // The status reads Running in the info tone; the switch is still the read-only Active.
    await expect(main.locator('.cinder-page-header [data-status-word]')).toHaveAttribute(
      'data-status-word',
      'Running',
    );
    const toggle = main.getByRole('switch', { name: 'Active, Release notes digest schedule' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(toggle).toHaveAttribute('aria-readonly', 'true');
    await expect(main.getByTestId('schedule-status-line')).toHaveText(
      'Runs Release notes every Friday at 11:00 AM.',
    );
    // The chip, and Open file and Run now only, with the note beside Run now.
    await expect(main.getByTestId('schedule-file')).toHaveText(
      'Defined in workflows/release-notes.json',
    );
    await expect(main.getByRole('link', { name: 'Open file' })).toBeVisible();
    const runNow = main.getByRole('button', { name: 'Run now' });
    await expect(runNow).toBeEnabled();
    await expect(runNow).toHaveAttribute('data-cinder-variant', 'secondary');
    await expect(main.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'More actions' })).toHaveCount(0);
    const note = main.getByTestId('schedule-run-now-second');
    await expect(note).toHaveText('Another run is going; this starts a second one.');
    // The note sits under the buttons, at the right edge of the actions.
    const noteBox = await note.boundingBox();
    const runNowBox = await runNow.boundingBox();
    if (noteBox === null || runNowBox === null) throw new Error('the note and Run now are drawn');
    expect(noteBox.y).toBeGreaterThan(runNowBox.y + runNowBox.height - 1);
    expect(noteBox.x + noteBox.width).toBeGreaterThan(runNowBox.x + runNowBox.width - 2);

    // The summary line: the going run, in the info tone with a live link, then next and last.
    const summary = main.getByTestId('schedule-summary');
    await expect(summary).toHaveText(
      'Running now: started 38 seconds ago · Open run · Next Fri Nov 6, 11:00 AM · Last ran Oct 30, failed at step 2',
    );
    await expect(main.getByTestId('schedule-running-now')).toHaveText('Running now');
    await expect(main.getByTestId('schedule-running-now')).toHaveAttribute('data-tone', 'info');
    await expect(summary.getByRole('link', { name: 'Open run' })).toHaveAttribute(
      'href',
      `/runs/${GOING_RUN}`,
    );

    // The Runs list: the upcoming run, Now, the run that is going, then the one that failed.
    const list = runsList(page);
    await expect(list.locator('li[data-cinder-tone="pending"]')).toHaveCount(1);
    const going = list.locator('li[data-cinder-kind="run"]').first();
    await expect(going).toContainText('Running');
    await expect(going).toContainText('Mon Nov 2, 10:45 AM');
    await expect(going).toContainText('Started with Run now · Collecting merged changes');
    await expect(going).toContainText('38 s so far');
    await expect(list.locator('li[data-cinder-kind="run"]').last()).toContainText('Failed');

    await captureForDesignReview(page, {
      route: '/schedules/:schedule',
      state: 'file-defined run in progress',
      source: SOURCE,
    });
    await checkA11y(`schedule detail, a run in progress, at ${width}px`);
  });
}

for (const width of WIDTHS) {
  test(`Weekly refund audit says why it will not start, and never ran, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await openSchedule(page, 'Weekly refund audit');
    const main = page.locator('main');

    // The blocker card lists the workflow first, then the provider, each with where to fix it.
    const card = main.getByTestId('schedule-blockers');
    const reasons = card.getByRole('listitem');
    await expect(reasons).toHaveCount(2);
    await expect(reasons.nth(0)).toContainText('Order refund can’t load');
    await expect(reasons.nth(0)).toContainText('order-refund · order-refund.json line 12');
    await expect(reasons.nth(0).getByRole('link', { name: 'Open workflow' })).toBeVisible();
    await expect(reasons.nth(1)).toContainText('No model provider is connected.');
    await expect(reasons.nth(1).getByRole('link', { name: 'Connect a provider' })).toHaveAttribute(
      'href',
      '/settings/models',
    );
    await expect(main.getByTestId('schedule-summary')).toHaveText(
      'Due today, 11:00 AM (in 14 minutes) · won’t start · Never run',
    );

    // The run that is due says why it will not start; both runs are listed.
    const list = runsList(page);
    const upcoming = list.locator('li[data-cinder-tone="pending"]');
    await expect(upcoming).toHaveCount(2);
    await expect(upcoming.nth(0)).toContainText('Mon Nov 9, 11:00 AM');
    await expect(upcoming.nth(0)).toContainText('in 7 days');
    await expect(upcoming.nth(1)).toContainText('Mon Nov 2, 11:00 AM');
    await expect(upcoming.nth(1)).toContainText('in 14 minutes');
    await expect(upcoming.nth(1).getByTestId('schedule-fire-note')).toHaveText(
      'won’t start · Order refund can’t load · no provider',
    );
    // Both keep Skip, because skipping one prevents its start once things are fixed.
    await expect(
      upcoming.nth(0).getByRole('button', { name: 'Skip Mon Nov 9, 11:00 AM' }),
    ).toBeVisible();
    await expect(
      upcoming.nth(1).getByRole('button', { name: 'Skip Mon Nov 2, 11:00 AM' }),
    ).toBeVisible();
    await expect(list.locator('li[data-cinder-kind="now"]')).toContainText('Mon Nov 2, 10:46 AM');

    // Below Now, a compact empty state says why nothing has run.
    await expect(main.getByRole('group', { name: 'No runs yet.' })).toContainText(
      'It won’t start until Order refund loads and a provider is connected.',
    );
    await captureForDesignReview(page, {
      route: '/schedules/:schedule',
      state: 'never run, blocked',
      source: SOURCE,
    });
    await checkA11y(`schedule detail, never run at ${width}px`);
  });
}
