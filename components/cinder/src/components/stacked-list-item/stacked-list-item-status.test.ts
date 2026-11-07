/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

import type { StatusListRow } from '../../test/fixtures/status-list-fixture.svelte';

setupHappyDom();

const { render, fireEvent, cleanup } = await import('@testing-library/svelte');
const { default: StackedListItem } = await import('./stacked-list-item.svelte');
const { default: StatusListFixture } =
  await import('../../test/fixtures/status-list-fixture.svelte');
const { default: ExtrasFixture } =
  await import('../../test/fixtures/stacked-list-item-extras-fixture.svelte');

const stylesheet = readFileSync(new URL('./stacked-list-item.css', import.meta.url), 'utf8');

function textSnippet(text: string) {
  return createRawSnippet(() => ({ render: () => `<span>${text}</span>`, setup: () => {} }));
}

const runs: StatusListRow[] = [
  {
    id: 'a',
    title: 'Refund order 4471',
    day: 'Today',
    status: 'Waiting on you',
    time: '10:42 AM',
    meta: 'Chat · Tool runner · waiting 4 min',
    href: '/runs/a',
  },
  {
    id: 'b',
    title: 'Triage inbox',
    day: 'Today',
    time: 'Oct 24',
    meta: '3 steps · 1 run',
  },
];

