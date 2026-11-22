/**
 * `/goals` (COR-1494, COR-1843, COR-2017): a goal is made on `/goals/new` from a prompt, a check, an
 * agent chosen from the agents, and an attempt limit, and changed on `/goals/:goal/edit`. The host
 * seeds a validator that never passes, so a goal whose check names it stays going until it is cancelled,
 * which the list does not offer (a goal's own page stops it), so the test cancels it through the
 * Bureau and sees its row end as Stopped. The check is chosen from the picker the Bureau's list
 * fills; a check it lacks cannot be typed (its `Unprocessable` is a unit test). The seeded goal is listed as a status-first row titled by its name, its page lists its
 * attempts, and the pages pass axe at the two widths. Goals is in the sidebar, and `g` then `l`
 * opens it.
 */
import type { Page } from '@playwright/test';

import { GOALS_COPY } from '../../src/app/copy/goals.ts';
import { expect, test } from './fixtures.ts';
import { pressChord } from './shortcut-support.ts';
import { bureauCall } from './task-support.ts';

const WIDTHS = [375, 1280] as const;

/**
 * The check picker: a listbox select, drawn as a button with `role="combobox"` that opens a list of
 * options (it takes no typed text, so a check the Bureau does not list cannot be entered). It is
 * disabled until the Bureau has listed its checks.
 */
const checkPicker = (page: Page) =>
  page.getByRole('combobox', { name: GOALS_COPY.form.checkLabel });

/** Opens the check picker and chooses the option named `name`. */
async function chooseCheck(page: Page, name: RegExp): Promise<void> {
  const picker = checkPicker(page);
  await expect(picker).toBeEnabled();
  await picker.click();
  await page.getByRole('option', { name }).click();
}

for (const width of WIDTHS) {
  test(`lists the seeded goal at ${width} pixels, and passes axe`, async ({ page, checkA11y }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/goals');

    await expect(page.locator('[data-view="goals"]')).toHaveAttribute('data-state', 'ready');
    const seeded = page.locator('[data-goal="seeded-goal"]');
    await expect(seeded).toBeVisible();
    await expect(seeded).toHaveAttribute('data-status-word', 'Done');
    // The seeded validator accepts any answer, so the seeded goal ends as succeeded.
    await expect(seeded).toHaveAttribute('data-status', 'succeeded');
    // The row is titled by the goal's name, and its title is the link to the goal's page.
    await expect(seeded.getByRole('link', { name: 'say-hello' })).toHaveAttribute(
      'href',
      '/goals/seeded-goal',
    );
    await checkA11y(`goals — the list at ${width}px`);
  });
}

test('opens from the sidebar and from g then l, and lists the goal in the status words', async ({
  page,
}) => {
  await page.goto('/chats');
  await page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('link', { name: 'Goals' })
    .click();
  await expect(page).toHaveURL(/\/goals$/);
  await expect(page.locator('[data-goal="seeded-goal"]')).toHaveAttribute(
    'data-status-word',
    'Done',
  );

  // The chord is typed at the times a person presses it, so a page still painting cannot spend the
  // chord window between its two keys (`shortcut-support.ts`).
  await page.goto('/agents');
  await expect(page.locator('[data-view="agents"]')).toHaveAttribute('data-state', 'ready');
  await pressChord(page, 'l');
  await expect(page).toHaveURL(/\/goals$/);
});

test('lists the attempts of the seeded goal on its page, each linking to its run', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/goals/seeded-goal');

  await expect(page.locator('[data-view="goals"]')).toHaveAttribute('data-state', 'ready');
  // The page is titled by the goal's name, and each attempt row is the link to its run.
  await expect(page.getByRole('heading', { level: 1 })).toContainText('say-hello');
  const attempts = page.locator('[data-attempt]');
  await expect(attempts.first()).toBeVisible();
  const run = await attempts.first().getAttribute('data-run');
  await expect(attempts.first().locator('a').first()).toHaveAttribute('href', `/runs/${run ?? ''}`);
  await checkA11y('goals — one goal and its attempts');
});

test('creates a goal that names the check that never passes, lands on its page, and sees its row end Stopped once it is cancelled', async ({
  page,
  request,
  checkA11y,
}) => {
  await page.goto('/goals');
  await expect(page.locator('[data-goal="seeded-goal"]')).toBeVisible();
  const known = await page
    .locator('[data-goal]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-goal') ?? ''));

  // The header's "+" is a button that makes a goal.
  await page.getByRole('button', { name: GOALS_COPY.newAction }).click();
  await expect(page).toHaveURL(/\/goals\/new$/);
  await expect(page.getByRole('heading', { level: 1, name: GOALS_COPY.form.title })).toBeVisible();
  await page.getByLabel(GOALS_COPY.form.agentLabel, { exact: true }).selectOption('demo:assistant');
  await page.getByLabel(GOALS_COPY.form.promptLabel).fill('Say hello, and keep trying.');
  // The check is chosen from the list the Bureau gives, and the host seeds one that never passes.
  await chooseCheck(page, /never passes/i);
  await expect(checkPicker(page)).toContainText(/never passes/i);
  await checkA11y('goals — the new goal page');
  await page.getByRole('button', { name: GOALS_COPY.form.createAction }).click();

  // A goal that is made lands on its own page.
  await expect(page).toHaveURL(/\/goals\/(?!new$)[^/]+$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Say hello, and keep trying.',
  );
  await page.goto('/goals');

  // The new row is the one this page had not seen, and it is going, not ended.
  await expect(page.locator('[data-goal]')).toHaveCount(known.length + 1);
  const after = await page
    .locator('[data-goal]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-goal') ?? ''));
  const id = after.find((candidate) => !known.includes(candidate)) ?? '';
  expect(id).not.toBe('');
  const row = page.locator(`[data-goal="${id}"]`);
  await expect(row).not.toHaveAttribute('data-status', /^(succeeded|failed|exhausted|canceled)$/);
  await expect(row).toHaveAttribute('data-status-word', /^Running/);

  // The list offers no cancel (a goal's own page stops it), so the Bureau ends it.
  await bureauCall(request, 'bureau.goals.cancel', { goalRunId: id });

  await expect(row).toHaveAttribute('data-status', 'canceled');
  await expect(row).toHaveAttribute('data-status-word', 'Stopped');
  await expect(row.getByRole('button')).toHaveCount(0);
  await checkA11y('goals — a stopped goal');
});

