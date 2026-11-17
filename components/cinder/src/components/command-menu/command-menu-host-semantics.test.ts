/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { applyHostAttributes } = await import('./command-menu-host-semantics.ts');

function host(attributes: Record<string, string> = {}): HTMLTextAreaElement {
  const element = document.createElement('textarea');
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

describe('applyHostAttributes', () => {
  test('writes the attributes and removes the ones it added when restored', () => {
    const element = host();
    const restore = applyHostAttributes(element, { role: 'combobox', 'aria-expanded': 'true' });
    expect(element.getAttribute('role')).toBe('combobox');
    expect(element.getAttribute('aria-expanded')).toBe('true');

    restore();
    expect(element.hasAttribute('role')).toBe(false);
    expect(element.hasAttribute('aria-expanded')).toBe(false);
  });

  test('puts back the exact prior value of an attribute it overwrote', () => {
    const element = host({ role: 'searchbox', 'aria-controls': 'host-list' });
    const restore = applyHostAttributes(element, { role: 'combobox', 'aria-controls': 'menu' });
    expect(element.getAttribute('role')).toBe('combobox');
    expect(element.getAttribute('aria-controls')).toBe('menu');

    restore();
    expect(element.getAttribute('role')).toBe('searchbox');
    expect(element.getAttribute('aria-controls')).toBe('host-list');
  });

  test('a null value removes the attribute and restore brings it back', () => {
    const element = host({ 'aria-activedescendant': 'row-1' });
    const restore = applyHostAttributes(element, { 'aria-activedescendant': null });
    expect(element.hasAttribute('aria-activedescendant')).toBe(false);

    restore();
    expect(element.getAttribute('aria-activedescendant')).toBe('row-1');
  });

  test('leaves an attribute that already holds the value alone, and restores nothing for it', () => {
    const element = host({ 'aria-expanded': 'true' });
    const restore = applyHostAttributes(element, { 'aria-expanded': 'true' });
    element.setAttribute('aria-expanded', 'false');

    restore();
    expect(element.getAttribute('aria-expanded')).toBe('false');
  });

  test('does not overwrite a value the host set after the write', () => {
    const element = host();
    const restore = applyHostAttributes(element, { 'aria-expanded': 'true' });
    element.setAttribute('aria-expanded', 'false');

    restore();
    expect(element.getAttribute('aria-expanded')).toBe('false');
  });
});
