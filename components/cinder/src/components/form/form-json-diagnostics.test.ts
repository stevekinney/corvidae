/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/svelte');
const { default: Harness } = await import('./form-json-harness.test.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('Form with a JSON setting that breaks its schema (rows 29w, 29x)', () => {
  test('valid JSON that breaks the setting schema marks its line and takes focus on submit', async () => {
    const message = 'Line 3: timeoutSeconds must be a number';
    const { container } = render(Harness, { props: { jsonDiagnostics: [{ line: 3, message }] } });
    await waitFor(() => expect(container.querySelector('.cm-editor')).not.toBeNull());
    const button = requiredInstance(
      container.querySelector('button[type="submit"]'),
      HTMLButtonElement,
    );
    expect(button.disabled).toBe(false);

    await fireEvent.submit(requiredInstance(container.querySelector('form'), HTMLFormElement));
    await waitFor(() =>
      expect(container.querySelector('.cinder-json-editor__problem')).not.toBeNull(),
    );

    // The message names the line, and the line is marked in the gutter and the body.
    expect(container.querySelector('.cinder-json-editor__problem')?.textContent).toBe(message);
    expect(container.querySelector('.cinder-json-editor__line--problem')?.textContent).toContain(
      '"timeoutSeconds"',
    );
    // The editor reports the problem, so Save moves focus to it.
    const content = requiredInstance(container.querySelector('#goal-settings'), HTMLElement);
    expect(content.getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => expect(document.activeElement === content).toBe(true));
    // The toolbar keeps saying what the editor itself knows: the text parses.
    expect(container.querySelector('[role="status"]')?.textContent?.trim()).toBe('Valid JSON');
    expect(button.disabled).toBe(false);
  });
});
