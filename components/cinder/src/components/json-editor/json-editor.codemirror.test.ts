/// <reference lib="dom" />
import { describe, expect, mock, spyOn, test } from 'bun:test';

import { CompletionContext, type Completion } from '@codemirror/autocomplete';
import { json } from '@codemirror/lang-json';
import {
  ensureSyntaxTree,
  foldable,
  foldCode,
  foldedRanges,
  unfoldAll,
} from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { requiredInstance } from '@lostgradient/testing';
import { quietFor } from '@lostgradient/testing/wait-until';

import { formatJsonDocument } from './json-editor-enhancement.ts';
import { createSchemaCompletionSource } from './json-editor-schema-completion.ts';
import type { JsonEditorSchema } from './json-editor.types.ts';

const { fireEvent, render, waitFor } = await import('@testing-library/svelte');
const { default: JsonEditor } = await import('./json-editor.svelte');

type Rendered = { container: HTMLElement };

/** Wait for the lazily imported editor to mount and return its CodeMirror view. */
async function mountedView(view: Rendered): Promise<EditorView> {
  await waitFor(() => expect(view.container.querySelector('.cm-editor')).not.toBeNull());
  const editor = EditorView.findFromDOM(
    requiredInstance(view.container.querySelector('.cm-editor'), HTMLElement),
  );
  if (editor === null) throw new Error('The CodeMirror view was not found.');
  return editor;
}

function textareaOf(view: Rendered): HTMLTextAreaElement {
  return requiredInstance(view.container.querySelector('textarea'), HTMLTextAreaElement);
}

function typeInto(editor: EditorView, text: string): void {
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: text },
    userEvent: 'input.type',
  });
}

