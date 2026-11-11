/// <reference lib="dom" />
import { afterEach, describe, expect, jest, mock, test } from 'bun:test';
import { flushSync } from 'svelte';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';
import type { ToolPickerGroup, ToolPickerItem } from './tool-picker.types.ts';

setupHappyDom();

// happy-dom does not implement HTMLDialogElement.showModal / close; stub them so the Modal's
// effect does not throw when open is true.
if (typeof HTMLDialogElement !== 'undefined') {
  if (!HTMLDialogElement.prototype.showModal) {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      value: function () {
        this.setAttribute('open', '');
      },
      configurable: true,
      writable: true,
    });
  }
  if (!HTMLDialogElement.prototype.close) {
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      value: function () {
        this.removeAttribute('open');
      },
      configurable: true,
      writable: true,
    });
  }
}

const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/svelte');
const { default: ToolPicker } = await import('./tool-picker.svelte');
const { default: Host } = await import('./tool-picker.fixture.svelte');

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  document.body.replaceChildren();
});

const groups: ToolPickerGroup[] = [
  { name: 'Built in' },
  { name: 'GitHub' },
  { name: 'Skills', note: 'they follow the tools they use' },
];

const tools: [string, string, string, string, string, string, string][] = [
  [
    'discover',
    'Discover agents',
    'bureau:discover-agents',
    'Finds other agents',
    'Built in',
    'Reads',
    'Never (default)',
  ],
  [
    'ask',
    'Ask a person',
    'bureau:ask-a-person',
    'Asks you a question',
    'Built in',
    'Reads',
    'Never (default)',
  ],
  [
    'create',
    'Create workflow',
    'workflows-create',
    'Drafts a workflow',
    'Built in',
    'Changes things',
    'On changes (default)',
  ],
  [
    'lookup',
    'Lookup order',
    'lookup-order',
    'Looks an order up',
    'Built in',
    'Reads',
    'Never (default)',
  ],
  [
    'refund',
    'Issue refund',
    'issue-refund',
    'Refunds an order',
    'Built in',
    'Dangerous',
    'Always (default)',
  ],
  [
    'triage',
    'Triage refunds',
    'triage-refunds',
    'Decides on refunds',
    'Built in',
    'Changes things',
    'On changes (default)',
  ],
  ['list', 'List issues', 'list_issues', 'Lists issues', 'GitHub', 'Reads', 'Never (default)'],
  [
    'open',
    'Create issue',
    'create_issue',
    'Opens an issue',
    'GitHub',
    'Changes things',
    'On changes (default)',
  ],
  [
    'branch',
    'Delete branch',
    'delete_branch',
    'Deletes a branch',
    'GitHub',
    'Dangerous',
    'Always (default)',
  ],
];

const items: ToolPickerItem[] = [
  ...tools.map(([value, label, code, description, group, meta, detail]) => ({
    value,
    label,
    code,
    description,
    group,
    meta,
    detail,
  })),
  {
    value: 'notes',
    label: 'Release notes',
    code: 'release-notes',
    suffix: 'Skill',
    description: 'Drafts release notes',
    group: 'Skills',
    detail: 'Follows its tools',
    selectable: false,
  },
  {
    value: 'style',
    label: 'Writing style',
    code: 'writing-style',
    suffix: 'Skill',
    description: 'Keeps replies short',
    group: 'Skills',
    detail: 'Follows its tools',
    selectable: false,
  },
];

const initial = ['lookup', 'refund', 'triage'];

function renderPicker(props: Record<string, unknown> = {}) {
  return render(ToolPicker as any, {
    props: { open: true, items, groups, selected: [...initial], ...props },
  });
}

function dialog(): HTMLElement {
  return requiredInstance(document.body.querySelector('dialog'), HTMLElement);
}

function counter(): string {
  return dialog().querySelector('.cinder-tool-picker__counter')?.textContent?.trim() ?? '';
}

function headings(): string[] {
  return Array.from(dialog().querySelectorAll('.cinder-tool-picker__group-heading')).map(
    (heading) => heading.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  );
}

function checkbox(name: string): HTMLInputElement {
  return requiredInstance(
    dialog().querySelector(`input[type="checkbox"][aria-label="${name}"]`),
    HTMLInputElement,
  );
}

function rowOf(name: string): HTMLElement {
  return requiredInstance(checkbox(name).closest('li'), HTMLElement);
}

