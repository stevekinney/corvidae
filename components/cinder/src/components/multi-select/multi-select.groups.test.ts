/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, fireEvent, waitFor, cleanup } = await import('@testing-library/svelte');
const { default: MultiSelect } = await import('./multi-select.svelte');
const { resetEscapeStack } = await import('../../_internal/overlay.ts');

beforeEach(() => {
  document.body.replaceChildren();
});
afterEach(() => {
  cleanup();
  resetEscapeStack();
});

/** Groups interleave in the input on purpose: display order differs from source order. */
const tools = [
  { id: 'search', label: 'Search the web', group: 'Search server' },
  { id: 'read', label: 'Read file', group: 'Built in' },
  { id: 'clock', label: 'Current time' },
  { id: 'index', label: 'Index documents', group: 'Search server' },
  { id: 'write', label: 'Write file', group: 'Built in' },
];

function headings(): { name: string; count: string }[] {
  return Array.from(document.body.querySelectorAll('.cinder-_option-group__heading')).map(
    (heading) => ({
      name: heading.querySelector('.cinder-_option-group__label')?.textContent?.trim() ?? '',
      count: heading.querySelector('.cinder-_option-group__count')?.textContent?.trim() ?? '',
    }),
  );
}

function optionLabels(): string[] {
  return Array.from(document.body.querySelectorAll('[role="option"]')).map(
    (option) =>
      option.querySelector('.cinder-multi-select__option-label')?.textContent?.trim() ?? '',
  );
}

async function open(): Promise<void> {
  const trigger = document.body.querySelector<HTMLButtonElement>('#tools');
  if (!trigger) throw new Error('trigger not found');
  await fireEvent.click(trigger);
  await waitFor(() => {
    expect(document.body.querySelector('[role="listbox"]')).not.toBeNull();
  });
}

describe('MultiSelect grouped items', () => {
  test('renders ungrouped items first, then each group under a heading with its count', async () => {
    render(MultiSelect, { id: 'tools', items: tools });
    await open();

    expect(optionLabels()).toEqual([
      'Current time',
      'Search the web',
      'Index documents',
      'Read file',
      'Write file',
    ]);
    expect(headings()).toEqual([
      { name: 'Search server', count: '2' },
      { name: 'Built in', count: '2' },
    ]);
  });

  test('each group is a role="group" named by its heading and owns its options', async () => {
    render(MultiSelect, { id: 'tools', items: tools });
    await open();

    const groups = Array.from(document.body.querySelectorAll('[role="group"]'));
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      const heading = document.getElementById(group.getAttribute('aria-labelledby') ?? '');
      expect(heading?.textContent?.trim()).toMatch(/^(Search server|Built in)$/);
      expect(group.querySelectorAll('[role="option"]')).toHaveLength(2);
    }
  });

  test('typing filters across groups, keeps headings of groups that still match and drops the rest', async () => {
    render(MultiSelect, { id: 'tools', items: tools, filterable: true });
    await open();
    const filter = document.body.querySelector<HTMLInputElement>('#tools-filter');
    if (!filter) throw new Error('filter not found');

    await fireEvent.input(filter, { target: { value: 'file' } });
    await waitFor(() => {
      expect(optionLabels()).toEqual(['Read file', 'Write file']);
    });
    expect(headings()).toEqual([{ name: 'Built in', count: '2' }]);

    await fireEvent.input(filter, { target: { value: 'e' } });
    await waitFor(() => {
      expect(headings().map((heading) => heading.name)).toEqual(['Search server', 'Built in']);
    });

    await fireEvent.input(filter, { target: { value: 'zzz' } });
    await waitFor(() => {
      expect(optionLabels()).toEqual([]);
    });
    expect(headings()).toEqual([]);
    expect(document.body.querySelector('.cinder-multi-select__empty')).not.toBeNull();
  });

  test('keyboard navigation follows display order across a group boundary', async () => {
    let selectedIds: string[] = [];
    render(MultiSelect, {
      id: 'tools',
      items: tools,
      filterable: true,
      get selectedIds() {
        return selectedIds;
      },
      set selectedIds(next: string[]) {
        selectedIds = next;
      },
    });
    await open();
    const filter = document.body.querySelector<HTMLInputElement>('#tools-filter');
    if (!filter) throw new Error('filter not found');

    // Display order: clock, search, index, read, write. Source order would put
    // `read` second, so landing on `read` after three ArrowDowns from `clock`
    // proves navigation, ids and rendering share one order across the boundary.
    await waitFor(() => {
      expect(document.body.querySelector('[role="option"][data-cinder-active]')).not.toBeNull();
    });
    await fireEvent.keyDown(filter, { key: 'ArrowDown' });
    await fireEvent.keyDown(filter, { key: 'ArrowDown' });
    await fireEvent.keyDown(filter, { key: 'ArrowDown' });
    await waitFor(() => {
      const active = document.body.querySelector('[role="option"][data-cinder-active]');
      expect(active?.textContent?.trim()).toBe('Read file');
    });

    await fireEvent.keyDown(filter, { key: 'Enter' });
    await waitFor(() => {
      expect(selectedIds).toEqual(['read']);
    });
  });

  test('mousedown on an item in a later group toggles that item', async () => {
    let selectedIds: string[] = [];
    render(MultiSelect, {
      id: 'tools',
      items: tools,
      get selectedIds() {
        return selectedIds;
      },
      set selectedIds(next: string[]) {
        selectedIds = next;
      },
    });
    await open();

    const option = Array.from(document.body.querySelectorAll('[role="option"]')).find((candidate) =>
      candidate.textContent?.includes('Write file'),
    );
    if (!option) throw new Error('option not found');
    await fireEvent.mouseDown(option);
    expect(selectedIds).toEqual(['write']);
  });

  test('promoting selected items stays within each group', async () => {
    render(MultiSelect, {
      id: 'tools',
      items: tools,
      selectedIds: ['write', 'index'],
      selectionFeedback: 'top',
    });
    await open();

    expect(optionLabels()).toEqual([
      'Current time',
      'Index documents',
      'Search the web',
      'Write file',
      'Read file',
    ]);
    expect(headings()).toEqual([
      { name: 'Search server', count: '2' },
      { name: 'Built in', count: '2' },
    ]);
  });

  test('renders no group markup when no item has a group', async () => {
    render(MultiSelect, {
      id: 'tools',
      items: [
        { id: 'a', label: 'Alpha', group: '' },
        { id: 'b', label: 'Beta' },
      ],
    });
    await open();

    expect(optionLabels()).toEqual(['Alpha', 'Beta']);
    expect(document.body.querySelector('[role="group"]')).toBeNull();
  });
});
