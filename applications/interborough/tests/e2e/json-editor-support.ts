/**
 * Reading a JsonEditor from a spec.
 *
 * Once its CodeMirror view mounts, the editable area is a `role="textbox"` content element, not a
 * `<textarea>`, so `inputValue()` and `toHaveValue()` refuse it ("Not an input element"). The
 * exact source still lives in the field's native textarea, which stays in the form and posts, so
 * a spec reads that.
 *
 * Writing goes through {@link replaceJsonEditorText}, not `fill()`. `fill()` selects the editable
 * area's contents with a DOM range and inserts in the same step, before CodeMirror has taken that
 * range as its selection. On an editor that already has focus (a failed save puts the cursor on the
 * line the JSON stops at) the text lands at the old cursor, before the old text, instead of
 * replacing it. A person's selection, made by dragging or with Select all and then typed over,
 * replaces the text.
 */
import type { Locator } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * The editable area of the JsonEditor named `name` inside `scope`, once CodeMirror has taken the field over.
 *
 * Until its chunk loads, the field is a plain `<textarea>` with the same role and name. A locator
 * that resolves to it, and an action that starts on it, is stranded when the editor replaces it
 * and hides it, so the first interaction with a JsonEditor waits for the mounted editor.
 */
export async function jsonEditor(scope: Locator, name: string | RegExp): Promise<Locator> {
  const editor = scope.getByRole('textbox', { name });
  await expect(editor).toHaveAttribute('contenteditable', /^(true|false)$/);
  return editor;
}

/** The JSON source of the JsonEditor `editor` points at, whether or not its CodeMirror view has mounted. */
export async function jsonEditorSource(editor: Locator): Promise<string> {
  return editor.evaluate((element) => {
    if (element instanceof HTMLTextAreaElement) return element.value;
    const textarea = element.closest('.cinder-json-editor')?.querySelector('textarea');
    if (!textarea) throw new Error('The locator is not inside a JsonEditor.');
    return textarea.value;
  });
}

/**
 * Replaces everything in the JsonEditor `editor` points at with `text`, the way a person does it:
 * select all with the keyboard, then type. Waits until the field's source is exactly `text`.
 */
export async function replaceJsonEditorText(editor: Locator, text: string): Promise<void> {
  await editor.press('ControlOrMeta+a');
  if (text === '') await editor.press('Delete');
  else await editor.page().keyboard.insertText(text);
  await expect.poll(() => jsonEditorSource(editor)).toBe(text);
}
