/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, fireEvent, waitFor } = await import('@testing-library/svelte');
const { default: InspectorRow } = await import('./inspector-row.svelte');
const { default: EditorFixture } = await import('./inspector-row-editor-fixture.svelte');

const text = (value: string) => createRawSnippet(() => ({ render: () => `<span>${value}</span>` }));

const options = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
];

describe('InspectorRow anatomy', () => {
  test('renders the label as the term and the value as the definition', () => {
    const { container } = render(InspectorRow, {
      props: { label: 'Created', value: text('Nov 10') },
    });
    expect(container.querySelector('dt')?.textContent?.trim()).toBe('Created');
    expect(container.querySelector('dd')?.textContent?.trim()).toBe('Nov 10');
  });

  test('a row with no kind or editor is read-only: no button and no chevron', () => {
    const { container } = render(InspectorRow, {
      props: { label: 'Created', value: text('Nov 10') },
    });
    const row = container.querySelector('.cinder-inspector-row');
    expect(row?.hasAttribute('data-cinder-readonly')).toBe(true);
    expect(row?.hasAttribute('data-cinder-editable')).toBe(false);
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('.cinder-inspector-row__chevron')).toBeNull();
  });

  test('an editable row is a button named by its label and value, with a chevron', () => {
    const { container } = render(InspectorRow, {
      props: { label: 'Title', value: text('Plan'), kind: 'text', current: 'Plan' },
    });
    const row = container.querySelector('.cinder-inspector-row');
    expect(row?.hasAttribute('data-cinder-editable')).toBe(true);
    expect(row?.hasAttribute('data-cinder-readonly')).toBe(false);
    const button = container.querySelector('button');
    const labelledBy = (button?.getAttribute('aria-labelledby') ?? '').split(' ');
    expect(labelledBy).toHaveLength(2);
    expect(container.querySelector(`[id="${labelledBy[0]}"]`)?.textContent).toContain('Title');
    expect(container.querySelector(`[id="${labelledBy[1]}"]`)?.textContent).toContain('Plan');
    expect(container.querySelector('.cinder-inspector-row__chevron')).not.toBeNull();
  });

  test('disabled draws an editable row as read-only', () => {
    const { container } = render(InspectorRow, {
      props: { label: 'Title', value: text('Plan'), kind: 'text', disabled: true },
    });
    expect(container.querySelector('button')).toBeNull();
    expect(
      container.querySelector('.cinder-inspector-row')?.hasAttribute('data-cinder-readonly'),
    ).toBe(true);
  });

  test('draws the icon before the label, hidden from assistive technology', () => {
    const { container } = render(InspectorRow, {
      props: { label: 'Due', value: text('Fri'), icon: text('i') },
    });
    const icon = container.querySelector('.cinder-inspector-row__icon');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('dt')?.firstElementChild).toBe(icon);
  });

  test('merges a custom class', () => {
    const { container } = render(InspectorRow, {
      props: { label: 'A', value: text('B'), class: 'extra' },
    });
    expect(container.querySelector('.cinder-inspector-row')?.classList.contains('extra')).toBe(
      true,
    );
  });
});