describe('JsonEditor — CodeMirror runtime', () => {
  test('keeps the textarea until the editor chunk loads, then replaces it', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: '{"a":1}' });

    expect(view.container.querySelector('.cm-editor')).toBeNull();
    expect(textareaOf(view).hidden).toBe(false);

    const editor = await mountedView(view);

    expect(editor.state.doc.toString()).toBe('{"a":1}');
    expect(view.container.querySelector('.cm-lineNumbers')).not.toBeNull();
    expect(view.container.querySelector('.cm-foldGutter')).not.toBeNull();
    // The editor sits inside the frame, under the toolbar: the frame owns border, radius and ring.
    const frame = requiredInstance(
      view.container.querySelector('.cinder-json-editor__input'),
      HTMLElement,
    );
    expect(frame.firstElementChild?.classList.contains('cinder-json-editor__toolbar')).toBe(true);
    expect(frame.querySelector('.cm-editor')).not.toBeNull();
    // The textarea stays in the form so the value still posts, but no longer shows.
    expect(textareaOf(view).hidden).toBe(true);
    expect(textareaOf(view).value).toBe('{"a":1}');
  });

  test('reports edits made in the editor and mirrors them into the posted textarea', async () => {
    const onValueChange = mock();
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      name: 'payload',
      value: '{}',
      onValueChange,
    });
    const editor = await mountedView(view);

    typeInto(editor, '{"edited":true}');

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith('{"edited":true}');
    await waitFor(() => expect(textareaOf(view).value).toBe('{"edited":true}'));
    expect(textareaOf(view).name).toBe('payload');
  });

  test('applies an external value change without reporting it as an edit', async () => {
    const onValueChange = mock();
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: '{"version":1}',
      onValueChange,
    });
    const editor = await mountedView(view);

    await view.rerender({ id: 'payload', label: 'Payload', value: '{"version":2}', onValueChange });

    expect(editor.state.doc.toString()).toBe('{"version":2}');
    expect(onValueChange).not.toHaveBeenCalled();
  });

  test('wires the editable area to the label, description, and feedback', async () => {
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      description: 'The request body.',
      value: '{',
    });
    const editor = await mountedView(view);
    const attributes = editor.contentDOM;

    await waitFor(() => expect(attributes.getAttribute('aria-invalid')).toBe('true'));
    expect(attributes.getAttribute('aria-labelledby')).toBe('payload-label');
    // The editor takes over the field id, so the label reaches it and nothing else matches.
    expect(attributes.id).toBe('payload');
    expect(textareaOf(view).id).toBe('payload-textarea');
    expect(view.getByLabelText('Payload')).toBe(attributes);
    expect(attributes.getAttribute('aria-describedby')).toBe('payload-description payload-status');
    expect(attributes.getAttribute('role')).toBe('textbox');
    expect(view.getByRole('status').textContent?.trim()).toBe('Line 1: unexpected end of the JSON');
  });

  test('forwards a click on the label into the editor', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: '{}' });
    const editor = await mountedView(view);
    const focus = mock();
    editor.contentDOM.focus = focus;

    await fireEvent.click(requiredInstance(view.container.querySelector('label'), HTMLElement));

    expect(focus).toHaveBeenCalled();
  });

  test('makes a disabled editor read-only and leaves the textarea disabled', async () => {
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: '{}',
      disabled: true,
    });
    const editor = await mountedView(view);

    expect(editor.contentDOM.getAttribute('contenteditable')).toBe('false');
    expect(textareaOf(view).disabled).toBe(true);
  });

  test('names the editable area as the one tab stop, and leaves a disabled editor out of the tab order', async () => {
    const enabled = await mountedView(
      render(JsonEditor, { id: 'enabled', label: 'Enabled', value: '{}' }),
    );
    expect(enabled.contentDOM.getAttribute('tabindex')).toBe('0');

    const disabled = await mountedView(
      render(JsonEditor, { id: 'off', label: 'Off', value: '{}', disabled: true }),
    );
    expect(disabled.contentDOM.hasAttribute('tabindex')).toBe(false);
  });

  test('forwards readonly to the editor: focusable and selectable but not editable', async () => {
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      name: 'payload',
      value: '{"a":1}',
      readonly: true,
    });
    const editor = await mountedView(view);

    expect(editor.state.readOnly).toBe(true);
    expect(editor.contentDOM.getAttribute('contenteditable')).toBe('true');
    expect(editor.contentDOM.getAttribute('aria-readonly')).toBe('true');
    expect(textareaOf(view).readOnly).toBe(true);
    expect(textareaOf(view).disabled).toBe(false);
  });

  test('applies readonly that changes while the editor stays mounted', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: '{}' });
    const editor = await mountedView(view);
    expect(editor.state.readOnly).toBe(false);

    await view.rerender({ id: 'payload', label: 'Payload', value: '{}', readonly: true });
    await waitFor(() => expect(editor.state.readOnly).toBe(true));

    await view.rerender({ id: 'payload', label: 'Payload', value: '{}', readonly: false });
    await waitFor(() => expect(editor.state.readOnly).toBe(false));
    expect(editor.contentDOM.hasAttribute('aria-readonly')).toBe(false);
  });

  test('keeps the required constraint on the posted textarea once the editor mounts', async () => {
    const form = document.createElement('form');
    form.id = 'required-form';
    document.body.append(form);
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      name: 'payload',
      form: form.id,
      value: '',
      required: true,
    });
    const editor = await mountedView(view);

    expect(textareaOf(view).required).toBe(true);
    expect(form.checkValidity()).toBe(false);

    typeInto(editor, '{}');
    await waitFor(() => expect(form.checkValidity()).toBe(true));
  });

  test('sends invalid-field focus to the visible editor, not the hidden textarea', async () => {
    const form = document.createElement('form');
    form.id = 'required-focus-form';
    document.body.append(form);
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      form: form.id,
      value: '',
      required: true,
    });
    const editor = await mountedView(view);
    const focus = spyOn(editor, 'focus');

    form.checkValidity();

    expect(focus).toHaveBeenCalled();
  });

  test('caps the height at the rows prop instead of reserving a large empty box', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: '{}', rows: 4 });
    await mountedView(view);

    const wrapper = requiredInstance(
      view.container.querySelector('.cinder-json-editor__input'),
      HTMLElement,
    );
    expect(wrapper.style.getPropertyValue('--_cinder-json-editor-rows')).toBe('4');
    expect(view.container.querySelector<HTMLElement>('.cm-editor')?.style.height).toBe('');
  });

  test('cancels a pending import when the editor unmounts first', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: '{}' });
    const host = requiredInstance(
      view.container.querySelector('.cinder-json-editor__editor'),
      HTMLElement,
    );
    view.unmount();
    // Let the import that was already started settle; nothing may be created in the detached host.
    await quietFor(50);
    expect(host.childElementCount).toBe(0);
  });
});

