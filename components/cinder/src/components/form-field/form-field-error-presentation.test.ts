/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';
import { createRawSnippet } from 'svelte';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, render } = await import('@testing-library/svelte');
const { default: FormField } = await import('./form-field.svelte');
const { default: FormFieldInputFixture } = await import('./form-field-input-fixture.test.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const control = createRawSnippet(() => ({
  render: () => '<input id="server-url" aria-label="Server URL">',
}));
const openGithub = createRawSnippet(() => ({ render: () => '<a href="#github">Open GitHub</a>' }));
const tryAgain = createRawSnippet(() => ({
  render: () => '<button type="button">Try again</button>',
}));

function errorOf(container: HTMLElement): HTMLElement {
  return requiredInstance(container.querySelector('.cinder-form-field__error'), HTMLElement);
}

describe('FormField error presentation (rows 42l, 34d, 34m, 34t)', () => {
  test('an error leads with a warning glyph and keeps its message as the text', () => {
    const { container } = render(FormField, {
      props: {
        id: 'server-url',
        label: 'Server URL',
        error: 'Enter a server URL.',
        children: control,
      },
    });
    const error = errorOf(container);
    expect(error.getAttribute('aria-live')).toBe('polite');
    expect(error.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(error.querySelector('svg')?.classList.contains('lucide-triangle-alert')).toBe(true);
    expect(error.textContent).toBe('Enter a server URL.');
    expect(error.hasAttribute('data-cinder-error')).toBe(true);
  });

  test('errorGlyph="error" draws the circle glyph for a conflict', () => {
    const { container } = render(FormField, {
      props: {
        id: 'server-url',
        label: 'Server URL',
        error: 'This URL is already connected as GitHub.',
        errorGlyph: 'error',
        children: control,
      },
    });
    expect(errorOf(container).querySelector('svg')?.classList.contains('lucide-circle-alert')).toBe(
      true,
    );
  });

  test('errorAction sits inside the same live region, after the message', () => {
    const { container } = render(FormField, {
      props: {
        id: 'server-url',
        label: 'Server URL',
        error: 'This URL is already connected as GitHub.',
        errorAction: openGithub,
        children: control,
      },
    });
    const error = errorOf(container);
    expect(error.querySelector('a')?.textContent).toBe('Open GitHub');
    const text = error.querySelector('.cinder-form-field__error-text');
    expect(text?.nextElementSibling?.tagName).toBe('A');
  });

  test('warningAction sits in the warning paragraph, after the words, and joins aria-describedby', () => {
    const { container } = render(FormField, {
      props: {
        id: 'server-url',
        label: 'Server URL',
        warning: 'Won’t run until a provider is connected ·',
        warningAction: openGithub,
        children: control,
      },
    });
    const warning = requiredInstance(
      container.querySelector('.cinder-form-field__warning'),
      HTMLElement,
    );
    expect(warning.textContent?.startsWith('Won’t run until a provider is connected ·')).toBe(true);
    expect(warning.querySelector('a')?.textContent).toBe('Open GitHub');
    expect(warning.id).toBe('server-url-warning');
  });

  test('the error action is an accent link and the glyph shares a block with the words (rows 34d, 47k)', async () => {
    const css = await Bun.file(new URL('./form-field.css', import.meta.url)).text();
    const action =
      /\.cinder-form-field__error :where\(a, button\) \{([^}]*)\}/s.exec(css)?.[1] ?? '';
    expect(action).toContain('color: var(--cinder-accent-text)');
    expect(action).toContain('font-weight: var(--cinder-font-semibold)');
    const error = /\.cinder-form-field__error \{([^}]*)\}/s.exec(css)?.[1] ?? '';
    // Nothing wraps between the glyph and the message, so the glyph never sits alone on a line.
    expect(error).not.toContain('flex-wrap');
    const { container } = render(FormField, {
      props: {
        id: 'server-url',
        label: 'Server URL',
        error: 'This URL is already connected as GitHub.',
        errorAction: openGithub,
        children: control,
      },
    });
    const body = requiredInstance(
      container.querySelector('.cinder-form-field__error-body'),
      HTMLElement,
    );
    expect(body.querySelector('.cinder-form-field__error-text')).not.toBeNull();
    expect(body.querySelector('a')?.textContent).toBe('Open GitHub');
  });

  test('with no error the live region stays mounted and empty, with no glyph', () => {
    const { container } = render(FormField, {
      props: { id: 'server-url', label: 'Server URL', errorAction: openGithub, children: control },
    });
    const error = errorOf(container);
    expect(error.hasAttribute('data-cinder-error')).toBe(false);
    expect(error.querySelector('svg')).toBeNull();
    expect(error.querySelector('a')).toBeNull();
    expect(error.textContent).toBe('');
  });

  test('the control marks itself invalid and the error is in its description', () => {
    const { container } = render(FormFieldInputFixture, {
      props: { error: 'Couldn’t reach the server.' },
    });
    const input = requiredInstance(container.querySelector('input'), HTMLInputElement);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toContain('server-url-error');
  });

  test('trailing content shares the control row, as Try again does beside the field (row 34m)', () => {
    const { container } = render(FormField, {
      props: {
        id: 'server-url',
        label: 'Server URL',
        error: 'Couldn’t reach the server.',
        trailing: tryAgain,
        children: control,
      },
    });
    const row = requiredInstance(
      container.querySelector('.cinder-form-field__control--row'),
      HTMLElement,
    );
    expect(row.firstElementChild?.id).toBe('server-url');
    expect(row.lastElementChild?.textContent).toBe('Try again');
  });

  test('a note is neutral text under the description and describes the control (row 57p)', () => {
    const { container } = render(FormFieldInputFixture, {
      props: {
        description: 'Collect changes since this date.',
        note: 'Cleared for the schedule: a fixed date would re-collect the same changes on every run.',
      },
    });
    const note = requiredInstance(container.querySelector('.cinder-form-field__note'), HTMLElement);
    const description = requiredInstance(
      container.querySelector('.cinder-form-field__description'),
      HTMLElement,
    );
    expect(note.previousElementSibling).toBe(description);
    expect(note.textContent).toContain('Cleared for the schedule');
    const input = requiredInstance(container.querySelector('input'), HTMLInputElement);
    expect(input.getAttribute('aria-describedby')?.split(' ')).toEqual([
      'server-url-description',
      'server-url-note',
    ]);
  });

  test('a required field carries the small dot after the label, never the word (row 41d)', () => {
    const { container } = render(FormField, {
      props: { id: 'server-url', label: 'Name', required: true, children: control },
    });
    const label = requiredInstance(container.querySelector('label'), HTMLElement);
    expect(label.querySelector('.cinder-_required-marker')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(label.textContent?.toLowerCase()).not.toContain('required');
  });

  test('a managed line leads with a lock glyph and may carry a whole message (row 47l)', () => {
    const { container } = render(FormField, {
      props: {
        id: 'server-url',
        label: 'Max runs',
        managed: {
          message:
            'Locked by your deployment (remote mode). Change it in the deployment’s configuration.',
        },
        children: control,
      },
    });
    const managed = requiredInstance(
      container.querySelector('.cinder-form-field__managed'),
      HTMLElement,
    );
    expect(managed.querySelector('svg')?.classList.contains('lucide-lock')).toBe(true);
    expect(managed.textContent?.trim()).toBe(
      'Locked by your deployment (remote mode). Change it in the deployment’s configuration.',
    );
  });

  test('the managed line keeps its "Managed by" wording without a message', () => {
    const { container } = render(FormField, {
      props: {
        id: 'server-url',
        label: 'Max runs',
        managed: { by: 'Admin', reason: 'Organization policy' },
        children: control,
      },
    });
    expect(container.querySelector('.cinder-form-field__managed')?.textContent?.trim()).toBe(
      'Managed by Admin: Organization policy',
    );
  });
});
