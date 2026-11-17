/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: Fixture } = await import('../../test/fixtures/tree-count-fixture.svelte');

describe('TreeItem icon and count', () => {
  test('draws the icon, then the label, then the count, in that order on the row', () => {
    const { container } = render(Fixture);
    const row = container.querySelector(
      '[data-cinder-tree-item-id="red"] > .cinder-tree-item__row',
    );
    const parts = [...(row?.children ?? [])]
      .map((child) => child.className)
      .filter((name) => /__(icon|label|count)/.test(name));
    expect(parts.map((name) => /__(icon|label|count)/.exec(name)?.[1])).toEqual([
      'icon',
      'label',
      'count',
    ]);
    expect(row?.querySelector('.cinder-tree-item__count')?.textContent).toBe('12');
  });

  test('reads the count after the label and hides the visible count from assistive technology', () => {
    const { container } = render(Fixture);
    const item = container.querySelector('[data-cinder-tree-item-id="red"]');
    const name = container.ownerDocument.getElementById(
      item?.getAttribute('aria-labelledby') ?? '',
    );
    expect(name?.textContent).toBe('Red, 12');
    expect(item?.querySelector('.cinder-tree-item__count')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(item?.querySelector('.cinder-tree-item__icon')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  test('an item without an icon or count draws neither', () => {
    const { container } = render(Fixture);
    const plain = container.querySelector('[data-cinder-tree-item-id="plain"]');
    expect(plain?.querySelector('.cinder-tree-item__count')).toBeNull();
    expect(plain?.querySelector('.cinder-tree-item__icon')).toBeNull();
  });

  test('stylesheet right-aligns the count and keeps the label an ellipsis column', () => {
    const css = readFileSync(new URL('../tree/tree.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.cinder-tree-item__count \{[^}]*margin-inline-start: auto/);
    expect(css).toMatch(/\.cinder-tree-item__label \{[^}]*min-inline-size: 0/);
  });
});
