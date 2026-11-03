/// <reference lib="dom" />
/**
 * COR-2010 (B02, row 77i): a tab that holds a problem carries an amber count chip of its own
 * attention items; a healthy tab carries none, and the count is part of the tab's name.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, render } = await import('@testing-library/svelte');
const { default: CountFixture } = await import('../../test/fixtures/tabs-count-fixture.svelte');

const tabsCss = readFileSync(new URL('../tabs/tabs.css', import.meta.url), 'utf8');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function tabNamed(container: HTMLElement, name: string): HTMLElement {
  const tab = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]')).find((element) =>
    element.textContent?.trim().startsWith(name),
  );
  if (tab === undefined) throw new Error(`no tab named ${name}`);
  return tab;
}

describe('Tab count', () => {
  test('Workers and Storage carry an amber chip of 1; Overview and Audit log carry none', () => {
    const { container } = render(CountFixture, {});
    for (const name of ['Workers', 'Storage']) {
      const chip = tabNamed(container, name).querySelector('.cinder-tab__count');
      expect(chip?.textContent?.trim()).toBe('1');
      expect(chip?.getAttribute('data-cinder-variant')).toBe('warning');
    }
    for (const name of ['Overview', 'Audit log']) {
      expect(tabNamed(container, name).querySelector('.cinder-tab__count')).toBeNull();
    }
  });

  test('the chip is named with its words and is not hidden from assistive technology', () => {
    const { container } = render(CountFixture, {});
    const chip = tabNamed(container, 'Workers').querySelector('.cinder-tab__count');
    expect(chip?.getAttribute('role')).toBe('img');
    expect(chip?.getAttribute('aria-label')).toBe('1 needs attention');
    expect(chip?.closest('[aria-hidden="true"]')).toBeNull();
  });

  test('a count with no words reads as the bare number, with no image role', () => {
    const { container } = render(CountFixture, { countLabel: '  ' });
    const chip = tabNamed(container, 'Workers').querySelector('.cinder-tab__count');
    expect(chip?.getAttribute('role')).toBeNull();
    expect(chip?.getAttribute('aria-label')).toBeNull();
    expect(chip?.textContent?.trim()).toBe('1');
  });

  test.each([[0], [-2], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'a count of %p shows nothing',
    (count) => {
      const { container } = render(CountFixture, { workers: count, storage: count });
      expect(container.querySelector('.cinder-tab__count')).toBeNull();
    },
  );

  test('the chip is a fixed-width pill that does not shrink in a tight strip', () => {
    const rule = /\.cinder-tab__count\s*\{([^}]*)\}/.exec(tabsCss)?.[1] ?? '';
    expect(rule).toContain('flex: none');
    expect(rule).toContain('min-inline-size: 1.125rem');
    expect(rule).toContain('border-radius: 9999px');
  });
});