describe('JsonEditor — empty optional value', () => {
  test('is valid: no error, no valid message, no mark, and the toolbar reads Empty (row 29p)', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: '' });
    const editor = await mountedView(view);

    expect(view.queryByRole('alert')).toBeNull();
    expect(view.getByRole('status').textContent?.trim()).toBe('Empty');
    expect(textareaOf(view).getAttribute('aria-invalid')).toBeNull();
    expect(editor.contentDOM.getAttribute('aria-invalid')).toBeNull();
    expect(view.container.querySelector('.cinder-json-editor__line--problem')).toBeNull();
    // The muted body example, prefixed "e.g.", and no line numbers for a document of one line.
    expect(view.container.querySelector('.cm-placeholder')?.textContent).toBe(
      'e.g. { "key": "value" }',
    );
    expect(textareaOf(view).placeholder).toBe('e.g. { "key": "value" }');
    expect(view.container.querySelector('.cm-editor')?.classList).toContain(
      'cinder-json-editor__cm--single-line',
    );
    expect((view.getByRole('button', { name: 'Format' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('shows the example the caller gives after "e.g."', async () => {
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: '',
      example: '{ "defaultTimeoutSeconds": 300 }',
    });
    await mountedView(view);

    expect(view.container.querySelector('.cm-placeholder')?.textContent).toBe(
      'e.g. { "defaultTimeoutSeconds": 300 }',
    );
  });

  test('a placeholder replaces the whole example text', async () => {
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: '',
      placeholder: 'Paste JSON',
    });
    await mountedView(view);

    expect(view.container.querySelector('.cm-placeholder')?.textContent).toBe('Paste JSON');
  });

  test('stays valid while whitespace only', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: '  \n ' });
    await mountedView(view);

    expect(view.queryByRole('alert')).toBeNull();
    expect(textareaOf(view).getAttribute('aria-invalid')).toBeNull();
  });

  test('is still an error when the field is required', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: '', required: true });
    const editor = await mountedView(view);

    expect(view.getByRole('status').textContent?.trim()).toBe('Enter valid JSON');
    expect(editor.contentDOM.getAttribute('aria-required')).toBe('true');
    // The hidden textarea keeps the native constraint so an empty required field blocks submit.
    expect(textareaOf(view).required).toBe(true);
  });

  test('is an error again as soon as the user types invalid JSON', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: '' });
    const editor = await mountedView(view);

    typeInto(editor, '{');

    await waitFor(() =>
      expect(view.getByRole('status').textContent?.trim()).toBe(
        'Line 1: unexpected end of the JSON',
      ),
    );
  });
});

describe('JsonEditor — toolbar status (rows 29q, 29u, 29v)', () => {
  const sample = '{\n  "mode": "ask",\n  "timeoutSeconds": 600\n}';

  test('a valid document reads Valid JSON in the success tone, with the gutter and an enabled Format', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: sample });
    const editor = await mountedView(view);

    const status = view.getByRole('status');
    expect(status.textContent?.trim()).toBe('Valid JSON');
    expect(status.classList).toContain('cinder-json-editor__status--success');
    expect(status.querySelector('svg')).not.toBeNull();
    expect((view.getByRole('button', { name: 'Format' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    // Two or more lines: the gutter is drawn.
    expect(editor.dom.classList).not.toContain('cinder-json-editor__cm--single-line');
  });

  test('the gutter appears when a second line is typed and goes when the document is one line again', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: '{}' });
    const editor = await mountedView(view);
    expect(editor.dom.classList).toContain('cinder-json-editor__cm--single-line');

    typeInto(editor, '{\n}');
    expect(editor.dom.classList).not.toContain('cinder-json-editor__cm--single-line');

    typeInto(editor, '{}');
    expect(editor.dom.classList).toContain('cinder-json-editor__cm--single-line');
  });

  test('read only shows a lock and "Read only" and has no Format button', async () => {
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: sample,
      readonly: true,
    });
    await mountedView(view);

    const status = view.getByRole('status');
    expect(status.textContent?.trim()).toBe('Read only');
    expect(status.querySelector('svg')).not.toBeNull();
    expect(view.queryByRole('button', { name: 'Format' })).toBeNull();
    expect(view.container.querySelector('.cm-content')?.textContent).toContain('"mode"');
  });

  test('disabled keeps the JSON tag and the Valid JSON status, with Format off and no focus', async () => {
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: sample,
      disabled: true,
    });
    const editor = await mountedView(view);

    expect(view.container.querySelector('.cinder-json-editor__tag')?.textContent).toBe('JSON');
    expect(view.getByRole('status').textContent?.trim()).toBe('Valid JSON');
    expect((view.getByRole('button', { name: 'Format' }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.container.querySelector('.cinder-json-editor__input--disabled')).not.toBeNull();
    expect(editor.contentDOM.hasAttribute('tabindex')).toBe(false);
  });

  test('a caller status label replaces Valid JSON while the source parses, and never an invalid status', async () => {
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: sample,
      statusLabel: 'Valid JSON, not a valid workflow',
    });
    await mountedView(view);
    expect(view.getByRole('status').textContent?.trim()).toBe('Valid JSON, not a valid workflow');

    await view.rerender({
      id: 'payload',
      label: 'Payload',
      value: '{',
      statusLabel: 'Valid JSON, not a valid workflow',
    });
    await waitFor(() =>
      expect(view.getByRole('status').textContent?.trim()).toBe(
        'Line 1: unexpected end of the JSON',
      ),
    );
  });
});

