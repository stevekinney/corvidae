/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: KeyFacts } = await import('./key-facts.svelte');

describe('KeyFacts', () => {
  test('renders one list item per fact, in order', () => {
    const { container } = render(KeyFacts, {
      items: [{ value: 'Cocktail bar' }, { value: 'LoDo' }, { value: '$$' }],
    });
    const items = [...container.querySelectorAll('li')];
    expect(items.map((item) => item.textContent?.trim())).toEqual(['Cocktail bar', 'LoDo', '$$']);
  });

  test('draws no middle dot between facts', () => {
    const { container } = render(KeyFacts, { items: [{ value: 'A' }, { value: 'B' }] });
    expect(container.textContent).not.toContain('·');
  });

  test('a fact with an href renders its value as a link', () => {
    const { container } = render(KeyFacts, {
      items: [{ value: 'LoDo', href: '/neighborhoods/lodo' }, { value: '$$' }],
    });
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('/neighborhoods/lodo');
    expect(links[0]?.textContent).toBe('LoDo');
  });

  test('names the fact kind for assistive technology and names the list', () => {
    const { container } = render(KeyFacts, {
      label: 'Details',
      items: [{ value: 'LoDo', label: 'Neighborhood' }],
    });
    expect(container.querySelector('ul')?.getAttribute('aria-label')).toBe('Details');
    expect(container.querySelector('.cinder-sr-only')?.textContent).toBe('Neighborhood:');
  });

  test('merges a custom class', () => {
    const { container } = render(KeyFacts, { items: [], class: 'extra' });
    expect(container.querySelector('ul')?.classList.contains('cinder-key-facts')).toBe(true);
    expect(container.querySelector('ul')?.classList.contains('extra')).toBe(true);
  });

  test('stylesheet wraps between facts and keeps each fact whole', () => {
    const css = readFileSync(new URL('./key-facts.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.cinder-key-facts \{[^}]*flex-wrap: wrap/);
    expect(css).toMatch(/\.cinder-key-facts__item \{[^}]*white-space: nowrap/);
  });
});
