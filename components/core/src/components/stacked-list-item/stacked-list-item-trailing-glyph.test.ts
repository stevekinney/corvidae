/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: StackedListItem } = await import('./stacked-list-item.svelte');

const GLYPH_CLASS = 'cinder-stacked-list-item--trailing-glyph';

function textSnippet(text: string) {
  return createRawSnippet(() => ({
    render: () => `<span>${text}</span>`,
    setup: () => {},
  }));
}

function rowOf(props: Record<string, unknown>): HTMLElement {
  const { container } = render(StackedListItem, {
    props: { title: textSnippet('Quarantined memories'), ...props },
  });
  return container.querySelector('li')!;
}

describe('StackedListItem trailing glyph (COR-2195)', () => {
  test('a non-interactive trailing glyph is marked, so the narrow layout keeps it beside the body', () => {
    const row = rowOf({ trailing: textSnippet('>'), trailingGlyph: true });
    expect(row.classList.contains('cinder-stacked-list-item--has-trailing')).toBe(true);
    expect(row.classList.contains(GLYPH_CLASS)).toBe(true);
  });

  test('a trailing region that is not marked a glyph is not, and drops under the body as before', () => {
    expect(rowOf({ trailing: textSnippet('Open') }).classList.contains(GLYPH_CLASS)).toBe(false);
  });

  test('trailing actions are never a glyph, even when the row is marked', () => {
    const row = rowOf({ trailingGlyph: true, actions: [{ label: 'Memory', href: '/memory' }] });
    expect(row.classList.contains('cinder-stacked-list-item--has-trailing')).toBe(true);
    expect(row.classList.contains(GLYPH_CLASS)).toBe(false);
  });

  test('a row with no trailing region is not marked', () => {
    expect(rowOf({ trailingGlyph: true }).classList.contains(GLYPH_CLASS)).toBe(false);
  });

  test('every rule of the 448px container query that drops trailing below the body spares a glyph', () => {
    const stylesheet = readFileSync(new URL('./stacked-list-item.css', import.meta.url), 'utf8');
    const query =
      /@container cinder-stacked-list-item \(max-width: 448px\) \{([\s\S]*?)\n {2}\}\n/.exec(
        stylesheet,
      );
    expect(query).not.toBeNull();
    const droppingRules = [...query![1]!.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((rule) => /'(?:trailing|leading body)/.test(rule[2] ?? ''))
      .map((rule) => rule[1] ?? '');
    expect(droppingRules.length).toBe(2);
    for (const selector of droppingRules) {
      expect(selector).toContain('.cinder-stacked-list-item--collapsed-actions');
      expect(selector).toContain(`.${GLYPH_CLASS}`);
    }
  });
});