describe('JsonEditor — marked lines', () => {
  const missingComma = '{\n  "mode": "ask"\n  "timeoutSeconds": 600\n}';

  test('marks the line that ends without its comma, not the line the parser stops at (rows 29r, 57x, 65h)', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: missingComma });
    await mountedView(view);

    const marked = [...view.container.querySelectorAll('.cinder-json-editor__line--problem')];
    expect(marked.map((line) => line.textContent)).toEqual(['  "mode": "ask"']);
    const message = view.container.querySelector('.cinder-json-editor__problem');
    expect(message?.textContent).toBe('Missing comma at the end of this line.');
    expect(message?.querySelector('svg')).not.toBeNull();
    // The line number turns red: the gutter element of that line carries the problem class.
    const gutter = [...view.container.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].filter(
      (element) => element.classList.contains('cinder-json-editor__gutter--problem'),
    );
    expect(gutter.map((element) => element.textContent)).toEqual(['2']);
  });

  test('the toolbar message names the line and is a button that jumps to it (row 29r)', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: missingComma });
    const editor = await mountedView(view);

    const jump = view.getByRole('button', { name: 'Line 2: expected a comma' });
    expect(view.getByRole('status').classList).toContain('cinder-json-editor__status--danger');
    await fireEvent.click(jump);

    expect(editor.state.doc.lineAt(editor.state.selection.main.head).number).toBe(2);
    expect(editor.state.selection.main.head).toBe(editor.state.doc.line(2).from);
  });

  test('Format is off while the JSON is invalid, and nothing else changes the document', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: missingComma });
    const editor = await mountedView(view);

    expect((view.getByRole('button', { name: 'Format' }) as HTMLButtonElement).disabled).toBe(true);
    expect(editor.state.doc.toString()).toBe(missingComma);
  });

  test('moves the mark as the user fixes and breaks the document', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: missingComma });
    const editor = await mountedView(view);

    typeInto(editor, '{\n  "mode": "ask",\n  "timeoutSeconds": 600\n}');
    await waitFor(() =>
      expect(view.container.querySelectorAll('.cinder-json-editor__line--problem').length).toBe(0),
    );
    expect(view.container.querySelector('.cinder-json-editor__problem')).toBeNull();

    typeInto(editor, '{\n  "a": 1,\n  "b": [1\n  2]\n}');
    await waitFor(() =>
      expect(view.container.querySelector('.cinder-json-editor__line--problem')?.textContent).toBe(
        '  "b": [1',
      ),
    );
  });

  test('marks the lines a caller reports for a document that parses, with their messages (row 65y)', async () => {
    const lines = ['{', '  "agent": "release-helper",', '  "message": "Post it."', '}'];
    const message = 'No agent with the ID release-helper is available.';
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: lines.join('\n'),
      statusLabel: 'Valid JSON, not a valid workflow',
      diagnostics: [{ line: 2, message }],
    });
    await mountedView(view);

    expect(view.container.querySelector('.cinder-json-editor__line--problem')?.textContent).toBe(
      '  "agent": "release-helper",',
    );
    expect(view.container.querySelector('.cinder-json-editor__problem')?.textContent).toBe(message);
    expect(view.getByRole('status').textContent?.trim()).toBe('Valid JSON, not a valid workflow');
  });

  test('ignores a caller line that is past the end of the document', async () => {
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: '{\n}',
      diagnostics: [{ line: 9, message: 'Nowhere.' }],
    });
    await mountedView(view);

    expect(view.container.querySelector('.cinder-json-editor__problem')).toBeNull();
  });

  test('focusProblem and focusLine take the caret to the marked line', async () => {
    let component: { focusLine: (line: number) => void; focusProblem: () => void } | undefined;
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: missingComma });
    component = view.component as unknown as typeof component;
    const editor = await mountedView(view);

    component?.focusProblem();
    expect(editor.state.doc.lineAt(editor.state.selection.main.head).number).toBe(2);

    component?.focusLine(4);
    expect(editor.state.doc.lineAt(editor.state.selection.main.head).number).toBe(4);
    component?.focusLine(99);
    expect(editor.state.doc.lineAt(editor.state.selection.main.head).number).toBe(4);
  });

  test('focusProblem finds the parse problem even while an external error keeps the editor from marking it (row 80n)', async () => {
    const source = '{\n  "dismissed": true,\n  "dismissedOn": "2026-11-01",\n}';
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: source,
      error: 'Unexpected token } at line 4. Fix the JSON to save.',
    });
    const editor = await mountedView(view);

    (view.component as unknown as { focusProblem: () => void }).focusProblem();

    // The trailing comma is on line 3, though the parser stops at the brace on line 4.
    expect(editor.state.doc.lineAt(editor.state.selection.main.head).number).toBe(3);
  });

  test('focusProblem with nothing marked focuses the editor', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: '{}' });
    const editor = await mountedView(view);
    const focus = spyOn(editor, 'focus');

    (view.component as unknown as { focusProblem: () => void }).focusProblem();

    expect(focus).toHaveBeenCalled();
  });

  test('focusLine puts the caret on the line in the textarea fallback before the editor loads', () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: missingComma });

    (view.component as unknown as { focusLine: (line: number) => void }).focusLine(3);

    const textarea = textareaOf(view);
    expect(textarea.selectionStart).toBe(missingComma.indexOf('  "timeoutSeconds"'));
  });

  test('an external error turns the frame red and renders its message with a glyph under the field (row 80n)', async () => {
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: '{\n  "dismissed": true,\n}',
      error: 'Unexpected token } at line 4. Fix the JSON to save.',
    });
    await mountedView(view);

    expect(view.container.querySelector('.cinder-json-editor__input--invalid')).not.toBeNull();
    const alert = view.getByRole('alert');
    expect(alert.textContent?.trim()).toBe('Unexpected token } at line 4. Fix the JSON to save.');
    expect(alert.querySelector('svg')).not.toBeNull();
    // Save stays the caller's: the editor does not parse, so it adds no mark of its own.
    expect(view.container.querySelector('.cinder-json-editor__line--problem')).toBeNull();
  });

  test('a parse problem alone does not turn the frame red: it is marked at its line', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: missingComma });
    await mountedView(view);

    expect(view.container.querySelector('.cinder-json-editor__input--invalid')).toBeNull();
  });
});