test('opens Edit goal from a goal’s page with its check and limit in the fields, and Cancel goes back', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/goals/seeded-goal');
  await page.getByRole('link', { name: GOALS_COPY.detail.editAction }).click();
  await expect(page).toHaveURL(/\/goals\/seeded-goal\/edit$/);
  await expect(
    page.getByRole('heading', { level: 1, name: GOALS_COPY.form.edit.title }),
  ).toBeVisible();
  // The picker shows the goal's check in its trigger, not the placeholder it shows when none is chosen.
  await expect(checkPicker(page)).toBeEnabled();
  await expect(checkPicker(page)).not.toContainText(GOALS_COPY.form.checkPlaceholder);
  await expect(
    page.getByLabel(GOALS_COPY.form.maximumAttemptsLabel, { exact: true }),
  ).not.toHaveValue('');
  await checkA11y('goals — the edit goal page');

  await page.getByRole('link', { name: GOALS_COPY.form.cancelAction }).click();
  await expect(page).toHaveURL(/\/goals\/seeded-goal$/);
});

test.describe('Goal edit actions above the phone tab bar', () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const width of [320, 375] as const) {
    test(`Save and Cancel keep their coarse hit areas in the ${width}px goal editor outlet`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      for (const control of ['Save', 'Cancel'] as const) {
        await page.goto('/goals/seeded-goal/edit');
        const action = page.getByRole(control === 'Save' ? 'button' : 'link', { name: control });
        await action.scrollIntoViewIfNeeded();
        await expect(action).toBeInViewport();
        const target = await action.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const x = box.left + box.width / 2;
          const y = box.top + box.height / 2 + 21;
          const outlet = element.closest('main');
          if (outlet === null) throw new Error('the goal editor outlet is drawn');
          return {
            x,
            y,
            faceHeight: box.height,
            reachesAction: element.contains(document.elementFromPoint(x, y)),
            remainsInOutlet: y < outlet.getBoundingClientRect().bottom,
          };
        });
        expect(target.faceHeight).toBeLessThanOrEqual(36);
        expect(target.reachesAction).toBe(true);
        expect(target.remainsInOutlet).toBe(true);

        await page.touchscreen.tap(target.x, target.y);
        await expect(page).toHaveURL(/\/goals\/seeded-goal$/);
      }

      const tab = page.getByRole('navigation', { name: 'Main tabs' }).getByRole('link', {
        name: 'Home',
      });
      await expect(tab).toBeVisible();
      const tabHit = await tab.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        return {
          height: box.height,
          owned: element.contains(document.elementFromPoint(x, y)),
        };
      });
      expect(tabHit.height).toBeGreaterThanOrEqual(44);
      expect(tabHit.owned).toBe(true);
      await page.touchscreen.tap(tabHit.x, tabHit.y);
      await expect(page).toHaveURL(/\/$/);
    });
  }
});

// A check the Bureau does not have cannot be typed into the picker, so the `Unprocessable` for one
// that went between the form's load and its submit is tested where the Bureau can be made to refuse
// it: `goals-page.test.ts` ("says Unprocessable above the buttons for a check the Bureau no longer
// has"). Here the test asks what the page now guarantees: the picker offers only the checks the
// Bureau lists, and takes no typed text.
test('offers the checks the Bureau lists, and no way to name one it does not have', async ({
  page,
}) => {
  await page.goto('/goals/new');
  await expect(page.getByRole('heading', { level: 1, name: GOALS_COPY.form.title })).toBeVisible();
  const picker = checkPicker(page);
  await expect(picker).toBeEnabled();

  await picker.click();

  await expect(page.getByRole('option', { name: /never passes/i })).toHaveCount(1);
  await expect(page.getByRole('option', { name: /accepts any answer/i })).toHaveCount(1);
  // A button, not a field: nothing can be typed into it.
  await expect(picker).toHaveJSProperty('tagName', 'BUTTON');
  // Create with no prompt says what is missing at the prompt and creates nothing.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: GOALS_COPY.form.createAction }).click();
  // The sentence is also the start of the prompt's description, so the match is the whole text:
  // only the error says exactly this and nothing more.
  await expect(page.getByText(GOALS_COPY.form.promptRequired, { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/goals\/new$/);
});
