/// <reference lib="dom" />
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

import {
  prepareSvelteServerSource,
  renderSvelteOnServer,
  requiredInstance,
  setupHappyDom,
} from '@lostgradient/testing';
import { injectStrippedStyles } from '../../test/css.ts';

setupHappyDom();

const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/svelte');
const { default: JsonEditor } = await import('./json-editor.svelte');
const { default: schema } = await import('./json-editor.schema.ts');
const jsonEditorSource = new URL('./json-editor.svelte', import.meta.url).pathname;
await prepareSvelteServerSource(jsonEditorSource);
// Server rendering spawns a Bun process, so it runs once at module scope, off bun's per-test clock.
const autofocusServerHtml = new Map(
  await Promise.all(
    [false, true].map(
      async (autofocus) =>
        [
          autofocus,
          await renderSvelteOnServer(jsonEditorSource, {
            id: 'server-autofocus',
            label: 'Payload',
            value: '{}',
            autofocus,
          }),
        ] as const,
    ),
  ),
);

/** The native textarea, which stays the source of truth for form posting once the editor loads. */
function textareaOf(view: { container: HTMLElement }): HTMLTextAreaElement {
  return requiredInstance(view.container.querySelector('textarea'), HTMLTextAreaElement);
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('JsonEditor', () => {
  test.each([false, true])(
    'preserves native autofocus=%s in server-rendered markup',
    (autofocus) => {
      const html = autofocusServerHtml.get(autofocus) ?? '';
      expect(/<textarea\b[^>]*\sautofocus(?:[\s=>])/.test(html)).toBe(autofocus);
    },
  );

  test('the error live region is mounted before any error is set (CIN-315: FormFieldFrame defaults to errorMountedOnDemand=false)', () => {
    const { container } = render(JsonEditor, {
      id: 'no-error-yet-json',
      label: 'Payload',
      value: '{}',
    });
    expect(container.querySelector('.cinder-form-field__error')).not.toBeNull();
  });

  test('the errorless live region has no layout footprint (shared _form-field-error.css, CIN-315 follow-up)', async () => {
    const jsonEditorCss = await Bun.file(new URL('./json-editor.css', import.meta.url)).text();
    const sharedErrorCss = await Bun.file(
      new URL('../../styles/components/_form-field-error.css', import.meta.url),
    ).text();
    const removeStyles = injectStrippedStyles(jsonEditorCss, sharedErrorCss);
    try {
      const { container } = render(JsonEditor, {
        id: 'no-error-computed-json',
        label: 'Payload',
        value: '{}',
      });
      const errorRegion = container.querySelector('.cinder-form-field__error');
      expect(errorRegion).not.toBeNull();
      const computed = getComputedStyle(errorRegion as Element);
      // Sr-only pattern (CIN-315 review follow-up), not visibility:hidden —
      // visibility:hidden removes an element from the accessibility tree
      // (navigation-bar.a11y.md), which would defeat the announcement fix.
      expect(computed.position).toBe('absolute');
      expect(computed.visibility).not.toBe('hidden');
      expect(computed.display).not.toBe('none');
      expect(computed.clip).toBe('rect(0, 0, 0, 0)');
    } finally {
      removeStyles();
    }
  });

  test('documents supported native validation and disabled props in its public schema', () => {
    expect(schema.properties).toHaveProperty('disabled');
    expect(schema.properties).toHaveProperty('required');
  });

  test('emits each proposed string value without taking ownership of controlled state', async () => {
    const onValueChange = mock();
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: '{"before":true}',
      onValueChange,
    });

    const editor = textareaOf(view);
    await fireEvent.input(editor, { target: { value: '{"after":true}' } });

    expect(onValueChange).toHaveBeenCalledWith('{"after":true}');
  });

  test('synchronizes the native textarea when the external value changes', async () => {
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: '{"version":1}',
    });

    await view.rerender({
      id: 'payload',
      label: 'Payload',
      value: '{"version":2}',
    });

    expect(textareaOf(view).value).toBe('{"version":2}');
  });

  test('synchronizes parse feedback after a native form reset', async () => {
    const form = document.createElement('form');
    form.id = 'payload-form';
    document.body.append(form);
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: '{}',
      defaultValue: '{}',
      form: form.id,
    });
    const editor = textareaOf(view);

    await fireEvent.input(editor, { target: { value: '{' } });
    expect(editor.getAttribute('aria-invalid')).toBe('true');

    form.reset();
    await waitFor(() => {
      expect(editor.value).toBe('{}');
      expect(editor.hasAttribute('aria-invalid')).toBe(false);
      expect(view.getByRole('status').textContent).toBe('Valid JSON.');
    });
  });

  test('announces valid JSON and wires the description to the textarea', () => {
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      description: 'Enter the request body.',
      value: '{"valid":true}',
    });

    const editor = textareaOf(view);
    const description = view.getByText('Enter the request body.');
    const status = view.getByRole('status');

    expect(status.textContent).toBe('Valid JSON.');
    expect(editor.getAttribute('aria-invalid')).toBeNull();
    expect(editor.getAttribute('aria-describedby')?.split(' ')).toEqual([
      description.id,
      status.id,
    ]);
  });

  test('announces invalid JSON and gives an external error precedence', async () => {
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: '{',
    });

    const editor = textareaOf(view);
    expect(editor.getAttribute('aria-invalid')).toBe('true');
    expect(view.getByRole('alert').textContent).toBe('Enter valid JSON.');

    await view.rerender({
      id: 'payload',
      label: 'Payload',
      value: '{}',
      error: 'Payloads are unavailable.',
    });

    expect(editor.getAttribute('aria-invalid')).toBe('true');
    expect(view.getByRole('alert').textContent).toBe('Payloads are unavailable.');
  });

  test('skips parsing while an external error owns feedback and resumes when it clears', async () => {
    const parse = spyOn(JSON, 'parse');
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: '{"large":true}',
      error: 'Payloads are unavailable.',
    });

    expect(parse).not.toHaveBeenCalled();

    await view.rerender({
      id: 'payload',
      label: 'Payload',
      value: '{"large":true}',
      error: '',
    });

    expect(parse).toHaveBeenCalledWith('{"large":true}');
    parse.mockRestore();
  });

  test('treats an empty external error as cleared validation state', async () => {
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: '{',
      error: '',
    });

    expect(view.getByRole('alert').textContent).toBe('Enter valid JSON.');

    await view.rerender({
      id: 'payload',
      label: 'Payload',
      value: '{}',
      error: '',
    });

    expect(view.getByRole('status').textContent).toBe('Valid JSON.');
  });

  test('updates parse feedback immediately from typed text before controlled state responds', async () => {
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: '{}',
    });
    const editor = textareaOf(view);

    await fireEvent.input(editor, { target: { value: '{' } });

    expect(requiredInstance(editor, HTMLTextAreaElement).value).toBe('{');
    expect(editor.getAttribute('aria-invalid')).toBe('true');
    expect(view.getByRole('alert').textContent).toBe('Enter valid JSON.');
  });

  test('preserves proposed parse feedback across unrelated parent rerenders', async () => {
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: '{}',
    });
    const editor = textareaOf(view);
    await fireEvent.input(editor, { target: { value: '{' } });

    await view.rerender({
      id: 'payload',
      label: 'Payload',
      description: 'Updated description.',
      value: '{}',
    });

    expect(requiredInstance(editor, HTMLTextAreaElement).value).toBe('{');
    expect(editor.getAttribute('aria-invalid')).toBe('true');
    expect(view.getByRole('alert').textContent).toBe('Enter valid JSON.');
  });

  test('suppresses valid feedback when consumer validation marks the editor invalid', () => {
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: '{}',
      'aria-invalid': 'true',
      'aria-describedby': 'payload-domain-error',
    });
    const editor = textareaOf(view);

    expect(editor.getAttribute('aria-invalid')).toBe('true');
    expect(editor.getAttribute('aria-describedby')).toBe('payload-domain-error');
    expect(view.queryByRole('status')).toBeNull();
  });

  test('restores valid feedback when consumer validation is cleared with null', async () => {
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: '{}',
      'aria-invalid': 'true',
    });

    await view.rerender({
      id: 'payload',
      label: 'Payload',
      value: '{}',
      'aria-invalid': null,
    });

    expect(textareaOf(view).getAttribute('aria-invalid')).toBeNull();
    expect(view.getByRole('status').textContent).toBe('Valid JSON.');
  });

  test('keeps native multiline keyboard input and does not trap Tab', async () => {
    const onValueChange = mock();
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: '{}',
      onValueChange,
    });
    const editor = textareaOf(view);

    const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    editor.dispatchEvent(tabEvent);
    await fireEvent.input(editor, { target: { value: '{\n  "line": 2\n}' } });

    expect(tabEvent.defaultPrevented).toBe(false);
    expect(onValueChange).toHaveBeenCalledWith('{\n  "line": 2\n}');
  });

  test('can suppress success text while retaining invalid parse feedback', async () => {
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: '{}',
      validFeedbackVisible: false,
    });

    expect(view.queryByRole('status')).toBeNull();

    await view.rerender({
      id: 'payload',
      label: 'Payload',
      value: '{',
      validFeedbackVisible: false,
    });

    expect(view.getByRole('alert').textContent).toBe('Enter valid JSON.');
  });

  test('typing valid JSON clears the alert when validFeedbackVisible is false', async () => {
    const view = render(JsonEditor, {
      id: 'payload',
      label: 'Payload',
      value: '{ broken',
      validFeedbackVisible: false,
    });
    const editor = textareaOf(view);
    expect(view.getByRole('alert').textContent).toBe('Enter valid JSON.');

    await fireEvent.input(editor, { target: { value: '{ "force": true }' } });

    expect(view.queryByRole('alert')).toBeNull();
    expect(view.queryByRole('status')).toBeNull();
  });
});