describe('StackedListItem status-first row', () => {
  test('a row with a status leads with the status column, then title, time and meta', () => {
    const { container } = render(StackedListItem, {
      props: {
        status: textSnippet('Waiting on you'),
        title: textSnippet('Refund order 4471'),
        time: textSnippet('10:42 AM'),
        meta: textSnippet('Chat · Tool runner'),
      },
    });
    const root = container.querySelector('.cinder-stacked-list-item');
    expect(root?.classList.contains('cinder-stacked-list-item--lines')).toBe(true);
    expect(root?.classList.contains('cinder-stacked-list-item--status-column')).toBe(true);
    expect(root?.classList.contains('cinder-stacked-list-item--status-leading')).toBe(true);
    const parts = ['__status', '__title', '__time', '__line-two'].map((part) =>
      root?.querySelector(`.cinder-stacked-list-item${part}`),
    );
    expect(parts.every((part) => part !== null && part !== undefined)).toBe(true);
    expect(root?.querySelector('.cinder-stacked-list-item__status')?.textContent).toContain(
      'Waiting on you',
    );
    expect(root?.querySelector('.cinder-stacked-list-item__line-two')?.textContent).toContain(
      'Chat · Tool runner',
    );
  });

  test('wrapMeta lets line two wrap, so a control in it is never cut off, and the rule is in the stylesheet', () => {
    const { container } = render(StackedListItem, {
      props: {
        status: textSnippet('Failed for good'),
        title: textSnippet('collect-merged-changes'),
        meta: textSnippet('Failed after 5 tries · GitHub didn’t answer (HTTP 503).'),
        wrapMeta: true,
      },
    });
    const root = container.querySelector('.cinder-stacked-list-item');
    expect(root?.classList.contains('cinder-stacked-list-item--wrap-meta')).toBe(true);
    expect(stylesheet).toMatch(
      /--wrap-meta\s+\.cinder-stacked-list-item__meta\s*\{[^}]*white-space:\s*normal/u,
    );
  });

  test('a row without wrapMeta keeps line two on one line', () => {
    const { container } = render(StackedListItem, {
      props: {
        status: textSnippet('Done'),
        title: textSnippet('Say hello'),
        meta: textSnippet('x'),
      },
    });
    expect(
      container
        .querySelector('.cinder-stacked-list-item')
        ?.classList.contains('cinder-stacked-list-item--wrap-meta'),
    ).toBe(false);
  });

  test('a row with nothing to report keeps the column through statusColumn, with no status element', () => {
    const { container } = render(StackedListItem, {
      props: { statusColumn: true, title: textSnippet('Triage inbox') },
    });
    const root = container.querySelector('.cinder-stacked-list-item');
    expect(root?.classList.contains('cinder-stacked-list-item--status-column')).toBe(true);
    expect(root?.classList.contains('cinder-stacked-list-item--has-status')).toBe(false);
    expect(root?.querySelector('.cinder-stacked-list-item__status')).toBeNull();
  });

  test('a row without a status or a reserved column keeps the original body stack', () => {
    const { container } = render(StackedListItem, { props: { title: textSnippet('Plain') } });
    const root = container.querySelector('.cinder-stacked-list-item');
    expect(root?.classList.contains('cinder-stacked-list-item--lines')).toBe(false);
    expect(root?.classList.contains('cinder-stacked-list-item--status-column')).toBe(false);
  });

  test('the DataList keeps the status column for every row, so titles line up', () => {
    const { container } = render(StatusListFixture, { props: { rows: runs, statusColumn: true } });
    const rows = [...container.querySelectorAll('.cinder-stacked-list-item')];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.classList.contains('cinder-stacked-list-item--status-column')).toBe(true);
    }
    expect(rows[0]?.querySelector('.cinder-stacked-list-item__status')).not.toBeNull();
    expect(rows[1]?.querySelector('.cinder-stacked-list-item__status')).toBeNull();
  });

  test('without statusColumn a row with no status does not reserve the column', () => {
    const { container } = render(StatusListFixture, { props: { rows: runs } });
    const rows = [...container.querySelectorAll('.cinder-stacked-list-item')];
    expect(rows[1]?.classList.contains('cinder-stacked-list-item--status-column')).toBe(false);
  });

  test('line-two placement is the chat list exception and keeps the status in the DOM', () => {
    const { container } = render(StatusListFixture, {
      props: { rows: runs, placement: 'line-two' },
    });
    const row = container.querySelector('.cinder-stacked-list-item');
    expect(row?.classList.contains('cinder-stacked-list-item--status-line-two')).toBe(true);
    expect(row?.querySelector('.cinder-stacked-list-item__status')?.textContent).toContain(
      'Waiting on you',
    );
  });

  test('the title is clamped at two lines by default and one when asked, and is the tooltip', () => {
    const { container } = render(StatusListFixture, { props: { rows: runs } });
    const title = container.querySelector('.cinder-stacked-list-item__title');
    expect(title?.getAttribute('data-cinder-title-lines')).toBe('2');
    expect(title?.getAttribute('title')).toBe('Refund order 4471');

    const single = render(StackedListItem, {
      props: { titleLines: 1, title: textSnippet('Short') },
    });
    expect(
      single.container
        .querySelector('.cinder-stacked-list-item__title')
        ?.getAttribute('data-cinder-title-lines'),
    ).toBe('1');
  });

  test('the whole row is one link: the anchor wraps the title and a stretched cover is drawn', () => {
    const { container } = render(StatusListFixture, { props: { rows: runs } });
    const row = container.querySelector('.cinder-stacked-list-item');
    expect(row?.classList.contains('cinder-stacked-list-item--linked')).toBe(true);
    expect(row?.querySelectorAll('a')).toHaveLength(1);
    expect(row?.querySelector('a')?.getAttribute('href')).toBe('/runs/a');
    expect(stylesheet).toMatch(/__title-link::after\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0/);
    expect(stylesheet).toMatch(
      /--linked:hover\s*\{[^}]*background:\s*var\(--cinder-surface-hover\)/,
    );
    // The focus ring wraps the row (the cover), inside it, rather than the title.
    expect(stylesheet).toMatch(
      /__title-link:focus-visible::after\s*\{[^}]*box-shadow:\s*inset 0 0 0 var\(--cinder-ring-width\)/,
    );
  });

  test('the stylesheet fixes the status column at 128px and centres it on the title line', () => {
    expect(stylesheet).toContain('var(--_cinder-status-width, 8rem)');
    expect(stylesheet).toMatch(
      /--lines \.cinder-stacked-list-item__status\s*\{[^}]*min-block-size:\s*var\(--_cinder-line-one-height\)/,
    );
    expect(stylesheet).toMatch(
      /__time\s*\{[^}]*grid-area:\s*time;[^}]*min-block-size:\s*var\(--_cinder-line-one-height\)/,
    );
    // Line two starts under the title, never under the status.
    expect(stylesheet).toContain("'status leading line line trailing'");
    expect(stylesheet).toContain("'leading status line line trailing'");
  });

  test('long values never widen or grow the row: clamp, wrap anywhere, one-line meta', () => {
    expect(stylesheet).toMatch(/__title\s*\{[^}]*-webkit-line-clamp:\s*2/);
    expect(stylesheet).toMatch(/__meta \{[^}]*overflow-wrap:\s*anywhere/s);
    expect(stylesheet).toMatch(
      /--lines \.cinder-stacked-list-item__meta\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/,
    );
  });

  test('controls inside a linked row sit above the cover', () => {
    expect(stylesheet).toMatch(/__trailing\s*\{\s*position:\s*relative;\s*z-index:\s*1/);
    expect(stylesheet).toMatch(
      /__line-two :is\(a, button, \[role='button'\]\)\s*\{[^}]*z-index:\s*1/,
    );
  });
});

