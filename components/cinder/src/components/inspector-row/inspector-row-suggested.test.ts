/// <reference lib="dom" />
// COR-2326: a suggested value says so in quiet accent words under the row's label, with no tint,
// border or pill.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

import { declarationsFor } from '../../test/css.ts';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: InspectorRow } = await import('./inspector-row.svelte');

const text = (value: string) => createRawSnippet(() => ({ render: () => `<span>${value}</span>` }));

const css = readFileSync(new URL('./inspector-row.css', import.meta.url), 'utf8');

describe('InspectorRow suggested', () => {
  test('a suggested row draws a "Suggested" label in its term and marks the row', () => {
    const { container } = render(InspectorRow, {
      props: { label: 'Context', value: text('Phone'), suggested: true },
    });
    const row = container.querySelector('.cinder-inspector-row');
    expect(row?.hasAttribute('data-cinder-suggested')).toBe(true);
    expect(container.querySelector('dt .cinder-inspector-row__suggested')?.textContent).toBe(
      'Suggested',
    );
    expect(container.querySelector('.cinder-inspector-row__label-text')?.textContent).toBe(
      'Context',
    );
    expect(container.querySelector('dd')?.textContent?.trim()).toBe('Phone');
  });

  test('suggestedLabel changes the words, and an editable row is named with them', () => {
    const { container } = render(InspectorRow, {
      props: {
        label: 'Context',
        value: text('Phone'),
        kind: 'text',
        current: 'Phone',
        suggested: true,
        suggestedLabel: 'Suggested wording',
      },
    });
    expect(container.querySelector('.cinder-inspector-row__suggested')?.textContent).toBe(
      'Suggested wording',
    );
    const term = container.querySelector('dt');
    const trigger = container.querySelector('.cinder-inspector-row__trigger');
    expect(trigger?.getAttribute('aria-labelledby')?.split(' ')[0]).toBe(term?.id);
  });

  test('a row that is not suggested draws no label and no marker', () => {
    const { container } = render(InspectorRow, {
      props: { label: 'Created', value: text('Nov 10') },
    });
    expect(container.querySelector('.cinder-inspector-row__suggested')).toBeNull();
    expect(container.querySelector('dt')?.textContent?.trim()).toBe('Created');
    expect(
      container.querySelector('.cinder-inspector-row')?.hasAttribute('data-cinder-suggested'),
    ).toBe(false);
  });

  test('the label is quiet accent text on its own line, with no tint, border or pill', () => {
    const label = declarationsFor(css, '.cinder-inspector-row__suggested');
    expect(label.get('color')).toBe('var(--cinder-accent-text)');
    expect(label.get('font-size')).toBe('var(--cinder-text-sm)');
    expect(label.get('flex-basis')).toBe('100%');
    for (const property of ['background', 'border', 'border-radius', 'padding', 'outline']) {
      expect(label.has(property)).toBe(false);
    }
    expect(
      declarationsFor(
        css,
        '.cinder-inspector-row[data-cinder-suggested] > .cinder-inspector-row__label',
      ).get('flex-wrap'),
    ).toBe('wrap');
  });
});
