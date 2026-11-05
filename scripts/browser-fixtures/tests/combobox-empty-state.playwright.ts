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

    const field = page.getByRole('combobox', { name: 'Favorite fruit' });
    await field.click();
    await field.fill('zzz-audit');

    const controls = await field.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    const listbox = page.locator(`#${controls}`);
    await expect(listbox).toHaveAttribute('hidden', '');
    await expect(listbox.getByRole('option')).toHaveCount(0);
    // The visible copy belongs to the surrounding portaled panel, while the
    // aria-controls-linked listbox is intentionally hidden when it has no options.
    await expect(page.locator('.cinder-combobox__empty')).toBeVisible();

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

    const field = page.getByRole('combobox', { name: 'Favorite fruit' });
    await field.click();
    await field.fill('zzz-audit');
    const controls = await field.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    await expect(page.locator(`#${controls}`)).toHaveAttribute('hidden', '');
    await expect(page.locator('.cinder-combobox__empty')).toBeVisible();

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

    const field = page.getByRole('combobox', { name: 'Favorite fruit' });
    await field.click();
    await field.fill('zzz-audit');
    await expect(
      page.locator(`#${await field.getAttribute('aria-controls')}`).getByRole('option'),
    ).toHaveCount(0);

    await field.fill('');
    const controls = await field.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    const listbox = page.locator(`#${controls}`);
    await expect(listbox.getByRole('option').first()).toBeVisible();
    await field.press('ArrowDown');
    await expect(field).toHaveAttribute('aria-activedescendant', /\S/);
  });
});