describe('JsonEditor — long lines and height (rows 05l, 29o, 29y)', () => {
  const longLine = `{\n  "description": "${'A very long line of text that goes on. '.repeat(20)}"\n}`;

  test('lines scroll sideways by default, with no wrapping, and the gutter does not move', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: longLine });
    const editor = await mountedView(view);

    expect(editor.contentDOM.classList).not.toContain('cm-lineWrapping');
    expect(textareaOf(view).getAttribute('wrap')).toBe('off');
  });

  test('wrap="soft" always wraps and wrap="off" never does', async () => {
    const soft = await mountedView(
      render(JsonEditor, { id: 'soft', label: 'Soft', value: longLine, wrap: 'soft' }),
    );
    expect(soft.contentDOM.classList).toContain('cm-lineWrapping');

    const off = await mountedView(
      render(JsonEditor, { id: 'off', label: 'Off', value: longLine, wrap: 'off' }),
    );
    expect(off.contentDOM.classList).not.toContain('cm-lineWrapping');
  });

  test('the theme carries a three-row minimum, the rows maximum, and a visible scrollbar', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: '{}', rows: 4 });
    await mountedView(view);

    const rules = [...document.querySelectorAll('style')]
      .map((style) => style.textContent ?? '')
      .join('\n');
    expect(rules).toContain('max-height: calc(var(--_cinder-json-editor-rows, 8) * 1.5em');
    expect(rules).toContain('min-height: calc(3 * 1.5em');
    expect(rules).toContain('.cm-scroller::-webkit-scrollbar');
    expect(rules).toContain('scrollbar-color: var(--cinder-scrollbar-thumb)');
  });
});

