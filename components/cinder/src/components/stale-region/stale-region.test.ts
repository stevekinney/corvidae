/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

// setupHappyDom() MUST run before any `@testing-library/svelte` import. testing-library
// reads `globalThis.document` / `window` at module-init (top-level, not inside test bodies),
// so we register happy-dom's globals first and then dynamic-import testing-library below.
setupHappyDom();

const { fireEvent, render } = await import('@testing-library/svelte');
const { default: StaleRegionHarness } = await import('./stale-region-harness.test.svelte');
const { default: StaleRegion } = await import('./stale-region.svelte');
const { createRawSnippet } = await import('svelte');

function textSnippet(text: string) {
  return createRawSnippet(() => ({
    render: () => `<span>${text}</span>`,
  }));
}

/** The words an element is described by, resolved through `aria-describedby`. */
function descriptionOf(element: Element): string {
  const ids = (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  return ids
    .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
    .join(' ')
    .trim();
}

describe('StaleRegion', () => {
  test('renders the cinder-stale-region wrapper with its children', () => {
    const { container } = render(StaleRegion, { children: textSnippet('content') });
    const element = container.querySelector('.cinder-stale-region');
    expect(element).not.toBeNull();
    expect(element?.textContent).toContain('content');
  });

  test('merges a custom class alongside cinder-stale-region', () => {
    const { container } = render(StaleRegion, {
      children: textSnippet('content'),
      class: 'my-custom-class',
    });
    const element = container.querySelector('.cinder-stale-region');
    expect(element?.getAttribute('class')).toContain('cinder-stale-region');
    expect(element?.getAttribute('class')).toContain('my-custom-class');
  });

  test('writes the default reason once, visually hidden, while stale', () => {
    const { container } = render(StaleRegion, { children: textSnippet('content') });
    const reasons = container.querySelectorAll('.cinder-sr-only');
    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.textContent).toBe('Off until it’s back');
    expect(container.querySelector('.cinder-stale-region')?.hasAttribute('data-cinder-stale')).toBe(
      true,
    );
  });

  test('writes no reason and no marker once the data is live again', () => {
    const { container } = render(StaleRegion, {
      stale: false,
      children: textSnippet('content'),
    });
    expect(container.querySelector('.cinder-sr-only')).toBeNull();
    expect(container.querySelector('.cinder-stale-region')?.hasAttribute('data-cinder-stale')).toBe(
      false,
    );
  });

  test('uses the reason the page words', () => {
    const { container } = render(StaleRegion, {
      reason: 'Off until storage answers.',
      children: textSnippet('content'),
    });
    expect(container.querySelector('.cinder-sr-only')?.textContent).toBe(
      'Off until storage answers.',
    );
  });

  test('leaves the data at full contrast: the stylesheet dims nothing', () => {
    const css = readFileSync(new URL('./stale-region.css', import.meta.url), 'utf8');
    // Strip comments: the header explains what the region must not do.
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(declarations).not.toMatch(/opacity|filter|color|mask|pointer-events/);
    expect(declarations).toContain('display: contents');
  });
});

