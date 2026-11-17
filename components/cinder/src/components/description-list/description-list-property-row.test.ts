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
    expect(css).toMatch(
      /\[data-cinder-variant='fields'\]\[data-cinder-framed\]\s*\{[^}]*background: var\(--cinder-surface-inset\)/s,
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
      /\.cinder-description-list__link::after\s*\{[^}]*position: absolute;[^}]*inset: 0/s,
    );
    expect(css).toMatch(
      /\.cinder-description-list__row\[data-cinder-linked\]\s*:is\(button, input, select, textarea, a\[href\]:not\(\.cinder-description-list__link\)\)\s*\{[^}]*z-index: 1/s,
    );
  });
});

describe('DescriptionList fields: stacking below 700px', () => {
  test('a container query on the list stacks each row to one column below 700px', () => {
    const block = containerBlock('(width < 700px)');
    expect(block).toMatch(
      /\.cinder-description-list\[data-cinder-variant='fields'\] \.cinder-description-list__row\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/s,
    );
    // The list is its own container, so the query can restyle only its rows, never the list.
    expect(block).not.toMatch(/\[data-cinder-variant='fields'\]\s*\{/);
    expect(css).toMatch(
      /\.cinder-description-list\[data-cinder-variant='fields'\]\s*\{[^}]*container-type: inline-size/s,
    );
  });

  test('the fields variant keeps no narrower stacking threshold', () => {
    expect(containerBlock('(max-width: 28rem)')).not.toContain("[data-cinder-variant='fields']");
  });
});
