/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, fireEvent, cleanup } = await import('@testing-library/svelte');
const { default: Toggle } = await import('./toggle.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function switchOf(container: HTMLElement): HTMLButtonElement {
  return requiredInstance(container.querySelector('button'), HTMLButtonElement);
}

describe('Toggle read-only and description (row 72r)', () => {
  test('a read-only switch is focusable, announced as read-only, and ignores a press', async () => {
    const onValueChange = mock();
    const { container } = render(Toggle, {
      props: {
        id: 'schedule-active',
        label: 'Active',
        checked: true,
        readonly: true,
        onValueChange,
      },
    });
    const button = switchOf(container);
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-readonly')).toBe('true');
    expect(button.getAttribute('aria-checked')).toBe('true');
    button.focus();
    expect(document.activeElement).toBe(button);
    await fireEvent.click(button);
    expect(button.getAttribute('aria-checked')).toBe('true');
    expect(onValueChange).not.toHaveBeenCalled();
  });

  test('a press on the label of a read-only switch changes nothing either', async () => {
    const onValueChange = mock();
    const { container } = render(Toggle, {
      props: {
        id: 'schedule-label',
        label: 'Active',
        checked: false,
        readonly: true,
        onValueChange,
      },
    });
    await fireEvent.click(
      requiredInstance(container.querySelector('.cinder-toggle-field__label'), HTMLElement),
    );
    expect(switchOf(container).getAttribute('aria-checked')).toBe('false');
    expect(onValueChange).not.toHaveBeenCalled();
  });

  test('a switch that is not read-only does not announce aria-readonly', () => {
    const { container } = render(Toggle, {
      props: { id: 'plain', label: 'Active', checked: true },
    });
    expect(switchOf(container).hasAttribute('aria-readonly')).toBe(false);
  });

  test('a read-only switch still submits its value with a native form', () => {
    const { container } = render(Toggle, {
      props: { id: 'submitted', label: 'Active', checked: true, readonly: true, name: 'active' },
    });
    const hidden = requiredInstance(
      container.querySelector('input[type="checkbox"]'),
      HTMLInputElement,
    );
    expect(hidden.checked).toBe(true);
    expect(hidden.disabled).toBe(false);
  });

  test('the description is visible and describes the switch', () => {
    const { container } = render(Toggle, {
      props: {
        id: 'file-defined',
        label: 'Active',
        checked: true,
        readonly: true,
        description: 'Defined in workflows/release-notes.json',
      },
    });
    const description = requiredInstance(
      container.querySelector('.cinder-toggle-field__description'),
      HTMLElement,
    );
    expect(description.textContent).toBe('Defined in workflows/release-notes.json');
    expect(switchOf(container).getAttribute('aria-describedby')).toBe(description.id);
  });

  test('without a description the switch has no aria-describedby', () => {
    const { container } = render(Toggle, {
      props: { id: 'bare', label: 'Active', checked: false },
    });
    expect(switchOf(container).hasAttribute('aria-describedby')).toBe(false);
    expect(container.querySelector('.cinder-toggle-field__description')).toBeNull();
  });
});
