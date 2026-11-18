/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, render } = await import('@testing-library/svelte');
const { default: DescriptionList } = await import('./description-list.svelte');

const css = readFileSync(new URL('./description-list.css', import.meta.url), 'utf8');

afterEach(() => cleanup());

/** The rules inside the `@container` block that opens with `query`, or an empty string. */
function containerBlock(query: string): string {
  const start = css.indexOf(`@container ${query} {`);
  if (start === -1) return '';
  let depth = 0;
  for (let index = css.indexOf('{', start); index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') depth -= 1;
    if (depth === 0) return css.slice(start, index + 1);
  }
  return '';
}

describe('DescriptionList fields: the PropertyRow trailing chevron', () => {
  test('a row with an href ends in a chevron link named for its term and value', () => {
    const { container } = render(DescriptionList, {
      variant: 'fields',
      items: [
        { term: 'Owner', definition: 'Ada Lovelace', href: '/people/ada' },
        { term: 'Created', definition: 'Nov 10, 2026' },
      ],
    });
    const [linked, readOnly] = container.querySelectorAll('.cinder-description-list__row');

    const link = linked?.querySelector('a.cinder-description-list__link');
    expect(link?.getAttribute('href')).toBe('/people/ada');
    expect(link?.getAttribute('aria-label')).toBe('Owner: Ada Lovelace');
    expect(link?.querySelector('svg')).not.toBeNull();
    expect(link?.parentElement?.tagName).toBe('DD');
    expect(link?.parentElement?.lastElementChild).toBe(link ?? null);
    expect(linked?.hasAttribute('data-cinder-linked')).toBe(true);

    expect(readOnly?.querySelector('.cinder-description-list__link')).toBeNull();
    expect(readOnly?.hasAttribute('data-cinder-linked')).toBe(false);
  });

  test('a framed list draws the tinted group and its linked row still ends in the chevron', () => {
    const { container } = render(DescriptionList, {
      variant: 'fields',
      framed: true,
      items: [{ term: 'Owner', definition: 'Ada Lovelace', href: '/people/ada' }],
    });
    expect(container.querySelector('dl')?.hasAttribute('data-cinder-framed')).toBe(true);
    // The fill is a pseudo-element under the rows, so the container query below can switch it.
    expect(css).toMatch(
      /\[data-cinder-variant='fields'\]\[data-cinder-framed\]::before\s*\{[^}]*background: var\(--cinder-surface-inset\)/s,
    );
    expect(container.querySelector('.cinder-description-list__link svg')).not.toBeNull();
  });

  test('a linked row whose value is not plain text is named for its term', () => {
    const { container } = render(DescriptionList, {
      variant: 'fields',
      items: [{ term: 'Run', definition: { type: 'code', value: 'run_01' }, href: '/runs/1' }],
    });
    expect(
      container.querySelector('.cinder-description-list__link')?.getAttribute('aria-label'),
    ).toBe('Run');
  });

  test('the chevron is quiet, the whole row is its target, and a control in the row stays on top', () => {
    expect(css).toMatch(
      /\.cinder-description-list__link\s*\{[^}]*margin-inline-start: auto;[^}]*color: var\(--cinder-text-subtle\)/s,
    );
    expect(css).toMatch(
      /\.cinder-description-list__row\[data-cinder-linked\]\s*\{[^}]*position: relative/s,
    );
    expect(css).toMatch(
      /\.cinder-description-list__link::before\s*\{[^}]*position: absolute;[^}]*inset: 0/s,
    );
    expect(css).toMatch(
      /\.cinder-description-list__row\[data-cinder-linked\]\s*:is\(button, input, select, textarea, a\[href\]:not\(\.cinder-description-list__link\)\)\s*\{[^}]*z-index: 1/s,
    );
  });

  test('the tint and the ring sit behind the text on the link ::after, past the row start', () => {
    // Flat: 12px past the row's start, rounded like a control.
    expect(css).toMatch(
      /\.cinder-description-list__link::after\s*\{[^}]*inset-inline: calc\(var\(--cinder-space-3\) \* -1\) 0;[^}]*z-index: -1;[^}]*border-radius: var\(--cinder-radius-control\)/s,
    );
    // Framed: to the group's start edge, past its 16px start padding.
    expect(css).toMatch(
      /\[data-cinder-framed\] \.cinder-description-list__link::after\s*\{[^}]*inset-inline-start: calc\(var\(--cinder-space-4\) \* -1\)/s,
    );
    expect(css).toMatch(
      /\.cinder-description-list__row\[data-cinder-linked\]\s*\{[^}]*isolation: isolate/s,
    );
    expect(css).toMatch(
      /:hover \.cinder-description-list__link::after\s*\{[^}]*background: var\(--cinder-surface-hover\)/s,
    );
    expect(css).toMatch(
      /\.cinder-description-list__link:focus-visible::after\s*\{[^}]*box-shadow: inset 0 0 0 var\(--cinder-ring-width\)/s,
    );
  });

  test("a linked row keeps InspectorRow's end inset and the value is set in the body size", () => {
    expect(css).toMatch(
      /\[data-cinder-variant='fields'\]\s+\.cinder-description-list__row\[data-cinder-linked\]\s*\{[^}]*padding-inline-end: var\(--cinder-space-2\)/s,
    );
    expect(css).toMatch(
      /\[data-cinder-variant='fields'\] dd\s*\{[^}]*font-size: var\(--cinder-text-base\)/s,
    );
  });

  test("a framed group takes an Inspector's raised surface below 700px of its own width (COR-2394)", () => {
    expect(css).toMatch(
      /\[data-cinder-variant='fields'\] \{[^}]*container-name: cinder-description-list/,
    );
    expect(css).not.toMatch(/@media[^{]*width/);
    // 700px less the framed group's 1rem start padding: a size query measures the content box.
    expect(containerBlock('cinder-description-list (width < 42.75rem)')).toMatch(
      /\[data-cinder-variant='fields'\]\[data-cinder-framed\]::before\s*\{[^}]*background: var\(--cinder-surface-raised\)/s,
    );
  });

  test("the label takes InspectorRow's sizes: the body size beside its value, the small size stacked", () => {
    expect(css).toMatch(
      /\.cinder-description-list\[data-cinder-variant='fields'\] dt\s*\{[^}]*font-size: var\(--cinder-text-base\)/s,
    );
    // Only a stacked row drops the label to the small size; beside its value it keeps the body
    // size, so the two share a baseline whatever the list's surface.
    expect(containerBlock('(width < 23rem)')).toMatch(
      /\.cinder-description-list\[data-cinder-variant='fields'\] dt\s*\{[^}]*font-size: var\(--cinder-text-sm\)/s,
    );
    expect(containerBlock('cinder-description-list (width < 42.75rem)')).not.toMatch(/font-size/);
    expect(css).not.toMatch(/@container cinder-description-list \(width < 700px\)/);
  });
});