describe('StaleRegion with the controls that change something', () => {
  test('an opted-in button is inert, focusable and described by the reason', async () => {
    const calls: string[] = [];
    const { getByRole } = render(StaleRegionHarness, {
      onSave: () => calls.push('save'),
    });
    const save = getByRole('button', { name: 'Save' });
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(save.hasAttribute('disabled')).toBe(false);
    expect(save.tabIndex).not.toBe(-1);
    expect(descriptionOf(save)).toBe('Off until it’s back');
    await fireEvent.click(save);
    expect(calls).toEqual([]);
  });

  test('controls that only read stay live in the same region', async () => {
    const calls: string[] = [];
    const { getByRole } = render(StaleRegionHarness, {
      onRetry: () => calls.push('retry'),
    });
    const retry = getByRole('button', { name: 'Retry now' });
    expect(retry.hasAttribute('aria-disabled')).toBe(false);
    expect(retry.hasAttribute('aria-describedby')).toBe(false);
    await fireEvent.click(retry);
    expect(calls).toEqual(['retry']);
    const link = getByRole('link', { name: 'Tool runner' });
    expect(link.hasAttribute('aria-disabled')).toBe(false);
  });

  test('the switch, the checkbox, the select and the menu trigger are inert too', () => {
    const { getByRole } = render(StaleRegionHarness, {});
    const controls = [
      getByRole('switch', { name: 'Active' }),
      getByRole('checkbox', { name: 'Tool is on' }),
      getByRole('combobox', { name: 'Default asks' }),
      getByRole('button', { name: 'More' }),
    ];
    for (const control of controls) {
      expect(control.getAttribute('aria-disabled')).toBe('true');
      expect(control.hasAttribute('disabled')).toBe(false);
      expect(descriptionOf(control)).toBe('Off until it’s back');
    }
  });

  test('the controls return by themselves when the region stops being stale', async () => {
    const calls: string[] = [];
    const { getByRole, getByText, queryByText } = render(StaleRegionHarness, {
      onSave: () => calls.push('save'),
    });
    const save = getByRole('button', { name: 'Save' });
    expect(save.getAttribute('aria-disabled')).toBe('true');

    await fireEvent.click(getByText('Back online'));

    expect(save.hasAttribute('aria-disabled')).toBe(false);
    expect(save.hasAttribute('aria-describedby')).toBe(false);
    expect(queryByText('Off until it’s back')).toBeNull();
    await fireEvent.click(save);
    expect(calls).toEqual(['save']);
    expect(getByRole('switch', { name: 'Active' }).hasAttribute('aria-disabled')).toBe(false);
    expect(getByRole('checkbox', { name: 'Tool is on' }).hasAttribute('aria-disabled')).toBe(false);
    expect(getByRole('combobox', { name: 'Default asks' }).hasAttribute('aria-disabled')).toBe(
      false,
    );
  });

  test('a press on the switch or the checkbox changes nothing while stale', async () => {
    const { getByRole } = render(StaleRegionHarness, {});
    const toggle = getByRole('switch', { name: 'Active' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    const checkbox = getByRole('checkbox', { name: 'Tool is on' }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    await fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
  });

  test('describedBy points inert controls at an element the page already has', () => {
    const { getByRole, container } = render(StaleRegionHarness, {
      describedBy: 'page-banner',
    });
    expect(container.querySelector('.cinder-sr-only')).toBeNull();
    const save = getByRole('button', { name: 'Save' });
    expect(save.getAttribute('aria-describedby')).toBe('page-banner');
    expect(descriptionOf(save)).toBe('Changes are off until it’s back.');
  });

  test('keeps a description the control already has beside the reason', () => {
    const { getByRole } = render(StaleRegionHarness, {});
    const edit = getByRole('button', { name: 'Edit' });
    expect(descriptionOf(edit)).toBe('Opens the editor Off until it’s back');
  });

  test('a mutating button outside any region is an ordinary button', async () => {
    const calls: string[] = [];
    const { getByRole } = render(StaleRegionHarness, {
      outside: true,
      onSave: () => calls.push('save'),
    });
    const outside = getByRole('button', { name: 'Save outside' });
    expect(outside.hasAttribute('aria-disabled')).toBe(false);
    await fireEvent.click(outside);
    expect(calls).toEqual(['save']);
  });

  test('the menu trigger does not open its menu while stale and does again after', async () => {
    const { getByRole, getByText } = render(StaleRegionHarness, {});
    const trigger = getByRole('button', { name: 'More' });
    await fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.hasAttribute('popovertarget')).toBe(false);

    await fireEvent.click(getByText('Back online'));
    expect(trigger.hasAttribute('aria-disabled')).toBe(false);
    await fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  test('the native select cannot be opened with the pointer or changed with the keyboard', () => {
    const { getByRole } = render(StaleRegionHarness, {});
    const select = getByRole('combobox', { name: 'Default asks' });
    const pointer = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    select.dispatchEvent(pointer);
    expect(pointer.defaultPrevented).toBe(true);
    const arrow = new window.KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    });
    select.dispatchEvent(arrow);
    expect(arrow.defaultPrevented).toBe(true);
    const tab = new window.KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    select.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
  });

  test('the listbox select is inert and described by the reason', async () => {
    const { getByRole, queryByRole } = render(StaleRegionHarness, { listbox: true });
    const trigger = getByRole('combobox', { name: /Default asks/ });
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    expect(descriptionOf(trigger)).toBe('Off until it’s back');
    await fireEvent.click(trigger);
    expect(queryByRole('listbox')).toBeNull();
  });

  test('a mutating link-button drops its href and keeps focus while stale', () => {
    const { getByRole } = render(StaleRegionHarness, { link: true });
    const link = getByRole('link', { name: 'Open settings' });
    expect(link.hasAttribute('href')).toBe(false);
    expect(link.getAttribute('aria-disabled')).toBe('true');
    expect(link.tabIndex).toBe(0);
  });
});