describe('ToolPicker', () => {
  test('titles the dialog and counts the chosen tools out of every tool that can be chosen', () => {
    renderPicker();
    expect(dialog().querySelector('.cinder-modal__title')?.textContent).toBe(
      'Add tools and skills',
    );
    expect(counter()).toBe('3 of 9 tools chosen');
    expect(dialog().querySelector('.cinder-modal__close')).toBeNull();
  });

  test('groups the tools under headers with their counts, what is not chosen and the skills note', () => {
    renderPicker();
    expect(headings()).toEqual([
      'Built in, 6',
      'GitHub, 3, none chosen',
      'Skills, 2, they follow the tools they use',
    ]);
  });

  test('draws no "none chosen" until something is chosen', () => {
    renderPicker({ selected: [] });
    expect(headings()).toEqual([
      'Built in, 6',
      'GitHub, 3',
      'Skills, 2, they follow the tools they use',
    ]);
    expect(counter()).toBe('0 of 9 tools chosen');
  });

  test('a row carries a checkbox named for the tool, its identifier once, its description, risk and starting level', () => {
    renderPicker();
    const row = rowOf('Issue refund');
    expect(checkbox('Issue refund').checked).toBe(true);
    expect(row.querySelector('.cinder-tool-picker__name')?.textContent).toBe('Issue refund');
    expect(row.querySelector('code')?.textContent).toBe('issue-refund');
    expect(row.textContent?.match(/issue-refund/g)).toHaveLength(1);
    expect(row.querySelector('.cinder-tool-picker__description')?.textContent).toBe(
      'Refunds an order',
    );
    expect(row.querySelector('.cinder-tool-picker__meta')?.textContent).toBe('Dangerous');
    expect(row.querySelector('.cinder-tool-picker__detail')?.textContent).toBe('Always (default)');
    const description = requiredInstance(
      row.querySelector('.cinder-tool-picker__description'),
      HTMLElement,
    );
    expect(checkbox('Issue refund').getAttribute('aria-describedby')).toBe(description.id);
  });

  test('the tools that start checked are the ones selected, and GitHub starts unchecked', () => {
    renderPicker();
    for (const name of ['Lookup order', 'Issue refund', 'Triage refunds']) {
      expect(checkbox(name).checked).toBe(true);
    }
    for (const name of ['List issues', 'Create issue', 'Delete branch']) {
      expect(checkbox(name).checked).toBe(false);
    }
  });

  test('a skill has no checkbox, shows a dash named for the missing risk word and says it follows its tools', () => {
    renderPicker();
    const row = requiredInstance(
      Array.from(dialog().querySelectorAll('li')).find((li) =>
        li.textContent?.includes('Release notes'),
      ),
      HTMLElement,
    );
    expect(row.querySelector('input')).toBeNull();
    expect(row.querySelector('code')?.textContent).toBe('release-notes');
    expect(row.querySelector('.cinder-tool-picker__suffix')?.textContent).toBe(', Skill');
    const dash = requiredInstance(row.querySelector('[role="img"]'), HTMLElement);
    expect(dash.getAttribute('aria-label')).toBe('No risk word');
    expect(dash.textContent).toBe('—');
    expect(row.querySelector('.cinder-tool-picker__detail')?.textContent).toBe('Follows its tools');
  });

  test('checking a tool changes the counter and the group header', async () => {
    renderPicker();
    await fireEvent.click(checkbox('List issues'));
    expect(checkbox('List issues').checked).toBe(true);
    expect(counter()).toBe('4 of 9 tools chosen');
    expect(headings()[1]).toBe('GitHub, 3');
  });

  test('the counter is a polite live region', () => {
    renderPicker();
    expect(dialog().querySelector('.cinder-tool-picker__counter')?.getAttribute('aria-live')).toBe(
      'polite',
    );
  });

  test("clicking a row's text chooses the tool, as its checkbox does", async () => {
    renderPicker({ selected: [] });
    await fireEvent.click(
      requiredInstance(rowOf('List issues').querySelector('label'), HTMLElement),
    );
    expect(checkbox('List issues').checked).toBe(true);
  });

  test('has a search field named for what it searches, with that as its placeholder', () => {
    renderPicker();
    const search = requiredInstance(
      dialog().querySelector('input[type="search"]'),
      HTMLInputElement,
    );
    expect(search.getAttribute('placeholder')).toBe('Search tools and skills');
    const name =
      search.getAttribute('aria-label') ??
      dialog().querySelector(`label[for="${search.id}"]`)?.textContent ??
      '';
    expect(name).toContain('Search tools and skills');
  });
});

