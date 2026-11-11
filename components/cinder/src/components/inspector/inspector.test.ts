/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: Inspector } = await import('./inspector.svelte');

const rows = createRawSnippet(() => ({
  render: () => '<div class="row"><dt>Status</dt><dd>Open</dd></div>',
}));

describe('Inspector', () => {
  test('renders a description list holding the rows', () => {
    const { container } = render(Inspector, { children: rows });
    const list = container.querySelector('dl.cinder-inspector__group');
    expect(list).not.toBeNull();
    expect(list?.querySelectorAll('.row')).toHaveLength(1);
  });

  test('a header sits outside the group and names it', () => {
    const { container } = render(Inspector, { header: 'Details', children: rows });
    const header = container.querySelector('.cinder-inspector__header');
    const group = container.querySelector('[role="group"]');
    expect(header?.textContent).toBe('Details');
    expect(group?.getAttribute('aria-labelledby')).toBe(header?.id);
    expect(container.querySelector('dl')?.contains(header ?? null)).toBe(false);
  });

  test('without a header there is no header part and no group role', () => {
    const { container } = render(Inspector, { children: rows });
    expect(container.querySelector('.cinder-inspector__header')).toBeNull();
    expect(container.querySelector('[role="group"]')).toBeNull();
  });

  test('merges a custom class and forwards attributes', () => {
    const { container } = render(Inspector, {
      class: 'extra',
      'data-testid': 'inspector',
      children: rows,
    });
    const root = container.querySelector('.cinder-inspector');
    expect(root?.classList.contains('extra')).toBe(true);
    expect(root?.getAttribute('data-testid')).toBe('inspector');
  });

  test('stylesheet tints the group, and raises it below 700px', () => {
    const css = readFileSync(new URL('./inspector.css', import.meta.url), 'utf8');
    expect(css).toMatch(/__group \{[^}]*background: var\(--cinder-surface-inset\)/);
    expect(css).toMatch(
      /@media \(width < 700px\) \{\s*\.cinder-inspector__group \{[^}]*background: var\(--cinder-surface-raised\)/,
    );
    expect(css).toMatch(/__group \{[^}]*overflow: hidden/);
  });
});
