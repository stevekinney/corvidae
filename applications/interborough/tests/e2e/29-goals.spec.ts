/**
 * `/goals` (COR-1494, COR-1843, COR-2017): a goal is made on `/goals/new` from an agent chosen from
 * the agents, a prompt, an identity, a validator named by free text, and a most-attempts. The host
 * seeds a validator that never passes, so a goal that names it stays going until it is cancelled,
 * which the list does not offer (a goal's own page stops it), so the test cancels it through the
 * Bureau and sees its row end as Stopped. A validator the Bureau lacks is `Unprocessable`, said on
 * the page. The seeded goal is listed as a status-first row titled by its name, its page lists its
 * attempts, and the pages pass axe at the two widths. Goals is in the sidebar, and `g` then `l`
 * opens it.
 */
import { GOALS_COPY } from '../../src/app/copy.ts';
import { expect, test } from './fixtures.ts';
import { bureauCall } from './task-support.ts';

const WIDTHS = [375, 1280] as const;

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

  await page.goto('/chats');
  await page.getByRole('heading', { level: 1 }).first().waitFor();
  await page.keyboard.press('g');
  await page.keyboard.press('l');
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

test('creates a goal that names the validator that never passes, and sees its row end Stopped once it is cancelled', async ({
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
  await page.getByLabel(GOALS_COPY.form.agentLabel).selectOption('demo:assistant');
  await page.getByLabel(GOALS_COPY.form.promptLabel).fill('Say hello, and keep trying.');
  await page.getByLabel(GOALS_COPY.form.identityNameLabel).fill('say-hello-forever');
  await page.getByLabel(GOALS_COPY.form.identityVersionLabel).fill('1');
  await page.getByLabel(GOALS_COPY.form.validatorNameLabel).fill('demo:never-passes');
  await page.getByLabel(GOALS_COPY.form.validatorVersionLabel).fill('1');
  await checkA11y('goals — the new goal page');
  await page.getByRole('button', { name: GOALS_COPY.form.createAction }).click();
  await expect(page).toHaveURL(/\/goals$/);

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

test('says Unprocessable on the page for a validator the Bureau does not have', async ({
  page,
}) => {
  await page.goto('/goals/new');
  await expect(page.getByRole('heading', { level: 1, name: GOALS_COPY.form.title })).toBeVisible();
  await page.getByLabel(GOALS_COPY.form.agentLabel).selectOption('demo:assistant');
  await page.getByLabel(GOALS_COPY.form.promptLabel).fill('Say hello.');
  await page.getByLabel(GOALS_COPY.form.identityNameLabel).fill('say-hello');
  await page.getByLabel(GOALS_COPY.form.identityVersionLabel).fill('1');
  await page.getByLabel(GOALS_COPY.form.validatorNameLabel).fill('no-such-validator');
  await page.getByLabel(GOALS_COPY.form.validatorVersionLabel).fill('1');

  await page.getByRole('button', { name: GOALS_COPY.form.createAction }).click();

  const fault = page.getByTestId('goal-fault');
  await expect(fault).toHaveAttribute('data-fault-code', 'Unprocessable');
  await expect(fault).toContainText('no-such-validator');
  await expect(page).toHaveURL(/\/goals\/new$/);
});
