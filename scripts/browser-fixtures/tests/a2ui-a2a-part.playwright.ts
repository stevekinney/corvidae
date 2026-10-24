import { expect, test } from '@playwright/test';
import { fixtureRoute } from './editor-fixture.ts';

test.describe('A2UI surface from an A2A data part', () => {
  test('renders the part Bureau sends and returns the action with its surface and revision', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.goto(fixtureRoute('a2ui-a2a-part'), { waitUntil: 'load' });

    await expect(page.getByText('Confirm the window')).toBeVisible();
    // The data model in the part fills the bound field.
    const note = page.getByLabel('Note');
    await expect(note).toHaveValue('ready');
    await note.fill('window approved');
    await page.getByRole('button', { name: 'Confirm' }).click();

    const sent = JSON.parse((await page.getByTestId('a2ui-sent').textContent()) ?? '{}') as unknown;
    expect(sent).toEqual({
      name: 'confirm',
      surfaceId: 'panel',
      context: { note: 'window approved' },
      metadata: { a2uiSurfaceRevision: 2 },
    });
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
