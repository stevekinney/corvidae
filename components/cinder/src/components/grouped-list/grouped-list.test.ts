/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, fireEvent } = await import('@testing-library/svelte');
const { default: GroupedList } = await import('./grouped-list.svelte');
const { declarationsFor } = await import('@lostgradient/component-tooling/test/css.ts');

const rows = createRawSnippet(() => ({ render: () => '<li class="row">Row</li>' }));

describe('GroupedList', () => {
  test('renders one list with the rows, the header outside it, and the list named by the header', () => {
    const { container } = render(GroupedList, { header: 'Wi-Fi', footer: 'Note', children: rows });
    const list = container.querySelector('ul');
    const header = container.querySelector('.cinder-grouped-list__header');
    expect(header?.textContent).toBe('Wi-Fi');
    expect(list?.contains(header ?? null)).toBe(false);
    expect(list?.getAttribute('aria-labelledby')).toBe(header?.id);
    expect(list?.querySelectorAll('.row')).toHaveLength(1);
    expect(container.querySelector('.cinder-grouped-list__footer')?.textContent).toBe('Note');
  });

  test('has no quick-add row unless onItemAdd is given', () => {
    const { container } = render(GroupedList, { children: rows });
    expect(container.querySelector('input')).toBeNull();
  });

  test('quick-add submits the trimmed text on Return and clears the input', async () => {
    const added: string[] = [];
    const { container } = render(GroupedList, {
      onItemAdd: (value: string) => added.push(value),
      addLabel: 'Add a task',
    });
    const input = container.querySelector('input');
    expect(input?.getAttribute('aria-label')).toBe('Add a task');
    if (!input) throw new Error('missing input');
    input.value = '  Buy milk  ';
    await fireEvent.input(input);
    await fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(added).toEqual(['Buy milk']);
    expect(input.value).toBe('');
  });

  test('quick-add ignores an empty entry', async () => {
    const added: string[] = [];
    const { container } = render(GroupedList, { onItemAdd: (value: string) => added.push(value) });
    await fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    expect(added).toEqual([]);
  });

  test('stylesheet draws one rounded surface with no border and a borderless quick-add input', () => {
    const css = readFileSync(new URL('./grouped-list.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.cinder-grouped-list__group \{[^}]*border-radius/);
    expect(css.split('@media')[0]).not.toMatch(/\.cinder-grouped-list__group \{[^}]*border:/);
    expect(css).toMatch(/\.cinder-grouped-list__add-input \{[^}]*border: 0/);
  });

  test('stylesheet styles parts by class, never by element descendant', () => {
    const css = readFileSync(new URL('./grouped-list.css', import.meta.url), 'utf8');
    expect(css).not.toMatch(/\.cinder-grouped-list[\w-]*\s+(span|p|div|a|li)\b/);
  });

  describe('more link (COR-2765)', () => {
    const css = readFileSync(new URL('./grouped-list.css', import.meta.url), 'utf8');

    test('with `more`, renders exactly one more link with the label and href', () => {
      const { container } = render(GroupedList, {
        children: rows,
        more: { label: 'View the whole History', href: '/history' },
      });
      const links = container.querySelectorAll('a.cinder-grouped-list__more');
      expect(links).toHaveLength(1);
      expect(links[0]?.textContent?.trim()).toBe('View the whole History');
      expect(links[0]?.getAttribute('href')).toBe('/history');
    });

    test('without `more`, no more link renders', () => {
      const { container } = render(GroupedList, { children: rows });
      expect(container.querySelector('.cinder-grouped-list__more')).toBeNull();
      expect(container.querySelector('.cinder-grouped-list__more-row')).toBeNull();
    });

    test('the more link is a Cinder Link in its `more` form, in the primary colour, outside the list', () => {
      const { container } = render(GroupedList, {
        children: rows,
        more: { label: 'View all', href: '/all' },
      });
      const link = container.querySelector('a.cinder-grouped-list__more');
      expect(link?.hasAttribute('data-cinder-link')).toBe(true);
      expect(link?.getAttribute('data-variant')).toBe('more');
      expect(link?.getAttribute('data-color')).toBe('primary');
      expect(container.querySelector('ul')?.contains(link ?? null)).toBe(false);
    });

    test('the more link follows the footer when both are set', () => {
      const { container } = render(GroupedList, {
        children: rows,
        footer: 'Showing the latest 3.',
        more: { label: 'View all', href: '/all' },
      });
      const footer = container.querySelector('.cinder-grouped-list__footer');
      const row = container.querySelector('.cinder-grouped-list__more-row');
      expect(footer && row).toBeTruthy();
      expect(footer!.compareDocumentPosition(row!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    test('the more row sits 8px under the group, on the group edge (COR-2768)', () => {
      const row = declarationsFor(css, '.cinder-grouped-list__more-row');
      expect(row.get('margin-block-start')).toBe('var(--cinder-space-2)');
      expect(row.get('padding-inline')).toBe('var(--_cinder-grouped-list-label-inset, 0)');
      expect(row.get('display')).toBe('flex');
    });
  });

  describe('header and footer edge (COR-2768)', () => {
    const css = readFileSync(new URL('./grouped-list.css', import.meta.url), 'utf8');

    test('no rule gives the header or footer inline padding or margin, so their text sits on the group edge', async () => {
      const { parse } = await import('postcss');
      const inline = /^(padding|margin)-inline(-start|-end)?$|^(padding|margin)$/;
      const offenders: string[] = [];
      parse(css).walkRules((rule) => {
        const selectors = rule.selector.split(',').map((entry) => entry.trim());
        const targets = selectors.some((entry) =>
          /\.cinder-grouped-list__(header|footer)$/.test(entry),
        );
        if (!targets) return;
        rule.walkDecls((declaration) => {
          if (!inline.test(declaration.prop)) return;
          const values = declaration.value.split(/\s+/);
          // The shorthands `padding` and `margin` carry inline values in their 2nd and 4th places.
          const inlineValues =
            declaration.prop === 'padding' || declaration.prop === 'margin'
              ? [values[1] ?? values[0], values[3] ?? values[1] ?? values[0]]
              : [declaration.value];
          // The one inset allowed is the private label inset, which is 0 unless a container whose
          // surface hides the group's sets it (a modal drawer).
          const allowed = new Set(['0', 'var(--_cinder-grouped-list-label-inset, 0)']);
          if (inlineValues.some((value) => !allowed.has(value))) {
            offenders.push(`${rule.selector} { ${declaration.prop}: ${declaration.value} }`);
          }
        });
      });
      expect(offenders).toEqual([]);
    });

    test('the header and footer read the private label inset, which defaults to the group edge', () => {
      for (const selector of ['.cinder-grouped-list__header', '.cinder-grouped-list__footer']) {
        expect(declarationsFor(css, selector).get('padding-inline')).toBe(
          'var(--_cinder-grouped-list-label-inset, 0)',
        );
      }
    });

    test('the quick-add row keeps its 16px inset, because its text is inside the surface', () => {
      expect(declarationsFor(css, '.cinder-grouped-list__add').get('padding-inline-start')).toBe(
        'var(--cinder-space-4)',
      );
    });
  });
});
