/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, fireEvent, waitFor, cleanup } = await import('@testing-library/svelte');
const { default: Combobox } = await import('./combobox.svelte');
const { resetEscapeStack } = await import('../../_internal/overlay.ts');

beforeEach(() => {
  document.body.replaceChildren();
  resetEscapeStack();
});
afterEach(() => cleanup());

/** Groups interleave in the input on purpose: display order differs from source order. */
const workflows = [
  { value: 'review', label: 'Review a pull request', group: 'Recent' },
  { value: 'chat', label: 'Chat with an agent' },
  { value: 'triage', label: 'Triage issues', group: 'Built in' },
  { value: 'deploy', label: 'Deploy a build', group: 'Recent' },
  { value: 'digest', label: 'Daily digest', group: 'Built in' },
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
    (option) => option.textContent?.trim() ?? '',
  );
}

async function openList(id: string): Promise<HTMLInputElement> {
  const input = requiredInstance(document.body.querySelector(`#${id}`), HTMLInputElement);
  await fireEvent.focus(input);
  await waitFor(() => {
    if (document.body.querySelector('[role="option"]') === null) throw new Error('not open');
  });
  return input;
}

describe('Combobox grouped options', () => {
  test('renders ungrouped options first, then each group under a heading with its count', async () => {
    render(Combobox, { id: 'workflow', options: workflows });
    await openList('workflow');

    expect(optionLabels()).toEqual([
      'Chat with an agent',
      'Review a pull request',
      'Deploy a build',
      'Triage issues',
      'Daily digest',
    ]);
    expect(headings()).toEqual([
      { name: 'Recent', count: '2' },
      { name: 'Built in', count: '2' },
    ]);
  });

  test('each group is a role="group" named by its heading, and owns its options', async () => {
    render(Combobox, { id: 'workflow', options: workflows });
    await openList('workflow');

    const groups = Array.from(document.body.querySelectorAll('[role="group"]'));
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      const labelledBy = group.getAttribute('aria-labelledby') ?? '';
      const heading = document.getElementById(labelledBy);
      expect(heading).not.toBeNull();
      // The count is decorative, so the group's name is the group alone.
      expect(heading?.textContent?.trim()).toMatch(/^(Recent|Built in)$/);
      expect(group.querySelectorAll('[role="option"]')).toHaveLength(2);
    }
    // Ungrouped options sit directly in the listbox, outside any group.
    const chat = Array.from(document.body.querySelectorAll('[role="option"]')).find((option) =>
      option.textContent?.includes('Chat with an agent'),
    );
    expect(chat?.closest('[role="group"]')).toBeNull();
  });

  test('typing filters across groups, keeps headings of groups that still match and drops the rest', async () => {
    render(Combobox, { id: 'workflow', options: workflows });
    const input = await openList('workflow');

    await fireEvent.input(input, { target: { value: 'di' } });
    await waitFor(() => {
      expect(optionLabels()).toEqual(['Daily digest']);
    });
    expect(headings()).toEqual([{ name: 'Built in', count: '1' }]);

    await fireEvent.input(input, { target: { value: 'g' } });
    await waitFor(() => {
      expect(optionLabels()).toEqual(['Chat with an agent', 'Triage issues', 'Daily digest']);
    });
    expect(headings()).toEqual([{ name: 'Built in', count: '2' }]);
  });

  test('a query that matches nothing removes every heading and shows the empty state', async () => {
    render(Combobox, { id: 'workflow', options: workflows });
    const input = await openList('workflow');

    await fireEvent.input(input, { target: { value: 'zzz' } });
    await waitFor(() => {
      expect(
        document.body.querySelector('.cinder-combobox__empty[data-cinder-active]'),
      ).not.toBeNull();
    });
    expect(headings()).toEqual([]);
    expect(optionLabels()).toEqual([]);
  });

  test('keyboard navigation follows display order across a group boundary', async () => {
    const values: string[] = [];
    render(Combobox, {
      id: 'workflow',
      options: workflows,
      onValueChange: (value: string) => values.push(value),
    });
    const input = await openList('workflow');

    // Display order: chat, review, deploy, triage, digest. Source order would put
    // `triage` third, so landing on `deploy` and then crossing into `Built in`
    // proves navigation, ids and rendering share one order.
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => {
      const active = document.body.querySelector('[role="option"][data-cinder-active]');
      expect(active?.textContent?.trim()).toBe('Triage issues');
      expect(input.getAttribute('aria-activedescendant')).toBe(active?.id ?? 'missing');
    });

    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(values).toEqual(['triage']);
    expect(input.value).toBe('Triage issues');
  });

  test('End selects the last option of the last group', async () => {
    const values: string[] = [];
    render(Combobox, {
      id: 'workflow',
      options: workflows,
      onValueChange: (value: string) => values.push(value),
    });
    const input = await openList('workflow');

    await fireEvent.keyDown(input, { key: 'End' });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(values).toEqual(['digest']);
  });

  test('mousedown on an option in a later group selects that option', async () => {
    const values: string[] = [];
    render(Combobox, {
      id: 'workflow',
      options: workflows,
      onValueChange: (value: string) => values.push(value),
    });
    await openList('workflow');

    const option = Array.from(document.body.querySelectorAll('[role="option"]')).find((candidate) =>
      candidate.textContent?.includes('Triage issues'),
    );
    await fireEvent.mouseDown(requiredInstance(option ?? null, HTMLElement));
    expect(values).toEqual(['triage']);
  });

  test('maxVisibleOptions caps the display-ordered list, so ungrouped options survive the cap', async () => {
    render(Combobox, { id: 'workflow', options: workflows, maxVisibleOptions: 2 });
    await openList('workflow');

    expect(optionLabels()).toEqual(['Chat with an agent', 'Review a pull request']);
    expect(headings()).toEqual([{ name: 'Recent', count: '1' }]);
  });

  test('treats blank group names as ungrouped and renders no group markup without groups', async () => {
    render(Combobox, {
      id: 'plain',
      options: [
        { value: 'a', label: 'Alpha', group: '  ' },
        { value: 'b', label: 'Beta' },
      ],
    });
    await openList('plain');

    expect(optionLabels()).toEqual(['Alpha', 'Beta']);
    expect(document.body.querySelector('[role="group"]')).toBeNull();
    expect(headings()).toEqual([]);
  });
});