describe('StackedListItem group row', () => {
  test('a group row is not a link and reveals its details through a Show / Hide button', async () => {
    const { container, getByRole, getByTestId } = render(ExtrasFixture, {
      props: { mode: 'group' },
    });
    const row = container.querySelector('.cinder-stacked-list-item');
    expect(row?.querySelector('a')).toBeNull();
    expect(row?.classList.contains('cinder-stacked-list-item--linked')).toBe(false);

    const button = getByRole('button', { name: /show/i });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const details = row?.querySelector('.cinder-stacked-list-item__details');
    expect(details?.hasAttribute('hidden')).toBe(true);
    expect(button.getAttribute('aria-controls')).toBe(details?.getAttribute('id') ?? null);
    expect(row?.hasAttribute('data-cinder-expanded')).toBe(false);

    await fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.textContent).toContain('Hide');
    expect(details?.hasAttribute('hidden')).toBe(false);
    expect(row?.hasAttribute('data-cinder-expanded')).toBe(true);
    expect(getByTestId('missed').textContent).toContain('3:00 AM');
  });
});

describe('StackedListItem actions', () => {
  const calls: string[] = [];
  const actions = [
    { label: 'Memory', href: '/memory', onclick: () => calls.push('memory') },
    {
      label: 'New chat',
      disabled: true,
      disabledReason: 'Connect a provider to start a chat',
      onclick: () => calls.push('new-chat'),
    },
  ];

  test('on a tablet or desktop each action is a button and a disabled one keeps aria-disabled and its reason', async () => {
    calls.length = 0;
    const { container, getByText } = render(ExtrasFixture, { props: { mode: 'actions', actions } });
    expect(container.querySelector('.cinder-stacked-list-item__actions')).not.toBeNull();
    expect(container.querySelector('.cinder-stacked-list-item__actions-trigger')).toBeNull();

    const memory = getByText('Memory').closest('a, button');
    expect(memory?.getAttribute('href')).toBe('/memory');

    const newChat = getByText('New chat').closest('a, button');
    expect(newChat?.getAttribute('aria-disabled')).toBe('true');
    const reasonId = newChat?.getAttribute('aria-describedby') ?? '';
    expect(container.querySelector(`#${reasonId}`)?.textContent).toContain('Connect a provider');
    expect(newChat?.getAttribute('title')).toBe('Connect a provider to start a chat');
    await fireEvent.click(newChat as Element);
    expect(calls).toEqual([]);
    cleanup();
  });

  test('actions are a trailing region, so the row reports it', () => {
    const { container } = render(ExtrasFixture, { props: { mode: 'actions', actions } });
    expect(
      container
        .querySelector('.cinder-stacked-list-item')
        ?.classList.contains('cinder-stacked-list-item--has-trailing'),
    ).toBe(true);
    cleanup();
  });

  test('an empty actions list draws no trailing region', () => {
    const { container } = render(ExtrasFixture, { props: { mode: 'actions', actions: [] } });
    expect(container.querySelector('.cinder-stacked-list-item__trailing')).toBeNull();
  });
});

describe('status and time sit on the title baseline (rows 09d, 09f, 15r)', () => {
  const rule = (selector: string): string => {
    const index = stylesheet.indexOf(`${selector} {`);
    expect(index, selector).toBeGreaterThan(-1);
    return stylesheet.slice(stylesheet.indexOf('{', index) + 1, stylesheet.indexOf('}', index));
  };

  test('the status and time cells align their contents on a baseline, not their centres', () => {
    expect(rule('.cinder-stacked-list-item--lines .cinder-stacked-list-item__status')).toContain(
      'align-items: baseline;',
    );
    expect(rule('.cinder-stacked-list-item--lines .cinder-stacked-list-item__time')).toContain(
      'align-items: baseline;',
    );
  });

  test('each cell opens with a zero-width strut in the title type, so the baseline is the title first line', () => {
    const strut = rule(
      `.cinder-stacked-list-item--lines .cinder-stacked-list-item__status::before,\n  .cinder-stacked-list-item--lines .cinder-stacked-list-item__time::before`,
    );
    expect(strut).toContain('font-size: var(--cinder-text-base);');
    expect(strut).toContain('line-height: var(--cinder-leading-snug);');
    expect(strut).toContain('inline-size: 0;');
  });

  test('the dot centres on the word while the word keeps the baseline', () => {
    expect(rule('.cinder-stacked-list-item__status .cinder-status-dot')).toContain(
      'align-items: center;',
    );
    expect(rule('.cinder-stacked-list-item__status .cinder-status-dot__label')).toContain(
      'align-self: baseline;',
    );
  });

  test('a status on line two has no strut', () => {
    expect(stylesheet).toMatch(
      /status-line-two\s+\.cinder-stacked-list-item__status::before,[^{]*\{\s*display: none;/,
    );
  });
});