describe('DescriptionList fields: stacking below 23rem of its own width', () => {
  test('the threshold stacks a 357px list (a 375 phone) and keeps a 386px one beside', () => {
    const match =
      /@container \(width < ([\d.]+)rem\) \{\s*\.cinder-description-list\[data-cinder-variant='fields'\]/.exec(
        css,
      );
    const threshold = Number(match?.[1]) * 16;
    expect(threshold).toBeGreaterThan(357);
    expect(threshold).toBeLessThanOrEqual(386);
  });

  test('a container query on the list stacks each row to one column below 23rem', () => {
    const block = containerBlock('(width < 23rem)');
    expect(block).toMatch(
      /\.cinder-description-list\[data-cinder-variant='fields'\] \.cinder-description-list__row\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/s,
    );
    // The list is its own container, so the query can restyle only its rows, never the list.
    expect(block).not.toMatch(/\[data-cinder-variant='fields'\]\s*\{/);
    expect(css).toMatch(
      /\.cinder-description-list\[data-cinder-variant='fields'\]\s*\{[^}]*container-type: inline-size/s,
    );
  });

  test('the fields variant keeps no other stacking threshold', () => {
    expect(containerBlock('(max-width: 28rem)')).not.toContain("[data-cinder-variant='fields']");
    expect(containerBlock('(width < 700px)')).toBe('');
  });
});
