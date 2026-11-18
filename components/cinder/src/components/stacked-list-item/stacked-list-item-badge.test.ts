/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: StackedListItem } = await import('./stacked-list-item.svelte');

const stylesheet = readFileSync(new URL('./stacked-list-item.css', import.meta.url), 'utf8');

function textSnippet(text: string) {
  return createRawSnippet(() => ({
    render: () => `<span>${text}</span>`,
    setup: () => {},
  }));
}

/** The declarations of the first rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const escaped = selector.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(String.raw`(?:^|[}\s])${escaped}\s*\{([^}]*)\}`).exec(stylesheet)?.[1] ?? '';
}

describe('StackedListItem badge (R10-01)', () => {
  test('draws the mark after the title, outside the clamped title, in the title cell', () => {
    const { container } = render(StackedListItem, {
      props: {
        title: textSnippet('Post settled runs'),
        tooltip: 'Post settled runs',
        badge: textSnippet('Plugin'),
        status: textSnippet('Delivered'),
        time: textSnippet('Yesterday, 6:00 PM'),
        href: '/hooks/post-settled-runs',
      },
    });
    const row = container.querySelector('.cinder-stacked-list-item__title-row');
    expect(row).not.toBeNull();
    const [title, badge] = [...(row?.children ?? [])];
    // The title keeps its clamp and its tooltip; the mark is a sibling after it, never inside it.
    expect(title?.classList.contains('cinder-stacked-list-item__title')).toBe(true);
    expect(title?.getAttribute('title')).toBe('Post settled runs');
    expect(title?.textContent).not.toContain('Plugin');
    expect(badge?.classList.contains('cinder-stacked-list-item__badge')).toBe(true);
    expect(badge?.textContent).toBe('Plugin');
  });

  test('a row with no mark keeps its title as the cell, with no wrapper', () => {
    const { container } = render(StackedListItem, {
      props: { title: textSnippet('My Slack post'), status: textSnippet('Delivered') },
    });
    expect(container.querySelector('.cinder-stacked-list-item__title-row')).toBeNull();
    expect(container.querySelector('.cinder-stacked-list-item__badge')).toBeNull();
  });

  test('the title shrinks and clamps first, and the mark is never cut and never wraps alone', () => {
    const row = ruleBody('.cinder-stacked-list-item__title-row');
    expect(row).toMatch(/display:\s*flex;/);
    expect(row).toMatch(/flex-wrap:\s*nowrap;/);
    expect(row).toMatch(/align-items:\s*baseline;/);
    expect(row).toMatch(/gap:\s*var\(--cinder-space-1-5\);/);
    expect(
      ruleBody('.cinder-stacked-list-item__title-row > .cinder-stacked-list-item__title'),
    ).toMatch(/flex:\s*0 1 auto;/);
    const badge = ruleBody('.cinder-stacked-list-item__badge');
    expect(badge).toMatch(/flex:\s*none;/);
    expect(badge).toMatch(/white-space:\s*nowrap;/);
    // On a phone (320 and 375 pixels) the title beside a mark is one line ending in an ellipsis, so
    // the mark sits the 6px gap after the last character drawn, within 8px of the title's text: a
    // title that wrapped would keep its box's width and strand the mark after a short first line.
    // The browser measures it on /hooks at both widths (hooks.spec.ts, [default-hooks]).
    const phoneTitle =
      /@container cinder-stacked-list-item \(max-width: 639\.98px\)\s*\{\s*\.cinder-stacked-list-item__title-row > \.cinder-stacked-list-item__title\s*\{([^}]*)\}/.exec(
        stylesheet,
      )?.[1] ?? '';
    expect(phoneTitle).toMatch(/display:\s*block;/);
    expect(phoneTitle).toMatch(/white-space:\s*nowrap;/);
    expect(phoneTitle).toMatch(/text-overflow:\s*ellipsis;/);
    // In the two-line layout the pair takes the title's grid cell.
    expect(
      ruleBody('.cinder-stacked-list-item--lines .cinder-stacked-list-item__title-row'),
    ).toMatch(/grid-area:\s*title;/);
  });
});
