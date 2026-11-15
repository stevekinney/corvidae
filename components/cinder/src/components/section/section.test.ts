/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: Section } = await import('./section.svelte');

const text = (value: string) => createRawSnippet(() => ({ render: () => `<p>${value}</p>` }));

describe('Section', () => {
  test('renders a named section with the heading at the chosen level', () => {
    const { container } = render(Section, { title: 'Upcoming', level: 3, children: text('Body') });
    const heading = container.querySelector('h3');
    expect(heading?.textContent).toBe('Upcoming');
    const section = container.querySelector('section');
    expect(section?.getAttribute('aria-labelledby')).toBe(heading?.id);
  });

  // COR-2329: a level-3 title was as loud as level 2, so a section inside a section read as its
  // equal. The title steps down with its level; level 2 is unchanged.
  test('marks a title of level 3 or deeper with its level, and level 2 with none', () => {
    const plain = render(Section, { title: 'Upcoming', children: text('Body') });
    expect(plain.container.querySelector('h2')?.hasAttribute('data-level')).toBe(false);
    plain.unmount();
    const two = render(Section, { title: 'Upcoming', level: 2, children: text('Body') });
    expect(two.container.querySelector('h2')?.hasAttribute('data-level')).toBe(false);
    two.unmount();
    for (const level of [3, 4, 5, 6] as const) {
      const view = render(Section, { title: 'Upcoming', level, children: text('Body') });
      expect(view.container.querySelector(`h${level}`)?.getAttribute('data-level')).toBe(
        String(level),
      );
      view.unmount();
    }
  });

  test('steps the title down by level: large, then base, then small and muted', () => {
    const css = readFileSync(new URL('./section.css', import.meta.url), 'utf8').replace(
      /\s+/g,
      ' ',
    );
    expect(css).toMatch(/\.cinder-section__title \{[^}]*font-size: var\(--cinder-text-lg\);/);
    expect(css).toMatch(
      /\.cinder-section__title\[data-level='3'\] \{ font-size: var\(--cinder-text-base\); \}/,
    );
    expect(css).toMatch(
      /\.cinder-section__title:is\(\[data-level='4'\], \[data-level='5'\], \[data-level='6'\]\) \{ font-size: var\(--cinder-text-sm\); color: var\(--cinder-text-muted\); \}/,
    );
  });

  test('renders the description, the action and the children, and nothing boxed', () => {
    const { container } = render(Section, {
      title: 'Upcoming',
      description: 'Next week',
      actions: text('See all'),
      children: text('Body'),
    });
    expect(container.querySelector('.cinder-section__description')?.textContent).toBe('Next week');
    expect(container.querySelector('.cinder-section__actions')?.textContent).toBe('See all');
    expect(container.querySelector('.cinder-section__content')?.textContent).toBe('Body');
    expect(container.querySelector('.cinder-card')).toBeNull();
  });

  test('omits the description, action and content parts when not given', () => {
    const { container } = render(Section, { title: 'Empty' });
    expect(container.querySelector('.cinder-section__description')).toBeNull();
    expect(container.querySelector('.cinder-section__actions')).toBeNull();
    expect(container.querySelector('.cinder-section__content')).toBeNull();
  });

  test('merges a custom class', () => {
    const { container } = render(Section, { title: 'A', class: 'extra' });
    expect(container.querySelector('section')?.classList.contains('extra')).toBe(true);
  });

  test('stylesheet never shrinks a section or its children and draws no box', () => {
    const css = readFileSync(new URL('./section.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.cinder-section \{[^}]*flex: none/);
    expect(css).toMatch(/\.cinder-section__content \{[^}]*display: block/);
    expect(css).toMatch(/\.cinder-section__content > :where\(\*\) \{[^}]*flex-shrink: 0/);
    expect(css).not.toMatch(/\.cinder-section \{[^}]*(border|background|box-shadow)/);
  });

  test('stylesheet styles parts by class, never by element descendant', () => {
    const css = readFileSync(new URL('./section.css', import.meta.url), 'utf8');
    expect(css).not.toMatch(/\.cinder-section[\w-]*\s+(span|p|div|a|h\d)\b/);
  });
});
