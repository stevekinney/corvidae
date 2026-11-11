/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, fireEvent } = await import('@testing-library/svelte');
const { default: GroupedList } = await import('./grouped-list.svelte');

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
});