describe('JsonEditor — folding', () => {
  const source = '{\n  "outer": {\n    "inner": [1, 2]\n  },\n  "other": true\n}';

  test('folds and unfolds an object through the fold commands', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: source });
    const editor = await mountedView(view);
    const firstLine = editor.state.doc.line(1);

    expect(foldable(editor.state, firstLine.from, firstLine.to)).not.toBeNull();
    editor.dispatch({ selection: { anchor: firstLine.from } });
    expect(foldCode(editor)).toBe(true);
    expect(foldedRanges(editor.state).size).toBe(1);

    unfoldAll(editor);
    expect(foldedRanges(editor.state).size).toBe(0);
  });
});

describe('JsonEditor — format', () => {
  test('the Format button pretty-prints valid JSON and reports it as an edit', async () => {
    const onValueChange = mock();
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: '{"a":1,"b":[1,2]}',
      onValueChange,
    });
    const editor = await mountedView(view);

    await fireEvent.click(view.getByRole('button', { name: 'Format' }));

    const formatted = JSON.stringify({ a: 1, b: [1, 2] }, null, 2);
    expect(editor.state.doc.toString()).toBe(formatted);
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith(formatted);
    await waitFor(() => expect(textareaOf(view).value).toBe(formatted));
  });

  test('is disabled for empty and invalid JSON and leaves the document alone', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: '' });
    const editor = await mountedView(view);
    const button = view.getByRole('button', { name: 'Format' });

    expect((button as HTMLButtonElement).disabled).toBe(true);
    typeInto(editor, '{');
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    expect(formatJsonDocument(editor)).toBe(false);
    expect(editor.state.doc.toString()).toBe('{');
  });

  test('formats from the keyboard with Shift+Alt+F', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: '{"a":1}' });
    const editor = await mountedView(view);

    const event = new KeyboardEvent('keydown', {
      key: 'F',
      code: 'KeyF',
      shiftKey: true,
      altKey: true,
    });
    // CodeMirror resolves letter keys from the legacy key code, which the event initializer omits.
    Object.defineProperty(event, 'keyCode', { value: 70 });
    const handled = runScopeHandlers(editor, event, 'editor');
    expect(handled).toBe(true);

    expect(editor.state.doc.toString()).toBe('{\n  "a": 1\n}');
  });

  test('Format does nothing for a read-only value, by button, command, or keyboard', async () => {
    const onValueChange = mock();
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: '{"a":1}',
      readonly: true,
      onValueChange,
    });
    const editor = await mountedView(view);

    expect(view.queryByRole('button', { name: 'Format' })).toBeNull();
    expect(formatJsonDocument(editor)).toBe(false);
    const event = new KeyboardEvent('keydown', {
      key: 'F',
      code: 'KeyF',
      shiftKey: true,
      altKey: true,
    });
    Object.defineProperty(event, 'keyCode', { value: 70 });
    runScopeHandlers(editor, event, 'editor');

    expect(editor.state.doc.toString()).toBe('{"a":1}');
    expect(onValueChange).not.toHaveBeenCalled();
  });

  test('Format leaves a read-only textarea fallback alone', async () => {
    const onValueChange = mock();
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: '{"a":1}',
      readonly: true,
      onValueChange,
    });

    expect(view.queryByRole('button', { name: 'Format' })).toBeNull();
    expect(textareaOf(view).value).toBe('{"a":1}');
    expect(onValueChange).not.toHaveBeenCalled();
  });

  test('formats the textarea fallback when the editor has not loaded', async () => {
    const onValueChange = mock();
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: '{"a":1}',
      onValueChange,
    });

    await fireEvent.click(view.getByRole('button', { name: 'Format' }));

    expect(onValueChange).toHaveBeenCalledWith('{\n  "a": 1\n}');
    expect(textareaOf(view).value).toBe('{\n  "a": 1\n}');
  });

  test('does not leave Tab bound, so keyboard users can leave the editor', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: '{}' });
    const editor = await mountedView(view);

    const event = new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab' });
    Object.defineProperty(event, 'keyCode', { value: 9 });
    const handled = runScopeHandlers(editor, event, 'editor');

    expect(handled).toBe(false);
  });
});

