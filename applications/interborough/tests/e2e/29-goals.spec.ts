/**
 * `/goals` (COR-1494): a goal is made from an agent, a prompt, an identity, a validator named by
 * free text, and a most-attempts, and cancelled. The host seeds a validator that never passes, so a
 * goal that names it stays going until the cancel ends it as `canceled`. A validator the Bureau
 * lacks is `Unprocessable`, said in the drawer. The seeded goal is listed, and the page passes axe at
 * the two widths.
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
    // The seeded validator accepts any answer, so the seeded goal ends as succeeded.
    await expect(seeded).toHaveAttribute('data-status', 'succeeded');
    await expect(seeded.getByRole('link', { name: 'assistant' })).toHaveAttribute(
      'href',
      '/agents/assistant',
    );
    await checkA11y(`goals — the list at ${width}px`);
  });
}

test('creates a goal that names the validator that never passes, cancels it, and sees its row end canceled', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/goals');
  await expect(page.locator('tr[data-goal="seeded-goal"]')).toBeVisible();
  const known = await page
    .locator('tr[data-goal]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-goal') ?? ''));

  await page.getByRole('button', { name: GOALS_COPY.newAction }).click();
  const drawer = page.getByRole('dialog', { name: GOALS_COPY.form.title });
  await expect(drawer).toBeVisible();
  await drawer.getByLabel(GOALS_COPY.form.agentLabel).selectOption('assistant');
  await drawer.getByLabel(GOALS_COPY.form.promptLabel).fill('Say hello, and keep trying.');
  await drawer.getByLabel(GOALS_COPY.form.identityNameLabel).fill('say-hello-forever');
  await drawer.getByLabel(GOALS_COPY.form.identityVersionLabel).fill('1');
  await drawer.getByLabel(GOALS_COPY.form.validatorNameLabel).fill('never-passes');
  await drawer.getByLabel(GOALS_COPY.form.validatorVersionLabel).fill('1');
  await checkA11y('goals — the create drawer');
  await drawer.getByRole('button', { name: GOALS_COPY.form.createAction }).click();
  await expect(drawer).not.toBeVisible();

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
  await expect(row.getByRole('button', { name: GOALS_COPY.cancelAction })).toHaveCount(0);
  await checkA11y('goals — a canceled goal');
});

test('says Unprocessable in the drawer for a validator the Bureau does not have', async ({
  page,
}) => {
  await page.goto('/goals?create=1');
  const drawer = page.getByRole('dialog', { name: GOALS_COPY.form.title });
  await expect(drawer).toBeVisible();
  await drawer.getByLabel(GOALS_COPY.form.agentLabel).selectOption('assistant');
  await drawer.getByLabel(GOALS_COPY.form.promptLabel).fill('Say hello.');
  await drawer.getByLabel(GOALS_COPY.form.identityNameLabel).fill('say-hello');
  await drawer.getByLabel(GOALS_COPY.form.identityVersionLabel).fill('1');
  await drawer.getByLabel(GOALS_COPY.form.validatorNameLabel).fill('no-such-validator');
  await drawer.getByLabel(GOALS_COPY.form.validatorVersionLabel).fill('1');

  await drawer.getByRole('button', { name: GOALS_COPY.form.createAction }).click();

  const fault = drawer.getByTestId('goal-fault');
  await expect(fault).toHaveAttribute('data-fault-code', 'Unprocessable');
  await expect(fault).toContainText('no-such-validator');
  await expect(drawer).toBeVisible();
});
