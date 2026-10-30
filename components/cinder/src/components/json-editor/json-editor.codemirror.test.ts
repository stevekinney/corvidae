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
import { diagnosticCount, forceLinting } from '@codemirror/lint';
import { EditorState } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { requiredInstance } from '@lostgradient/testing';
import { quietFor } from '@lostgradient/testing/wait-until';

import { formatJsonDocument, lintJsonDocument } from './json-editor-enhancement.ts';
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
    expect(attributes.getAttribute('aria-describedby')).toBe(
      'payload-description payload-feedback',
    );
    expect(attributes.getAttribute('role')).toBe('textbox');
    expect(view.getByRole('alert').textContent).toBe('Enter valid JSON.');
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
  test('is valid: no error, no valid message, no lint glyph, and it reads Not set', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: '' });
    const editor = await mountedView(view);
    forceLinting(editor);

    expect(view.queryByRole('alert')).toBeNull();
    expect(view.queryByRole('status')).toBeNull();
    expect(textareaOf(view).getAttribute('aria-invalid')).toBeNull();
    expect(editor.contentDOM.getAttribute('aria-invalid')).toBeNull();
    expect(diagnosticCount(editor.state)).toBe(0);
    expect(view.container.querySelector('.cm-lint-marker')).toBeNull();
    expect(view.container.querySelector('.cm-placeholder')?.textContent).toBe('Not set');
    expect(textareaOf(view).placeholder).toBe('Not set');
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

    expect(view.getByRole('alert').textContent).toBe('Enter valid JSON.');
    expect(editor.contentDOM.getAttribute('aria-required')).toBe('true');
    expect(textareaOf(view).placeholder).toBe('');
    // The hidden textarea keeps the native constraint so an empty required field blocks submit.
    expect(textareaOf(view).required).toBe(true);
  });

  test('is an error again as soon as the user types invalid JSON', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: '' });
    const editor = await mountedView(view);

    typeInto(editor, '{');

    await waitFor(() => expect(view.getByRole('alert').textContent).toBe('Enter valid JSON.'));
  });
});

describe('JsonEditor — inline lint', () => {
  test('marks the position of a syntax error', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: '{"a": }' });
    const editor = await mountedView(view);
    forceLinting(editor);

    await waitFor(() => expect(diagnosticCount(editor.state)).toBe(1));
    const [diagnostic] = lintJsonDocument(editor);
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.from).toBeLessThan(editor.state.doc.length);
  });

  test('clears when the document becomes valid', async () => {
    const view = render(JsonEditor, { id: 'payload', label: 'Payload', value: '{' });
    const editor = await mountedView(view);
    forceLinting(editor);
    await waitFor(() => expect(diagnosticCount(editor.state)).toBe(1));

    typeInto(editor, '{}');
    forceLinting(editor);

    await waitFor(() => expect(diagnosticCount(editor.state)).toBe(0));
  });

  test('maps a line and column message to a document offset', () => {
    const editor = new EditorView({ state: EditorState.create({ doc: 'aa\nbb\ncc' }) });
    const parse = spyOn(JSON, 'parse').mockImplementation(() => {
      throw new SyntaxError('JSON Parse error: line 3 column 2');
    });
    try {
      expect(lintJsonDocument(editor)[0]?.from).toBe(7);
    } finally {
      parse.mockRestore();
      editor.destroy();
    }
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

    expect((view.getByRole('button', { name: 'Format' }) as HTMLButtonElement).disabled).toBe(true);
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

    expect((view.getByRole('button', { name: 'Format' }) as HTMLButtonElement).disabled).toBe(true);
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
