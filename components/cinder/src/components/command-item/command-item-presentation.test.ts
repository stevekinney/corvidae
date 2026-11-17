/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, render } = await import('@testing-library/svelte');
const { default: Harness } = await import('./command-item-presentation-harness.test.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('CommandItem leading tone and meta (row 03c)', () => {
  test('a neutral leading glyph carries no tone attribute', () => {
    const { container } = render(Harness, {});
    const leading = container.querySelector('.cinder-command-item__leading');
    expect(leading?.getAttribute('data-cinder-tone')).toBeNull();
    expect(leading?.getAttribute('aria-hidden')).toBe('true');
  });

  test('the warning tone is marked for the amber tile', () => {
    const { container } = render(Harness, { tone: 'warning' });
    expect(
      container.querySelector('.cinder-command-item__leading')?.getAttribute('data-cinder-tone'),
    ).toBe('warning');
  });

  test('meta sits on the label line after the label, hidden from assistive technology', () => {
    const { container } = render(Harness, { withMeta: true });
    const label = container.querySelector('.cinder-command-item__label');
    const meta = label?.querySelector('.cinder-command-item__meta');
    expect(meta?.textContent?.trim()).toBe('Approval, waiting');
    expect(meta?.getAttribute('aria-hidden')).toBe('true');
    expect(label?.querySelector('.cinder-command-item__text')?.textContent?.trim()).toBe(
      'Refund order 4471 for $42.00?',
    );
    expect(label?.lastElementChild).toBe(meta ?? null);
    // The label's own text is what truncates first, so the meta stays readable on a phone.
    expect(label?.hasAttribute('data-cinder-meta')).toBe(true);
  });
});

describe('CommandItem meta separator', () => {
  test('a meta with nothing in it is not drawn, so no stray "," trails the label', async () => {
    const css = await Bun.file(new URL('./command-item.css', import.meta.url)).text();
    expect(css).toMatch(/\.cinder-command-item__meta:empty\s*\{\s*display:\s*none;/);
    expect(css).toMatch(/\.cinder-command-item__meta::before\s*\{[^}]*content:\s*',';/);
  });
});

describe('CommandPalette escape hint (row 03c)', () => {
  test('shows "esc" at the end of the search field by default', () => {
    const { container } = render(Harness, {});
    const hint = container.querySelector('.cinder-command-palette__escape kbd');
    expect(hint?.textContent?.trim()).toBe('esc');
    expect(hint?.closest('.cinder-command-palette__search')).not.toBeNull();
    expect(
      container.querySelector('.cinder-command-palette__escape')?.getAttribute('aria-hidden'),
    ).toBe('true');
  });

  test('words the hint with escapeHint', () => {
    const { container } = render(Harness, { escapeHint: 'Esc' });
    expect(
      container.querySelector('.cinder-command-palette__escape kbd')?.textContent?.trim(),
    ).toBe('Esc');
  });

  test('leaves the hint out when escapeHint is false', () => {
    const { container } = render(Harness, { escapeHint: false });
    expect(container.querySelector('.cinder-command-palette__escape')).toBeNull();
  });
});
