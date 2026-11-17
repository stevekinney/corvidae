/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/svelte');
const { default: Harness } = await import('./form-problems-harness.test.svelte');
const { focusFirstProblem } = await import('./focus-first-problem.ts');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function submitButton(container: HTMLElement): HTMLButtonElement {
  return requiredInstance(container.querySelector('button[type="submit"]'), HTMLButtonElement);
}

describe('Form focuses the first problem on submit (rows 68a, 42l)', () => {
  test('the button stays enabled and pressing it focuses the first field with its message', async () => {
    const { container } = render(Harness);
    const button = submitButton(container);
    expect(button.disabled).toBe(false);

    await fireEvent.submit(requiredInstance(container.querySelector('form'), HTMLFormElement));

    const name = requiredInstance(container.querySelector('#goal-name'), HTMLInputElement);
    await waitFor(() => expect(document.activeElement === name).toBe(true));
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(container.querySelector('#goal-name-error')?.textContent?.trim()).toBe('Enter a name.');
    expect(button.disabled).toBe(false);
  });

  test('a disabled field is skipped, so the next problem takes focus', async () => {
    const { container } = render(Harness, { props: { nameDisabled: true } });
    await fireEvent.submit(requiredInstance(container.querySelector('form'), HTMLFormElement));
    const check = requiredInstance(container.querySelector('#goal-check'), HTMLInputElement);
    await waitFor(() => expect(document.activeElement === check).toBe(true));
  });

  test('focusProblemOnSubmit={false} leaves focus where the page puts it', async () => {
    const { container } = render(Harness, { props: { focusProblemOnSubmit: false } });
    const button = submitButton(container);
    button.focus();
    await fireEvent.submit(requiredInstance(container.querySelector('form'), HTMLFormElement));
    await waitFor(() =>
      expect(container.querySelector('#goal-name')?.getAttribute('aria-invalid')).toBe('true'),
    );
    expect(document.activeElement === button).toBe(true);
  });

  test('readingColumn holds the form to one column', () => {
    const plain = render(Harness);
    expect(plain.container.querySelector('form')?.hasAttribute('data-cinder-reading-column')).toBe(
      false,
    );
    cleanup();
    const column = render(Harness, { props: { readingColumn: true } });
    expect(column.container.querySelector('form')?.hasAttribute('data-cinder-reading-column')).toBe(
      true,
    );
  });
});

describe('focusFirstProblem', () => {
  test('returns the element it focused, or undefined when there is no problem', () => {
    document.body.innerHTML =
      '<form><input id="a"><input id="b" aria-invalid="true"><input id="c" data-cinder-invalid="true"></form>';
    const form = requiredInstance(document.querySelector('form'), HTMLFormElement);
    const focused = focusFirstProblem(form);
    expect(focused?.id).toBe('b');
    expect(document.activeElement?.id).toBe('b');

    document.body.innerHTML = '<form><input id="a"></form>';
    expect(
      focusFirstProblem(requiredInstance(document.querySelector('form'), HTMLFormElement)),
    ).toBe(undefined);
  });
});