describe('InspectorRow text editor', () => {
  test('activation opens a focused text field that starts from the current value', async () => {
    const { container } = render(InspectorRow, {
      props: { label: 'Title', value: text('Plan'), kind: 'text', current: 'Plan' },
    });
    await fireEvent.click(container.querySelector('button') as HTMLButtonElement);
    const field = container.querySelector('input[type="text"]') as HTMLInputElement;
    expect(field.value).toBe('Plan');
    expect(field.getAttribute('aria-label')).toBe('Edit Title');
    expect(container.querySelector('button')).toBeNull();
    await waitFor(() => expect(document.activeElement === field).toBe(true));
  });

  test('Enter commits the typed value and returns focus to the row', async () => {
    const commits: unknown[] = [];
    const { container } = render(InspectorRow, {
      props: {
        label: 'Title',
        value: text('Plan'),
        kind: 'text',
        current: 'Plan',
        onCommit: (next: unknown) => commits.push(next),
      },
    });
    await fireEvent.click(container.querySelector('button') as HTMLButtonElement);
    const field = container.querySelector('input') as HTMLInputElement;
    await fireEvent.input(field, { target: { value: 'Launch' } });
    await fireEvent.keyDown(field, { key: 'Enter' });
    expect(commits).toEqual(['Launch']);
    expect(container.querySelector('input')).toBeNull();
    const button = container.querySelector('button') as HTMLButtonElement;
    await waitFor(() => expect(document.activeElement === button).toBe(true));
  });

  test('Escape cancels without committing and returns focus to the row', async () => {
    const commits: unknown[] = [];
    let cancels = 0;
    const { container } = render(InspectorRow, {
      props: {
        label: 'Title',
        value: text('Plan'),
        kind: 'text',
        current: 'Plan',
        onCommit: (next: unknown) => commits.push(next),
        onCancel: () => cancels++,
      },
    });
    await fireEvent.click(container.querySelector('button') as HTMLButtonElement);
    const field = container.querySelector('input') as HTMLInputElement;
    await fireEvent.input(field, { target: { value: 'Discarded' } });
    await fireEvent.keyDown(document, { key: 'Escape' });
    expect(commits).toEqual([]);
    expect(cancels).toBe(1);
    expect(container.querySelector('input')).toBeNull();
    const button = container.querySelector('button') as HTMLButtonElement;
    await waitFor(() => expect(document.activeElement === button).toBe(true));
  });

  test('leaving the field commits the typed value once', async () => {
    const commits: unknown[] = [];
    const { container } = render(InspectorRow, {
      props: {
        label: 'Title',
        value: text('Plan'),
        kind: 'text',
        current: 'Plan',
        onCommit: (next: unknown) => commits.push(next),
      },
    });
    await fireEvent.click(container.querySelector('button') as HTMLButtonElement);
    const field = container.querySelector('input') as HTMLInputElement;
    await fireEvent.input(field, { target: { value: 'Ship it' } });
    await fireEvent.blur(field);
    expect(commits).toEqual(['Ship it']);
  });

  test('a custom edit label names the editor', async () => {
    const { container } = render(InspectorRow, {
      props: {
        label: 'Title',
        value: text('Plan'),
        kind: 'text',
        current: 'Plan',
        editLabel: 'Rename the plan',
      },
    });
    await fireEvent.click(container.querySelector('button') as HTMLButtonElement);
    expect(container.querySelector('input')?.getAttribute('aria-label')).toBe('Rename the plan');
  });
});

describe('InspectorRow select, date and toggle', () => {
  test('a select opens with its options and commits the chosen value', async () => {
    const commits: unknown[] = [];
    const { container } = render(InspectorRow, {
      props: {
        label: 'Status',
        value: text('Open'),
        kind: 'select',
        current: 'open',
        options,
        onCommit: (next: unknown) => commits.push(next),
      },
    });
    await fireEvent.click(container.querySelector('button') as HTMLButtonElement);
    const select = container.querySelector('select') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(['open', 'closed']);
    await fireEvent.change(select, { target: { value: 'closed' } });
    expect(commits).toEqual(['closed']);
    expect(container.querySelector('select')).toBeNull();
  });

  test('a date opens a date field and Enter commits its value', async () => {
    const commits: unknown[] = [];
    const { container } = render(InspectorRow, {
      props: {
        label: 'Due',
        value: text('Fri'),
        kind: 'date',
        current: '2026-11-30',
        onCommit: (next: unknown) => commits.push(next),
      },
    });
    await fireEvent.click(container.querySelector('button') as HTMLButtonElement);
    const field = container.querySelector('input[type="date"]') as HTMLInputElement;
    expect(field.value).toBe('2026-11-30');
    await fireEvent.input(field, { target: { value: '2026-12-01' } });
    await fireEvent.keyDown(field, { key: 'Enter' });
    expect(commits).toEqual(['2026-12-01']);
  });

  test('a toggle is a switch that commits the opposite state without opening an editor', async () => {
    const commits: unknown[] = [];
    const { container } = render(InspectorRow, {
      props: {
        label: 'Notify',
        value: text('On'),
        kind: 'toggle',
        current: true,
        onCommit: (next: unknown) => commits.push(next),
      },
    });
    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('role')).toBe('switch');
    expect(button.getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('.cinder-inspector-row__switch')).not.toBeNull();
    expect(container.querySelector('.cinder-inspector-row__chevron')).toBeNull();
    await fireEvent.click(button);
    expect(commits).toEqual([false]);
    expect(container.querySelector('input')).toBeNull();
  });
});

