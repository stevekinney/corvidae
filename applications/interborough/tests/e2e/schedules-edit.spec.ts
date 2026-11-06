/**
 * The page that edits a schedule, at `/schedules/:id/edit` (COR-2018, rows 74r, 74t, 75p, 75q), on
 * the sample world: Daily summary opens as the New schedule form filled in, with focus on Repeats,
 * and a schedule whose workflow was deleted (Weekly cleanup, paused: a captioned state outside the
 * sample world, drawn by answering the engine's REST read of Inbox triage with another workflow type)
 * keeps the old name in the Workflow field and moves focus to it on Save. Nothing here saves,
 * because the showcase host's four schedules are the world every other specification reads; saving
 * is proved with `schedule-edit-pages.test.ts` and `schedule-edit.test.ts`.
 */
import type { Page } from '@playwright/test';

import { SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'schedules-edit.spec.ts';
const WIDTHS = [1280, 768, 375] as const;

/** The address of a schedule's page, read from its link in the list. */
async function addressOf(page: Page, name: string): Promise<string> {
  await page.goto('/schedules');
  const href = await page.getByRole('link', { name }).first().getAttribute('href');
  if (href === null) throw new Error(`The list has no link for ${name}.`);
  return href;
}

for (const width of WIDTHS) {
  test(`Edit Daily summary opens prefilled with focus on Repeats and the Save changes footer, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const address = `${await addressOf(page, 'Daily summary')}/edit`;
    await page.goto(address);
    const main = page.locator('main');

    await expect(main.getByRole('heading', { level: 1, name: 'Edit Daily summary' })).toBeVisible();
    await expect(main).not.toContainText('Opened from When');
    await expect(main.getByRole('heading', { level: 2 })).toHaveText([
      'What runs',
      'Input',
      'When',
    ]);
    await expect(main.getByRole('combobox', { name: /^Workflow/ })).toContainText(
      'Chat with an agent',
    );
    await expect(main.getByLabel(/^Agent/)).toHaveValue('assistant');
    await expect(main.getByLabel(/^Message/)).toHaveValue(
      'Summarize yesterday’s chats and open reviews.',
    );
    await expect(main.getByLabel(/^Name/)).toHaveValue('Daily summary');
    await expect(main.getByLabel('Repeats')).toBeFocused();
    await expect(main.getByTestId('new-schedule-summary')).toHaveText(
      'Saves changes to Daily summary.',
    );
    await expect(main.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    await expect(main.getByRole('link', { name: 'Cancel' })).toBeVisible();
    await expect(main.getByRole('button', { name: 'Create schedule' })).toHaveCount(0);

    await captureForDesignReview(page, {
      route: '/schedules/:schedule/edit',
      state: 'edit daily summary',
      source: SOURCE,
    });
    await checkA11y(`edit schedule at ${width}px`);
  });
}

test('Edit Weekly cleanup keeps the old workflow name marked, says it was deleted, and moves focus to the field on Save changes', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const address = await addressOf(page, 'Inbox triage');
  const id = decodeURIComponent(address.split('/').at(-1) ?? '');
  // The engine's read of the schedule answers as one whose workflow was deleted.
  await page.route(
    (url) => url.pathname.endsWith(`/schedules/${encodeURIComponent(id)}`),
    async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      const response = await route.fetch();
      const original = await response.text();
      const text = original
        .replace('"workflowType":"triage-inbox"', '"workflowType":"weekly-cleanup"')
        .replace('"description":"Inbox triage"', '"description":"Weekly cleanup"');
      await route.fulfill({ response, body: text });
    },
  );
  await page.goto(`${address}/edit`);
  const main = page.locator('main');

  await expect(main.getByRole('heading', { level: 1, name: 'Edit Weekly cleanup' })).toBeVisible();
  const field = main.getByRole('combobox', { name: /^Workflow/ });
  await expect(field).toContainText('Weekly cleanup · can’t find this workflow');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(main).toContainText(
    'That workflow was deleted. Pick another to keep this schedule; it stays paused until then.',
  );
  await expect(main.getByTestId('new-schedule-summary')).toHaveText(
    'Saves changes to Weekly cleanup.',
  );
  const save = main.getByRole('button', { name: 'Save changes' });
  await expect(save).toBeEnabled();
  await expect(main.getByRole('link', { name: 'Cancel' })).toBeVisible();
  await captureForDesignReview(page, {
    route: '/schedules/:schedule/edit',
    state: 'workflow deleted',
    source: SOURCE,
  });
  await checkA11y('edit schedule, workflow deleted');

  await save.click();
  await expect(field).toBeFocused();
});