describe('ToolPicker search', () => {
  async function search(text: string) {
    const field = requiredInstance(
      dialog().querySelector('input[type="search"]'),
      HTMLInputElement,
    );
    await fireEvent.input(field, { target: { value: text } });
    return field;
  }

  test('narrows the list to what matches and the group counts follow', async () => {
    renderPicker();
    await search('issue');
    expect(headings()).toEqual(['Built in, 1', 'GitHub, 2, none chosen']);
    expect(dialog().querySelector('input[aria-label="Issue refund"]')).not.toBeNull();
    expect(dialog().querySelector('input[aria-label="Lookup order"]')).toBeNull();
    expect(counter()).toBe('3 of 9 tools chosen');
  });

  test('filtered to nothing keeps the text, says what to try and offers one action', async () => {
    renderPicker();
    const field = await search('invoice');
    expect(field.value).toBe('invoice');
    expect(dialog().querySelector('.cinder-tool-picker__empty-title')?.textContent).toBe(
      'No tools match “invoice”',
    );
    expect(dialog().querySelector('.cinder-tool-picker__empty-hint')?.textContent).toBe(
      'Try a shorter word.',
    );
    const buttons = dialog().querySelectorAll('.cinder-tool-picker__empty button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent?.trim()).toBe('Clear search');
    expect(dialog().querySelector('input[type="checkbox"]')).toBeNull();
  });

  test('opens on a search when given a query, filtered to nothing (row 43p)', () => {
    renderPicker({ query: 'invoice' });
    const field = requiredInstance(
      dialog().querySelector<HTMLInputElement>(
        'input[type="search"], input[aria-label="Search tools and skills"]',
      ),
      HTMLInputElement,
    );
    expect(field.value).toBe('invoice');
    expect(dialog().querySelector('.cinder-tool-picker__empty-title')?.textContent).toBe(
      'No tools match “invoice”',
    );
  });

  test('a query set before the picker opens survives the opening, and closing clears it (row 43p)', async () => {
    const { container } = render(Host as any, {
      props: { items, groups, query: 'invoice' },
    });
    const field = () =>
      requiredInstance(
        dialog().querySelector<HTMLInputElement>(
          'input[type="search"], input[aria-label="Search tools and skills"]',
        ),
        HTMLInputElement,
      );
    const open = () =>
      fireEvent.click(
        requiredInstance(container.querySelector('[data-testid="open"]'), HTMLElement),
      );
    await open();
    expect(field().value).toBe('invoice');
    expect(dialog().querySelector('.cinder-tool-picker__empty-title')?.textContent).toBe(
      'No tools match “invoice”',
    );
    await fireEvent.click(
      requiredInstance(
        Array.from(dialog().querySelectorAll('.cinder-modal__footer button')).find(
          (button) => button.textContent?.trim() === 'Cancel',
        ),
        HTMLElement,
      ),
    );
    await open();
    expect(field().value).toBe('');
  });

  test('Clear search empties the field, restores the list and returns focus to the field', async () => {
    renderPicker();
    const field = await search('invoice');
    await fireEvent.click(
      requiredInstance(dialog().querySelector('.cinder-tool-picker__empty button'), HTMLElement),
    );
    expect(field.value).toBe('');
    expect(headings()).toHaveLength(3);
    expect(document.activeElement === field).toBe(true);
  });

  test('takes its own words for the empty state', async () => {
    renderPicker({
      itemNoun: 'actions',
      noMatchTitle: (query: string) => `Nothing called ${query}`,
      noMatchHint: 'Check the spelling.',
      clearSearchLabel: 'Start over',
    });
    await search('zzz');
    expect(dialog().querySelector('.cinder-tool-picker__empty-title')?.textContent).toBe(
      'Nothing called zzz',
    );
    expect(dialog().querySelector('.cinder-tool-picker__empty-hint')?.textContent).toBe(
      'Check the spelling.',
    );
    expect(dialog().querySelector('.cinder-tool-picker__empty button')?.textContent?.trim()).toBe(
      'Start over',
    );
  });

  test('says there is nothing to choose from when the list is empty and no search is typed', () => {
    renderPicker({ items: [], selected: [] });
    expect(dialog().querySelector('.cinder-tool-picker__none')?.textContent).toBe(
      'No tools to choose from.',
    );
  });
});

describe('ToolPicker Done and Cancel', () => {
  test('Done writes the choices back in the order of the list and calls onDone', async () => {
    const onDone = mock();
    const { container } = render(Host as any, {
      props: { items, groups, initial: ['triage', 'lookup'], onDone },
    });
    expect(container.querySelector('[data-testid="chosen"]')?.textContent).toBe('triage,lookup');
    await fireEvent.click(
      requiredInstance(container.querySelector('[data-testid="open"]'), HTMLElement),
    );
    await fireEvent.click(checkbox('List issues'));
    await fireEvent.click(checkbox('Discover agents'));
    await fireEvent.click(
      requiredInstance(
        Array.from(dialog().querySelectorAll('.cinder-modal__footer button')).find(
          (button) => button.textContent?.trim() === 'Done',
        ),
        HTMLElement,
      ),
    );
    expect(onDone).toHaveBeenCalledWith(['discover', 'lookup', 'triage', 'list']);
    expect(container.querySelector('[data-testid="chosen"]')?.textContent).toBe(
      'discover,lookup,triage,list',
    );
  });

  test("Cancel leaves the page's choices alone, and reopening starts from them again", async () => {
    const onCancel = mock();
    const { container } = render(Host as any, {
      props: { items, groups, initial: ['lookup'], onCancel },
    });
    await fireEvent.click(
      requiredInstance(container.querySelector('[data-testid="open"]'), HTMLElement),
    );
    await fireEvent.click(checkbox('List issues'));
    await fireEvent.click(
      requiredInstance(
        Array.from(dialog().querySelectorAll('.cinder-modal__footer button')).find(
          (button) => button.textContent?.trim() === 'Cancel',
        ),
        HTMLElement,
      ),
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="chosen"]')?.textContent).toBe('lookup');

    await fireEvent.click(
      requiredInstance(container.querySelector('[data-testid="open"]'), HTMLElement),
    );
    expect(checkbox('List issues').checked).toBe(false);
    expect(checkbox('Lookup order').checked).toBe(true);
  });

  test('a choice no item names is kept through Done', async () => {
    const onDone = mock();
    const { container } = render(Host as any, {
      props: { items, groups, initial: ['gone', 'lookup'], onDone },
    });
    await fireEvent.click(
      requiredInstance(container.querySelector('[data-testid="open"]'), HTMLElement),
    );
    await fireEvent.click(
      requiredInstance(
        Array.from(dialog().querySelectorAll('.cinder-modal__footer button')).find(
          (button) => button.textContent?.trim() === 'Done',
        ),
        HTMLElement,
      ),
    );
    expect(onDone).toHaveBeenCalledWith(['lookup', 'gone']);
  });

  test('Escape closes the picker as Cancel does', async () => {
    const onCancel = mock();
    renderPicker({ onCancel });
    await fireEvent(dialog(), new Event('cancel', { cancelable: true }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });

  test('takes its own button labels', () => {
    renderPicker({ doneLabel: 'Add', cancelLabel: 'Never mind' });
    expect(
      Array.from(dialog().querySelectorAll('.cinder-modal__footer button')).map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(['Never mind', 'Add']);
  });
});

describe('ToolPicker loading', () => {
  test('keeps the title and a live search field, and shows three skeleton rows only after 300 ms', () => {
    jest.useFakeTimers();
    renderPicker({ loading: true, items: [], selected: [] });
    flushSync();
    expect(dialog().querySelector('.cinder-modal__title')?.textContent).toBe(
      'Add tools and skills',
    );
    const search = requiredInstance(
      dialog().querySelector('input[type="search"]'),
      HTMLInputElement,
    );
    expect(search.disabled).toBe(false);
    expect(dialog().querySelector('.cinder-skeleton')).toBeNull();
    jest.advanceTimersByTime(299);
    flushSync();
    expect(dialog().querySelector('.cinder-skeleton')).toBeNull();
    jest.advanceTimersByTime(1);
    flushSync();
    expect(dialog().querySelectorAll('.cinder-skeleton')).toHaveLength(3);
  });

  test('announces what is loading and shows no checkboxes or empty state', () => {
    jest.useFakeTimers();
    renderPicker({ loading: true, items: [], selected: [] });
    jest.advanceTimersByTime(300);
    flushSync();
    expect(dialog().querySelector('[role="status"]')?.textContent).toBe('Loading tools and skills');
    expect(dialog().querySelector('input[type="checkbox"]')).toBeNull();
    expect(dialog().querySelector('.cinder-tool-picker__empty')).toBeNull();
  });

  test('shows no counter while loading, then the count once the list arrives', () => {
    const { rerender } = renderPicker({ loading: true, items: [] });
    flushSync();
    expect(dialog().querySelector('.cinder-tool-picker__counter')).toBeNull();
    expect(dialog().textContent).not.toContain('0 of 0');
    rerender({ loading: false, items, groups });
    flushSync();
    expect(counter()).toBe('3 of 9 tools chosen');
  });

  test('Done waits until the list has loaded', () => {
    renderPicker({ loading: true, items: [], selected: [] });
    const done = Array.from(dialog().querySelectorAll('.cinder-modal__footer button')).find(
      (button) => button.textContent?.trim() === 'Done',
    ) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
  });
});

describe('ToolPicker with forty or more tools', () => {
  const sources: [string, number][] = [
    ['Built in', 6],
    ['GitHub', 21],
    ['Payments API', 15],
  ];
  const many: ToolPickerItem[] = sources.flatMap(([group, count]) =>
    Array.from({ length: count }, (_, index) => ({
      value: `${group}-${index}`,
      label: `${group} tool ${index + 1}`,
      description: `Does thing ${index + 1}`,
      group,
    })),
  );

  function groupButtons(): HTMLButtonElement[] {
    return Array.from(
      dialog().querySelectorAll<HTMLButtonElement>('.cinder-tool-picker__group-toggle'),
    );
  }

  test('the counter reads the total instead of the chosen count', () => {
    renderPicker({ items: many, groups: undefined, selected: [] });
    expect(counter()).toBe('42 tools');
  });

  test('the counter adds what is chosen once something is', () => {
    renderPicker({ items: many, groups: undefined, selected: ['Built in-0', 'GitHub-3'] });
    expect(counter()).toBe('42 tools, 2 chosen');
  });

  test('groups sit under sticky header buttons, the first open and the rest collapsed', () => {
    renderPicker({ items: many, groups: undefined, selected: [] });
    expect(headings()).toEqual(['Built in 6 tools', 'GitHub 21 tools', 'Payments API 15 tools']);
    expect(groupButtons().map((button) => button.getAttribute('aria-expanded'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    expect(dialog().querySelectorAll('input[type="checkbox"]')).toHaveLength(6);
    expect(
      dialog().querySelector('.cinder-tool-picker__list')?.hasAttribute('data-cinder-long'),
    ).toBe(true);
  });

  test('a header opens and closes its group, and points at the list it controls', async () => {
    renderPicker({ items: many, groups: undefined, selected: [] });
    const [, github] = groupButtons();
    await fireEvent.click(github!);
    expect(github?.getAttribute('aria-expanded')).toBe('true');
    expect(dialog().querySelectorAll('input[type="checkbox"]')).toHaveLength(27);
    const list = document.getElementById(github?.getAttribute('aria-controls') ?? '');
    expect(list?.querySelectorAll('li')).toHaveLength(21);
    await fireEvent.click(github!);
    expect(github?.getAttribute('aria-expanded')).toBe('false');
    expect(dialog().querySelectorAll('input[type="checkbox"]')).toHaveLength(6);
  });

  test('searching opens every group that has a match', async () => {
    renderPicker({ items: many, groups: undefined, selected: [] });
    await fireEvent.input(
      requiredInstance(dialog().querySelector('input[type="search"]'), HTMLInputElement),
      { target: { value: 'tool 15' } },
    );
    expect(headings()).toEqual(['GitHub 1 tools', 'Payments API 1 tools']);
    expect(dialog().querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  });

  test('a choice made in a group that is then collapsed is kept', async () => {
    renderPicker({ items: many, groups: undefined, selected: [] });
    await fireEvent.click(checkbox('Built in tool 1'));
    await fireEvent.click(groupButtons()[0]!);
    expect(counter()).toBe('42 tools, 1 chosen');
  });

  test('the threshold is a prop', () => {
    renderPicker({ items: many, groups: undefined, selected: [], collapseFrom: 100 });
    expect(counter()).toBe('0 of 42 tools chosen');
    expect(dialog().querySelector('.cinder-tool-picker__group-toggle')).toBeNull();
  });
});

describe('ToolPicker styles', () => {
  test('group headers are sticky and the list scrolls inside the dialog', async () => {
    const css = await Bun.file(new URL('./tool-picker.css', import.meta.url)).text();
    expect(css).toMatch(/\.cinder-tool-picker__group-heading \{[^}]*position: sticky/);
    expect(css).toMatch(/\.cinder-tool-picker__list \{[^}]*overflow-y: auto/);
    expect(css).toContain("@import '../modal/modal.css'");
  });
});
