import { fillJson, openFirstEditor, openJsonEditor } from './editors-json-schema-support.ts';
import { expect, test } from './review-editor-browser-errors.ts';

test.describe('JSON schema editor form and view contracts', () => {
  test('Diff tab shows "Diff" without a raw bullet and carries accessible change markup', async ({
    page,
  }) => {
    const editor = await openFirstEditor(page);
    const diffTab = editor.locator('[role="tab"]').filter({ hasText: /Diff/ }).first();
    await expect(diffTab).toBeVisible();

    // Visible accessible text must read "Diff" with no raw bullet character.
    const tabText = (await diffTab.textContent()) ?? '';
    expect(tabText).toContain('Diff');
    expect(tabText).not.toContain('•');

    // The semantic structure must be present: the changed-state badge lives in
    // the Tab `trailing` slot (aria-hidden), and any change text is sr-only —
    // neither leaks a raw bullet into the accessible name.
    const innerHtml = await diffTab.innerHTML();
    expect(innerHtml).not.toMatch(/>\s*•/);
  });

  test('toolbar has role=toolbar and an accessible label', async ({ page }) => {
    const editor = await openFirstEditor(page);
    const toolbar = editor.locator('.cinder-jse-toolbar').first();
    await expect(toolbar).toBeVisible();
    await expect(toolbar).toHaveAttribute('role', 'toolbar');
    const label = (await toolbar.getAttribute('aria-label')) ?? '';
    expect(label.length).toBeGreaterThan(0);
  });

  test('JSON commits surface editable enum values in the form view', async ({ page }) => {
    const editor = await openFirstEditor(page);
    const jsonTab = editor.getByRole('tab', { name: /JSON/ });
    await jsonTab.click();

    const textarea = await openJsonEditor(editor);
    await textarea.fill('{"type":"string","enum":["draft","published"]}');
    await editor.getByRole('button', { name: 'Apply' }).click();

    await editor.getByRole('tab', { name: /^Form/ }).click();
    const enumTable = editor.getByRole('table', { name: 'Enum values' });
    await expect(enumTable).toBeVisible();
    await expect(editor.getByRole('textbox', { name: 'Enum value 1', exact: true })).toHaveValue(
      '"draft"',
    );
    await expect(editor.getByRole('textbox', { name: 'Enum value 2', exact: true })).toHaveValue(
      '"published"',
    );
  });

  test('JSON edit actions preserve keyboard focus when they return to the code view', async ({
    page,
  }) => {
    const editor = await openFirstEditor(page);
    await editor.getByRole('tab', { name: /JSON/ }).click();

    const editJson = editor.getByRole('button', { name: 'Edit JSON' });
    await editJson.click();
    await expect(editor.getByRole('textbox', { name: 'JSON' })).toBeFocused();

    await editor.getByRole('button', { name: 'Done' }).click();
    await expect(editJson).toBeFocused();

    await editJson.click();
    const textarea = editor.getByRole('textbox', { name: 'JSON' });
    await textarea.fill('{"type":"number"}');
    await expect(editor.getByRole('button', { name: 'Apply' })).toBeEnabled();
    await editor.getByRole('button', { name: 'Apply' }).click();
    await expect(editJson).toBeFocused();

    await editJson.click();
    await textarea.fill('{"type":"boolean"}');
    await editor.getByRole('button', { name: 'Discard' }).click();
    await expect(editJson).toBeFocused();
  });

  test('invalid enum drafts survive switching away from the form view', async ({ page }) => {
    const editor = await openFirstEditor(page);
    const jsonTab = editor.getByRole('tab', { name: /JSON/ });
    await jsonTab.click();
    await fillJson(editor, '{"type":"string","enum":["draft","published"]}');
    await editor.getByRole('button', { name: 'Apply' }).click();

    await editor.getByRole('tab', { name: /^Form/ }).click();
    const enumValue = editor.getByRole('textbox', { name: 'Enum value 2', exact: true });
    await enumValue.fill('{');
    await expect(editor.getByText('Enter a valid JSON value.')).toBeVisible();

    await jsonTab.click();
    await editor.getByRole('tab', { name: /^Form/ }).click();
    await expect(editor.getByRole('textbox', { name: 'Enum value 2', exact: true })).toHaveValue(
      '{',
    );
    await expect(editor.getByText('Enter a valid JSON value.')).toBeVisible();
  });

  test('the type selector switches a property to enum and reveals the enum table', async ({
    page,
  }) => {
    const editor = await openFirstEditor(page);
    await editor.getByRole('button', { name: 'Expand name property' }).click();

    const typeSelect = editor.getByRole('combobox', { name: 'name type' });
    await expect(typeSelect).toHaveValue('string');
    await expect(editor.getByRole('table', { name: 'Enum values' })).toHaveCount(0);

    await typeSelect.selectOption('enum');

    await expect(editor.getByRole('table', { name: 'Enum values' })).toBeVisible();
    await expect(editor.getByRole('textbox', { name: 'Enum value 1', exact: true })).toHaveValue(
      '""',
    );
  });

  test('selecting "Multiple types" seeds a starting array and reveals the checkbox row', async ({
    page,
  }) => {
    const editor = await openFirstEditor(page);
    await editor.getByRole('button', { name: 'Expand name property' }).click();

    const typeSelect = editor.getByRole('combobox', { name: 'name type' });
    await expect(editor.getByRole('checkbox', { name: 'string', exact: true })).toHaveCount(0);

    await typeSelect.selectOption('multiple');

    await expect(editor.getByRole('checkbox', { name: 'string', exact: true })).toBeChecked();
    await expect(editor.getByRole('checkbox', { name: 'null', exact: true })).toBeChecked();

    const jsonTab = editor.getByRole('tab', { name: /JSON/ });
    await jsonTab.click();
    await expect(await openJsonEditor(editor)).toHaveValue(
      /"type":\s*\[\s*"string",\s*"null"\s*\]/,
    );
  });

  test('selecting "Multiple types" from an enum on an already multi-type schema preserves the existing types', async ({
    page,
  }) => {
    const editor = await openFirstEditor(page);
    const jsonTab = editor.getByRole('tab', { name: /JSON/ });
    await jsonTab.click();
    await fillJson(
      editor,
      '{"type":"object","properties":{"code":{"type":["string","number"],"enum":["a",1]}}}',
    );
    await editor.getByRole('button', { name: 'Apply' }).click();

    await editor.getByRole('tab', { name: /^Form/ }).click();
    await editor.getByRole('button', { name: 'Expand code property' }).click();

    const typeSelect = editor.getByRole('combobox', { name: 'code type' });
    await expect(typeSelect).toHaveValue('enum');

    await typeSelect.selectOption('multiple');

    // Existing multi-type set survives — not reseeded to [base, 'null'].
    await expect(editor.getByRole('checkbox', { name: 'string', exact: true })).toBeChecked();
    await expect(editor.getByRole('checkbox', { name: 'number', exact: true })).toBeChecked();
    await expect(editor.getByRole('checkbox', { name: 'null', exact: true })).not.toBeChecked();
    await expect(editor.getByRole('table', { name: 'Enum values' })).toHaveCount(0);

    await jsonTab.click();
    await expect(await openJsonEditor(editor)).toHaveValue(
      /"type":\s*\[\s*"string",\s*"number"\s*\]/,
    );
  });
});