describe('JsonEditor — schema completion', () => {
  const schema: JsonEditorSchema = {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Display name.' },
      mode: { type: 'string', enum: ['fast', 'safe'] },
      enabled: { type: 'boolean' },
      nested: { $ref: '#/$defs/nested' },
      list: {
        type: 'array',
        items: { type: 'object', properties: { kind: { enum: ['a', 'b'] } } },
      },
    },
    $defs: {
      nested: { type: 'object', properties: { depth: { type: 'number' }, tag: { const: 'x' } } },
    },
  };

  /** Run the schema source at the `|` marker of a document and return its options. */
  function completeAt(
    marked: string,
    explicit = true,
    source: JsonEditorSchema = schema,
  ): readonly Completion[] {
    const position = marked.indexOf('|');
    const document = marked.replace('|', '');
    const state = EditorState.create({ doc: document, extensions: [json()] });
    ensureSyntaxTree(state, state.doc.length, 5000);
    const result = createSchemaCompletionSource(source)(
      new CompletionContext(state, position, explicit),
    );
    return (result instanceof Promise ? [] : result?.options) ?? [];
  }

  const labels = (options: readonly Completion[]): string[] =>
    options.map((option) => option.label);

  test('offers the schema property names inside an empty object', () => {
    expect(labels(completeAt('{|}'))).toEqual(['name', 'mode', 'enabled', 'nested', 'list']);
  });

  test('waits for a typed character unless completion was requested', () => {
    expect(completeAt('{|}', false)).toEqual([]);
    expect(labels(completeAt('{"mo|}', false))).toContain('mode');
  });

  test('omits properties the object already holds', () => {
    expect(labels(completeAt('{"name": "a", |}'))).not.toContain('name');
  });

  test('offers enum values where a value belongs', () => {
    expect(labels(completeAt('{"mode": |}'))).toEqual(['"fast"', '"safe"']);
    expect(labels(completeAt('{"mode": "f|"}'))).toEqual(['"fast"', '"safe"']);
  });

  test('offers true and false for a boolean property', () => {
    expect(labels(completeAt('{"enabled": |}'))).toEqual(['true', 'false']);
  });

  test('follows local references and array items', () => {
    expect(labels(completeAt('{"nested": {|}}'))).toEqual(['depth', 'tag']);
    expect(labels(completeAt('{"nested": {"tag": |}}'))).toEqual(['"x"']);
    expect(labels(completeAt('{"list": [{|}]}'))).toEqual(['kind']);
    expect(labels(completeAt('{"list": [{"kind": |}]}'))).toEqual(['"a"', '"b"']);
  });

  test('offers nothing where the schema is silent', () => {
    expect(completeAt('{"unknown": {|}}')).toEqual([]);
    expect(completeAt('{"name": |}')).toEqual([]);
  });

  test('merges the properties of allOf, anyOf and oneOf members', () => {
    const combined: JsonEditorSchema = {
      allOf: [{ properties: { viaAll: { type: 'string' } } }],
      anyOf: [{ properties: { viaAny: { type: 'string' } } }],
      oneOf: [{ properties: { viaOne: { type: 'string' } } }],
    };
    expect(labels(completeAt('{|}', true, combined))).toEqual(['viaAll', 'viaAny', 'viaOne']);
  });

  test('falls back to the additionalProperties schema for a key the schema does not name', () => {
    const open: JsonEditorSchema = {
      properties: { known: { type: 'string' } },
      additionalProperties: { type: 'object', properties: { deep: { type: 'boolean' } } },
    };
    expect(labels(completeAt('{"anything": {|}}', true, open))).toEqual(['deep']);
    expect(labels(completeAt('{"known": {|}}', true, open))).toEqual([]);
  });

  describe('where a property key cannot be read', () => {
    // `"a\q"` is not a JSON string, so the key of this property cannot be decoded and nothing
    // below it can be tied to a schema.
    test('offers nothing for a value, a delimiter, or a bare word below it', () => {
      expect(completeAt('{"a\\q": 1|}')).toEqual([]);
      expect(completeAt('{"a\\q": |1}')).toEqual([]);
      expect(completeAt('{"a\\q": [|]}')).toEqual([]);
      expect(completeAt('{"a\\q": [1 |]}')).toEqual([]);
      expect(completeAt('{"a\\q": [f|]}')).toEqual([]);
      expect(completeAt('{"a\\q": {|}}')).toEqual([]);
    });
  });

  test('offers values right after a colon or an opening bracket', () => {
    expect(labels(completeAt('{"mode":|}'))).toEqual(['"fast"', '"safe"']);
    expect(labels(completeAt('{"list": [|]}'))).toEqual([]);
    const numbers: JsonEditorSchema = { type: 'array', items: { enum: [1, 2] } };
    expect(labels(completeAt('[|]', true, numbers))).toEqual(['1', '2']);
    expect(labels(completeAt('[1,|]', true, numbers))).toEqual(['1', '2']);
  });

  test('offers values for a bare word being typed beside a key or inside an array', () => {
    expect(labels(completeAt('{"mode": f|}'))).toEqual(['"fast"', '"safe"']);
    const numbers: JsonEditorSchema = { type: 'array', items: { enum: [1, 2] } };
    expect(labels(completeAt('[f|]', true, numbers))).toEqual(['1', '2']);
  });

  test('completes a key while the cursor sits inside a complete key', () => {
    expect(labels(completeAt('{"mo|de": 1}'))).toEqual(['name', 'enabled', 'nested', 'list']);
  });

  test('offers nothing for a stray value that no property or array holds', () => {
    expect(completeAt('{1|}')).toEqual([]);
    expect(completeAt('{true|}')).toEqual([]);
  });

  describe('at the document root', () => {
    const rootSchema: JsonEditorSchema = { enum: ['fast', 'safe'] };

    test('offers the root enum in an empty document', () => {
      expect(labels(completeAt('|', true, rootSchema))).toEqual(['"fast"', '"safe"']);
      expect(labels(completeAt('  |', true, rootSchema))).toEqual(['"fast"', '"safe"']);
    });

    test('waits for a typed character in an empty document unless completion was requested', () => {
      expect(completeAt('|', false, rootSchema)).toEqual([]);
    });

    test('offers the root enum for a string and for a bare word being typed', () => {
      expect(labels(completeAt('"f|"', true, rootSchema))).toEqual(['"fast"', '"safe"']);
      expect(labels(completeAt('"f|', false, rootSchema))).toEqual(['"fast"', '"safe"']);
      expect(labels(completeAt('f|', false, rootSchema))).toEqual(['"fast"', '"safe"']);
    });

    test('offers true and false for a root boolean', () => {
      expect(labels(completeAt('|', true, { type: 'boolean' }))).toEqual(['true', 'false']);
    });

    test('offers nothing once the root already holds a value the cursor is not in', () => {
      expect(completeAt('{} |', true, rootSchema)).toEqual([]);
      expect(completeAt('"fast" |', true, rootSchema)).toEqual([]);
    });
  });

  test('survives a reference cycle', () => {
    const cyclic: JsonEditorSchema = { $defs: {}, $ref: '#/$defs/loop' };
    cyclic.$defs = { loop: { $ref: '#/$defs/loop' } };
    const state = EditorState.create({ doc: '{}', extensions: [json()] });
    ensureSyntaxTree(state, 2, 5000);
    expect(createSchemaCompletionSource(cyclic)(new CompletionContext(state, 1, true))).toBeNull();
  });

  test('inserts a quoted key with its colon, replacing what was typed', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: '{"mo}', schema });
    const editor = await mountedView(view);
    const source = createSchemaCompletionSource(schema);
    const result = source(new CompletionContext(editor.state, 4, true));
    const option = (result instanceof Promise ? undefined : result)?.options.find(
      (candidate) => candidate.label === 'mode',
    );
    if (typeof option?.apply !== 'function')
      throw new Error('Expected a completion that applies itself.');

    option.apply(editor, option, 2, 4);

    expect(editor.state.doc.toString()).toBe('{"mode": }');
  });

  test('inserts an enum value in place of the token under the cursor', async () => {
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: '{"mode": "f"}',
      schema,
    });
    const editor = await mountedView(view);
    const source = createSchemaCompletionSource(schema);
    const result = source(new CompletionContext(editor.state, 11, true));
    const option = (result instanceof Promise ? undefined : result)?.options.find(
      (candidate) => candidate.label === '"safe"',
    );
    if (typeof option?.apply !== 'function')
      throw new Error('Expected a completion that applies itself.');

    option.apply(editor, option, 9, 11);

    expect(editor.state.doc.toString()).toBe('{"mode": "safe"}');
  });

  test('registers completion only when a schema is provided', async () => {
    const without = render(JsonEditor, { id: 'plain', label: 'Plain', value: '{}' });
    const plain = await mountedView(without);
    expect(plain.contentDOM.getAttribute('aria-autocomplete')).toBeNull();

    const withSchema = render(JsonEditor, { id: 'typed', label: 'Typed', value: '{}', schema });
    const typed = await mountedView(withSchema);
    expect(typed.contentDOM.getAttribute('aria-autocomplete')).toBe('list');
  });
});
