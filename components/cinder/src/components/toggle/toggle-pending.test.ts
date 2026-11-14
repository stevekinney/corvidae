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

describe('Toggle pending', () => {
  test('a pending switch is busy, inert and still focusable, and ignores a press', async () => {
    const onValueChange = mock();
    const { container } = render(Toggle, {
      props: { id: 'runs', label: 'Enabled', checked: true, pending: true, onValueChange },
    });
    const button = switchOf(container);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('data-cinder-pending')).toBe(true);
    // Not natively disabled, so focus is not lost when the switch starts or stops waiting.
    expect(button.disabled).toBe(false);
    button.focus();
    expect(document.activeElement).toBe(button);
    await fireEvent.click(button);
    expect(button.getAttribute('aria-checked')).toBe('true');
    expect(onValueChange).not.toHaveBeenCalled();
  });

  test('a press on the label or the state words of a pending switch changes nothing either', async () => {
    const onValueChange = mock();
    const { container } = render(Toggle, {
      props: {
        id: 'runs-label',
        label: 'Enabled',
        checked: false,
        pending: true,
        stateText: { on: 'On', off: 'Off' },
        onValueChange,
      },
    });
    await fireEvent.click(
      requiredInstance(container.querySelector('.cinder-toggle-field__label'), HTMLElement),
    );
    await fireEvent.click(
      requiredInstance(container.querySelector('.cinder-toggle-field__state'), HTMLElement),
    );
    expect(switchOf(container).getAttribute('aria-checked')).toBe('false');
    expect(onValueChange).not.toHaveBeenCalled();
  });

  test('a switch that is not pending is not busy, and a press changes it', async () => {
    const onValueChange = mock();
    const { container } = render(Toggle, {
      props: { id: 'plain', label: 'Enabled', checked: false, onValueChange },
    });
    const button = switchOf(container);
    expect(button.hasAttribute('aria-busy')).toBe(false);
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    expect(button.hasAttribute('data-cinder-pending')).toBe(false);
    await fireEvent.click(button);
    expect(onValueChange).toHaveBeenCalledWith(true);
  });

  test('a switch takes a press again once it stops waiting', async () => {
    const onValueChange = mock();
    const { container, rerender } = render(Toggle, {
      props: { id: 'again', label: 'Enabled', checked: false, pending: true, onValueChange },
    });
    await fireEvent.click(switchOf(container));
    expect(onValueChange).not.toHaveBeenCalled();
    await rerender({ pending: false });
    expect(switchOf(container).hasAttribute('aria-busy')).toBe(false);
    await fireEvent.click(switchOf(container));
    expect(onValueChange).toHaveBeenCalledWith(true);
  });

  test('draws a spinner in the thumb, takes the grey off, and holds it still under reduced motion', async () => {
    const css = await Bun.file(new URL('./toggle.css', import.meta.url)).text();
    expect(css).toMatch(
      /\.cinder-toggle\[data-cinder-pending\] \.cinder-toggle__thumb::after\s*\{[^}]*animation: cinder-toggle-spin/,
    );
    expect(css).toMatch(/\.cinder-toggle\[data-cinder-pending\]\s*\{[^}]*filter: none/);
    expect(css).toMatch(
      /prefers-reduced-motion: reduce\)[^{]*\{[^{}]*\.cinder-toggle\[data-cinder-pending\][^{}]*::after\s*\{\s*animation: none/,
    );
  });
});
