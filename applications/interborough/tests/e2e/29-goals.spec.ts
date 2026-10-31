/**
 * `/goals` (COR-1494, COR-1843): a goal is made on `/goals/new` from an agent chosen from the
 * agents, a prompt, an identity, a validator named by free text, and a most-attempts, and cancelled
 * from the list. The host seeds a validator that never passes, so a goal that names it stays going
 * until the cancel ends it as `canceled`. A validator the Bureau lacks is `Unprocessable`, said on
 * the page. The seeded goal is listed in the seven status words, its page lists its attempts, and
 * the pages pass axe at the two widths. Goals is in the sidebar, and `g` then `l` opens it.
 */
import { GOALS_COPY } from '../../src/app/copy.ts';
import { expect, test } from './fixtures.ts';

const WIDTHS = [375, 1280] as const;

for (const width of WIDTHS) {
  test(`lists the seeded goal at ${width} pixels, and passes axe`, async ({ page, checkA11y }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/goals');

    await expect(page.locator('[data-view="goals"]')).toHaveAttribute('data-state', 'ready');
    const seeded = page.locator('tr[data-goal="seeded-goal"]');
    await expect(seeded).toBeVisible();
    await expect(seeded).toHaveAttribute('data-status-word', 'Done');
    // The seeded validator accepts any answer, so the seeded goal ends as succeeded.
    await expect(seeded).toHaveAttribute('data-status', 'succeeded');
    await expect(seeded.getByRole('link', { name: 'assistant' })).toHaveAttribute(
      'href',
      '/agents/assistant',
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
  await expect(page.locator('tr[data-goal="seeded-goal"]')).toHaveAttribute(
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
  await expect(page.getByRole('heading', { level: 1 })).toContainText('seeded-goal');
  const attempts = page.locator('tr[data-attempt]');
  await expect(attempts.first()).toBeVisible();
  const run = await attempts.first().getAttribute('data-run');
  await expect(attempts.first().getByRole('link', { name: run ?? '' })).toHaveAttribute(
    'href',
    `/runs/${run ?? ''}`,
  );
  await checkA11y('goals — one goal and its attempts');
});

test('creates a goal that names the validator that never passes, cancels it, and sees its row end canceled', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/goals');
  await expect(page.locator('tr[data-goal="seeded-goal"]')).toBeVisible();
  const known = await page
    .locator('tr[data-goal]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-goal') ?? ''));

  await page.getByRole('link', { name: GOALS_COPY.newAction }).click();
  await expect(page).toHaveURL(/\/goals\/new$/);
  await expect(page.getByRole('heading', { level: 1, name: GOALS_COPY.form.title })).toBeVisible();
  await page.getByLabel(GOALS_COPY.form.agentLabel).selectOption('assistant');
  await page.getByLabel(GOALS_COPY.form.promptLabel).fill('Say hello, and keep trying.');
  await page.getByLabel(GOALS_COPY.form.identityNameLabel).fill('say-hello-forever');
  await page.getByLabel(GOALS_COPY.form.identityVersionLabel).fill('1');
  await page.getByLabel(GOALS_COPY.form.validatorNameLabel).fill('never-passes');
  await page.getByLabel(GOALS_COPY.form.validatorVersionLabel).fill('1');
  await checkA11y('goals — the new goal page');
  await page.getByRole('button', { name: GOALS_COPY.form.createAction }).click();
  await expect(page).toHaveURL(/\/goals$/);

  // The new row is the one this page had not seen, and it is going, not ended.
  await expect(page.locator('tr[data-goal]')).toHaveCount(known.length + 1);
  const after = await page
    .locator('tr[data-goal]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-goal') ?? ''));
  const id = after.find((candidate) => !known.includes(candidate)) ?? '';
  expect(id).not.toBe('');
  const row = page.locator(`tr[data-goal="${id}"]`);
  await expect(row).not.toHaveAttribute('data-status', /^(succeeded|failed|exhausted|canceled)$/);

  await row.getByRole('button', { name: GOALS_COPY.cancelAction }).click();
  await page.getByRole('button', { name: GOALS_COPY.cancelDialog.confirm }).click();

  await expect(row).toHaveAttribute('data-status', 'canceled', { timeout: 20_000 });
  await expect(row).toHaveAttribute('data-status-word', 'Canceled');
  await expect(row.getByRole('button', { name: GOALS_COPY.cancelAction })).toHaveCount(0);
  await checkA11y('goals — a canceled goal');
});

test('says Unprocessable on the page for a validator the Bureau does not have', async ({
  page,
}) => {
  await page.goto('/goals/new');
  await expect(page.getByRole('heading', { level: 1, name: GOALS_COPY.form.title })).toBeVisible();
  await page.getByLabel(GOALS_COPY.form.agentLabel).selectOption('assistant');
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
