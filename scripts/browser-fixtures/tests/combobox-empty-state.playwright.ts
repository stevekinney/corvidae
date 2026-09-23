import { expect, test } from './component-page-fixture.ts';
import { fixtureRoute } from './overlay-fixture.ts';

// Regression for COR-499: Combobox used to render its "No results" message
// as a fake, disabled `role="option"` row inside the open listbox — a
// duplicate of the separate live-region announcement, and a phantom option
// an assistive-technology user could seemingly navigate to. This mirrors
// command-menu-empty-state.playwright.ts's real-browser check: zero option
// elements while empty, one status description outside the listbox,
// associated via aria-describedby, and focus/selection staying inert.
test.describe('combobox empty state', () => {
  test('typing an unmatched query leaves zero options and describes the field via aria-describedby', async ({
    page,
  }) => {
    await page.goto(fixtureRoute('combobox'));

    const field = page.getByLabel('Favorite fruit');
    await field.click();
    await field.fill('zzz-audit');

    const listbox = page.locator('.cinder-combobox').getByRole('listbox');
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole('option')).toHaveCount(0);
    // The visible copy lives inside the listbox surface itself; the separate
    // sr-only status region (asserted below via aria-describedby) also
    // contains the same text for assistive technology, so this locator is
    // scoped to the listbox to avoid matching both.
    await expect(listbox.getByText('No results', { exact: true })).toBeVisible();

    await expect(field).toHaveAttribute('aria-describedby', /\S/);
    const fieldDescribedBy = await field.getAttribute('aria-describedby');
    const describedById = fieldDescribedBy?.split(/\s+/).find((id) => id.endsWith('-empty-status'));
    expect(describedById).toBeTruthy();

    const status = page.locator(`[id="${describedById}"]`);
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toContainText('No results');
    // The status is not a descendant of the listbox — it is a separate
    // element outside it, the same relationship CommandMenu uses.
    await expect(status).not.toHaveAttribute('role', 'option');

    await expect(field).not.toHaveAttribute('aria-activedescendant', /\S/);
  });

  test('Enter and Arrow keys do not select or change the value while the result set is empty', async ({
    page,
  }) => {
    await page.goto(fixtureRoute('combobox'));

    const field = page.getByLabel('Favorite fruit');
    await field.click();
    await field.fill('zzz-audit');
    await expect(page.locator('.cinder-combobox').getByRole('listbox')).toBeVisible();

    await field.press('ArrowDown');
    await field.press('ArrowUp');
    await field.press('Enter');

    await expect(field).toHaveValue('zzz-audit');
    await expect(field).not.toHaveAttribute('aria-activedescendant', /\S/);
  });

  test('clearing the query restores real options and active-descendant navigation', async ({
    page,
  }) => {
    await page.goto(fixtureRoute('combobox'));

    const field = page.getByLabel('Favorite fruit');
    await field.click();
    await field.fill('zzz-audit');
    await expect(
      page.locator('.cinder-combobox').getByRole('listbox').getByRole('option'),
    ).toHaveCount(0);

    await field.fill('');
    const listbox = page.locator('.cinder-combobox').getByRole('listbox');
    await expect(listbox.getByRole('option').first()).toBeVisible();
    await field.press('ArrowDown');
    await expect(field).toHaveAttribute('aria-activedescendant', /\S/);
  });
});
