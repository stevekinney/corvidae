import {
  fillJson,
  jsonValue,
  openFirstEditor,
  openJsonEditor,
} from './editors-json-schema-support.ts';
import { expect, test } from './review-editor-browser-errors.ts';

test.describe('JSON schema editor state contracts', () => {
  test('typing an enum value description promotes to oneOf, and clearing it demotes back to a bare enum', async ({
    page,
  }) => {
    const editor = await openFirstEditor(page);
    const jsonTab = editor.getByRole('tab', { name: /JSON/ });
    await jsonTab.click();
    await fillJson(
      editor,
      '{"type":"object","properties":{"status":{"type":"string","enum":["draft","published"]}}}',
    );
    await editor.getByRole('button', { name: 'Apply' }).click();

    await editor.getByRole('tab', { name: /^Form/ }).click();
    await editor.getByRole('button', { name: 'Expand status property' }).click();
    await editor.getByRole('textbox', { name: 'Enum value 1 description' }).fill('Not yet visible');

    await jsonTab.click();
    await expect(await openJsonEditor(editor)).toHaveValue(
      /"oneOf":\s*\[\s*\{\s*"const":\s*"draft",\s*"description":\s*"Not yet visible"\s*\},\s*\{\s*"const":\s*"published"\s*\}\s*\]/,
    );

    await editor.getByRole('tab', { name: /^Form/ }).click();
    // Switching views remounts the form tree, collapsing the row again.
    await editor.getByRole('button', { name: 'Expand status property' }).click();
    await editor.getByRole('textbox', { name: 'Enum value 1 description' }).fill('');

    await jsonTab.click();
    await expect(await openJsonEditor(editor)).toHaveValue(
      /"enum":\s*\[\s*"draft",\s*"published"\s*\]/,
    );
    await expect(await openJsonEditor(editor)).not.toHaveValue(/oneOf/);
  });

  test('a real oneOf composition is unaffected by the enum-description promotion', async ({
    page,
  }) => {
    const editor = await openFirstEditor(page);
    const jsonTab = editor.getByRole('tab', { name: /JSON/ });
    await jsonTab.click();
    await fillJson(
      editor,
      '{"type":"object","properties":{"identifier":{"oneOf":[{"type":"string","pattern":"^[a-z]+$"},{"type":"integer","minimum":1}]}}}',
    );
    await editor.getByRole('button', { name: 'Apply' }).click();

    await editor.getByRole('tab', { name: /^Form/ }).click();
    await editor.getByRole('button', { name: 'Expand identifier property' }).click();

    // A real composition renders its branch editors, not the enum table.
    await expect(editor.getByRole('table', { name: 'Enum values' })).toHaveCount(0);
    await expect(editor.getByText('oneOf', { exact: true })).toBeVisible();
  });

  test('disabling an active bare enum does not delete an unrelated enum-shaped oneOf sitting alongside it', async ({
    page,
  }) => {
    const editor = await openFirstEditor(page);
    const jsonTab = editor.getByRole('tab', { name: /JSON/ });
    await jsonTab.click();
    // `enum` is the active representation (detectEnumSource prefers it), but
    // `oneOf` here happens to also satisfy the enum-shaped predicate even
    // though it is not what the enum table is reading from.
    await fillJson(
      editor,
      '{"type":"object","properties":{"status":{"type":"string","enum":["draft","published"],"oneOf":[{"const":"x"},{"const":"y"}]}}}',
    );
    await editor.getByRole('button', { name: 'Apply' }).click();

    await editor.getByRole('tab', { name: /^Form/ }).click();
    await editor.getByRole('button', { name: 'Expand status property' }).click();

    // Switch away from enum — this disables it via setEnum(false).
    await editor.getByRole('combobox', { name: 'status type' }).selectOption('number');

    await jsonTab.click();
    const draft = await jsonValue(editor);
    expect(draft).not.toContain('enum');
    expect(draft).toContain('"oneOf"');
    expect(draft).toContain('"const": "x"');
    expect(draft).toContain('"const": "y"');
  });

  test('typing an enum description does not clobber an unrelated real oneOf composition coexisting with a bare enum', async ({
    page,
  }) => {
    const editor = await openFirstEditor(page);
    const jsonTab = editor.getByRole('tab', { name: /JSON/ });
    await jsonTab.click();
    // `enum` is the active representation, but `oneOf` here is a REAL
    // composition (branches carry `type`), not an enum-shaped one.
    await fillJson(
      editor,
      '{"type":"object","properties":{"status":{"type":"string","enum":["draft","published"],"oneOf":[{"type":"string","pattern":"^[a-z]+$"},{"type":"integer","minimum":1}]}}}',
    );
    await editor.getByRole('button', { name: 'Apply' }).click();

    await editor.getByRole('tab', { name: /^Form/ }).click();
    await editor.getByRole('button', { name: 'Expand status property' }).click();
    await editor.getByRole('textbox', { name: 'Enum value 1 description' }).fill('Not yet visible');

    await jsonTab.click();
    const draft = await jsonValue(editor);
    // The real composition survives untouched.
    expect(draft).toContain('"pattern": "^[a-z]+$"');
    expect(draft).toContain('"minimum": 1');
    // The typed description could not be represented without destroying that
    // composition, so it is not silently written into a corrupted oneOf.
    expect(draft).not.toContain('Not yet visible');
  });

  test('expanding an array row shows an item-type selector; object items render a nested table, scalar items show inline', async ({
    page,
  }) => {
    const editor = await openFirstEditor(page);
    const jsonTab = editor.getByRole('tab', { name: /JSON/ });
    await jsonTab.click();
    await fillJson(
      editor,
      '{"type":"object","properties":{"tags":{"type":"array","items":{"type":"string"}},"addresses":{"type":"array","items":{"type":"object","properties":{"street":{"type":"string"}}}}}}',
    );
    await editor.getByRole('button', { name: 'Apply' }).click();
    await editor.getByRole('tab', { name: /^Form/ }).click();

    // Resting state: the outer table summarises item type inline.
    await expect(editor.getByRole('row', { name: /tags/ })).toContainText('array of string');
    await expect(editor.getByRole('row', { name: /addresses/ })).toContainText('array of object');

    // Expanding a scalar-item array reveals its own item-type selector,
    // scoped to the items schema (not the property itself) — hence "items
    // type", not "tags type".
    await editor.getByRole('button', { name: 'Expand tags property' }).click();
    await expect(editor.getByRole('combobox', { name: 'items type' })).toHaveValue('string');

    // Expanding an object-item array reveals a nested item schema table.
    await editor.getByRole('button', { name: 'Expand addresses property' }).click();
    await expect(editor.getByRole('table', { name: 'Properties of items' })).toBeVisible();
    await expect(editor.getByRole('row', { name: /street/ })).toBeVisible();
  });

  test('exactly one enabled toolbar action is in the tab order at rest', async ({ page }) => {
    const editor = await openFirstEditor(page);
    const toolbarRight = editor.locator('.cinder-jse-toolbar__right').first();
    await expect(toolbarRight).toBeVisible();

    const zeroTabIndexCount = await toolbarRight.evaluate((root) => {
      const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      return buttons.filter((button) => button.tabIndex === 0).length;
    });
    expect(zeroTabIndexCount).toBe(1);
  });

  test('arrow keys move focus between enabled toolbar actions and Tab exits', async ({ page }) => {
    const editor = await openFirstEditor(page);
    const toolbarRight = editor.locator('.cinder-jse-toolbar__right').first();
    await expect(toolbarRight).toBeVisible();

    // The default snapshot leaves Undo/Redo/Revert disabled, so only one action
    // is enabled. Type into the source editor to dirty the schema, which enables
    // Revert (and the Copy action stays enabled) — giving us ≥2 roving members.
    const jsonTab = editor.locator('[role="tab"]').filter({ hasText: /JSON/ }).first();
    await jsonTab.click();
    const textarea = await openJsonEditor(editor);
    await textarea.click();
    await textarea.press('End');
    await textarea.type(' ');

    const enabled = toolbarRight.locator('button:not([disabled])');
    const enabledCount = await enabled.count();

    // Focus the first enabled action and confirm it holds the roving tabstop.
    await enabled.first().focus();
    const firstContent = await enabled.first().textContent();
    const firstText = (firstContent ?? '').trim();

    if (enabledCount >= 2) {
      await page.keyboard.press('ArrowRight');
      const movedText = await toolbarRight.evaluate(
        (root) =>
          (root.contains(document.activeElement)
            ? document.activeElement instanceof HTMLElement
              ? document.activeElement.textContent?.trim()
              : undefined
            : '') ?? '',
      );
      expect(movedText).not.toBe(firstText);
      expect(movedText.length).toBeGreaterThan(0);

      // End jumps to the last enabled action; Home returns to the first.
      await page.keyboard.press('End');
      const endText = await page.evaluate(() =>
        document.activeElement instanceof HTMLElement
          ? (document.activeElement.textContent?.trim() ?? '')
          : '',
      );
      const lastContent = await enabled.last().textContent();
      expect(endText).toBe((lastContent ?? '').trim());

      await page.keyboard.press('Home');
      const homeText = await page.evaluate(() =>
        document.activeElement instanceof HTMLElement
          ? (document.activeElement.textContent?.trim() ?? '')
          : '',
      );
      expect(homeText).toBe(firstText);
    }

    // From any enabled action, Tab leaves the toolbar entirely.
    await enabled.first().focus();
    await page.keyboard.press('Tab');
    const focusInsideToolbar = await toolbarRight.evaluate((root) =>
      root.contains(document.activeElement),
    );
    expect(focusInsideToolbar).toBe(false);
  });

  test('expanding an object row reveals a nested properties table', async ({ page }) => {
    const editor = await openFirstEditor(page);
    const jsonTab = editor.getByRole('tab', { name: /JSON/ });
    await jsonTab.click();
    await fillJson(
      editor,
      '{"type":"object","properties":{"address":{"type":"object","properties":{"street":{"type":"string"},"city":{"type":"string"}}}}}',
    );
    await editor.getByRole('button', { name: 'Apply' }).click();
    await editor.getByRole('tab', { name: /^Form/ }).click();

    await expect(editor.getByRole('table')).toHaveCount(1);
    await editor.getByRole('button', { name: 'Expand address property' }).click();

    const nestedTable = editor.getByRole('table', { name: 'Properties of address' });
    await expect(nestedTable).toBeVisible();
    await expect(nestedTable.getByRole('rowheader', { name: /street/ })).toBeVisible();
    await expect(nestedTable.getByRole('rowheader', { name: /city/ })).toBeVisible();
  });

  test('a duplicate rename surfaces a validation alert', async ({ page }) => {
    const editor = await openFirstEditor(page);
    const jsonTab = editor.getByRole('tab', { name: /JSON/ });
    await jsonTab.click();
    await fillJson(
      editor,
      '{"type":"object","properties":{"email":{"type":"string"},"age":{"type":"integer"}}}',
    );
    await editor.getByRole('button', { name: 'Apply' }).click();
    await editor.getByRole('tab', { name: /^Form/ }).click();

    await editor.getByRole('button', { name: 'Expand age property' }).click();
    const nameInput = editor.getByRole('textbox', { name: 'Name', exact: true });
    await nameInput.fill('email');
    await nameInput.blur();

    await expect(editor.getByRole('alert')).toContainText('Duplicate property name: email');
  });

  test('form edits propagate to the JSON view', async ({ page }) => {
    const editor = await openFirstEditor(page);
    const jsonTab = editor.getByRole('tab', { name: /JSON/ });
    await jsonTab.click();
    await fillJson(
      editor,
      '{"type":"object","properties":{"age":{"type":"integer"},"email":{"type":"string"}}}',
    );
    await editor.getByRole('button', { name: 'Apply' }).click();
    await editor.getByRole('tab', { name: /^Form/ }).click();

    // Reorder in the form...
    const moveButton = editor.getByRole('button', { name: 'Move email up' });
    await expect(moveButton).toBeEnabled();
    await moveButton.click();
    const table = editor.getByRole('table', { name: 'Schema properties' });
    await expect(table.getByRole('row').nth(1)).toContainText('email');

    await jsonTab.click();
    // ...and confirm the JSON view reflects the new key order.
    const draft = await jsonValue(editor);
    expect(draft.indexOf('"email"')).toBeLessThan(draft.indexOf('"age"'));
  });
});