describe('InspectorRow popover editor', () => {
  test('the row is a popover trigger and a commit from the editor reports its value', async () => {
    const commits: unknown[] = [];
    const { container } = render(EditorFixture, {
      props: { onCommit: (next: unknown) => commits.push(next) },
    });
    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(document.querySelector('[data-testid="pick"]')).not.toBeNull());
    await fireEvent.click(document.querySelector('[data-testid="pick"]') as HTMLElement);
    expect(commits).toEqual(['Grace']);
    await waitFor(() => expect(button.getAttribute('aria-expanded')).toBe('false'));
  });

  test('a cancel from the editor reports a cancel and never a commit', async () => {
    const commits: unknown[] = [];
    let cancels = 0;
    const { container } = render(EditorFixture, {
      props: { onCommit: (next: unknown) => commits.push(next), onCancel: () => cancels++ },
    });
    await fireEvent.click(container.querySelector('button') as HTMLButtonElement);
    await waitFor(() => expect(document.querySelector('[data-testid="drop"]')).not.toBeNull());
    await fireEvent.click(document.querySelector('[data-testid="drop"]') as HTMLElement);
    expect(cancels).toBe(1);
    expect(commits).toEqual([]);
  });
});

describe('InspectorRow stylesheet', () => {
  const css = readFileSync(new URL('./inspector-row.css', import.meta.url), 'utf8');

  test('uses a 140px label column, a 44px minimum height and an inset separator', () => {
    expect(css).toMatch(/\.cinder-inspector-row \{[^}]*grid-template-columns: 8\.75rem/);
    expect(css).toMatch(/\.cinder-inspector-row \{[^}]*min-block-size: 2\.75rem/);
    expect(css).toMatch(
      /:not\(:last-child\)::after \{[^}]*inset-inline: var\(--cinder-space-4\) 0/,
    );
  });

  test('the label is muted and the value keeps the default text colour', () => {
    expect(css).toMatch(/__label \{[^}]*color: var\(--cinder-text-muted\)/);
    expect(css).toMatch(/\.cinder-inspector-row \{[^}]*color: var\(--cinder-text-default\)/);
  });

  test('an editable row draws a hover tint and a chevron, and a read-only row does not', () => {
    expect(css).toMatch(/__trigger:hover \{[^}]*background: var\(--cinder-surface-hover\)/);
    expect(css).toMatch(/__chevron \{[^}]*color: var\(--cinder-text-subtle\)/);
    expect(css).not.toMatch(/\[data-cinder-readonly\][^{]*:hover/);
  });

  test('below 700px the label stacks above the value', () => {
    expect(css).toMatch(
      /@media \(width < 700px\) \{\s*\.cinder-inspector-row \{[^}]*grid-template-columns: minmax\(0, 1fr\)/,
    );
  });

  test('styles parts by class, never by element descendant', () => {
    expect(css).not.toMatch(/\.cinder-inspector-row[\w-]*\s+(span|p|div|a|li|dt|dd)\b/);
  });
});
