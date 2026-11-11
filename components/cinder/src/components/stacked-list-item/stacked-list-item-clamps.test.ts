/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, fireEvent } = await import('@testing-library/svelte');
const { default: StackedListItem } = await import('./stacked-list-item.svelte');

const stylesheet = readFileSync(new URL('./stacked-list-item.css', import.meta.url), 'utf8');

function textSnippet(text: string) {
  return createRawSnippet(() => ({ render: () => `<span>${text}</span>`, setup: () => {} }));
}

const longTitle =
  'Refund order 4471 for $42.00 to the original card, plus the $6.00 return shipping the customer paid last week, for the Parcelly damaged-carrier claim?';

describe('StackedListItem long values', () => {
  test('a long title is clamped at two lines and keeps its full text as the row accessible name and tooltip', () => {
    const { container, getByRole } = render(StackedListItem, {
      props: {
        href: '/reviews/4471',
        status: textSnippet('Waiting on you'),
        title: textSnippet(longTitle),
        tooltip: longTitle,
        time: textSnippet('4 min'),
        meta: textSnippet('Approval, Tool runner'),
      },
    });
    const title = container.querySelector('.cinder-stacked-list-item__title');
    expect(title?.getAttribute('data-cinder-title-lines')).toBe('2');
    expect(title?.getAttribute('title')).toBe(longTitle);
    // The clamp is visual only: the whole text stays in the link, so it is the accessible name.
    expect(getByRole('link').textContent).toBe(longTitle);
    expect(stylesheet).toMatch(/__title\s*\{[^}]*-webkit-line-clamp:\s*2/);
  });

  test('line two carries its full text as a tooltip in the two-line row and in the plain row', () => {
    const lineTwo = 'Workflow, Release notes, Every Friday at 11:00 AM, From a workflow file';
    const lines = render(StackedListItem, {
      props: {
        title: textSnippet('Release notes digest'),
        time: textSnippet('Next Fri Nov 6, 11:00 AM'),
        meta: textSnippet(lineTwo),
        metaTooltip: lineTwo,
      },
    });
    expect(
      lines.container.querySelector('.cinder-stacked-list-item__line-two')?.getAttribute('title'),
    ).toBe(lineTwo);
    lines.unmount();

    const plain = render(StackedListItem, {
      props: {
        title: textSnippet('Plain'),
        meta: textSnippet(lineTwo),
        metaTooltip: lineTwo,
      },
    });
    expect(
      plain.container.querySelector('.cinder-stacked-list-item__meta')?.getAttribute('title'),
    ).toBe(lineTwo);
  });

  test('a row without a metaTooltip puts no title on line two', () => {
    const { container } = render(StackedListItem, {
      props: { title: textSnippet('Plain'), time: textSnippet('now'), meta: textSnippet('Kind') },
    });
    expect(
      container.querySelector('.cinder-stacked-list-item__line-two')?.hasAttribute('title'),
    ).toBe(false);
  });
});

describe('StackedListItem selected row', () => {
  test('a selected link row takes the accent fill and marks its link as current', () => {
    const { container, getByRole } = render(StackedListItem, {
      props: { href: '/workers/reports', selected: true, title: textSnippet('Reports worker') },
    });
    const row = container.querySelector('.cinder-stacked-list-item');
    expect(row?.classList.contains('cinder-stacked-list-item--selected')).toBe(true);
    expect(row?.hasAttribute('data-cinder-selected')).toBe(true);
    expect(getByRole('link').getAttribute('aria-current')).toBe('true');
    expect(row?.hasAttribute('aria-current')).toBe(false);
    expect(stylesheet).toMatch(
      /--selected\s*\{[^}]*background:\s*color-mix\(in oklch, var\(--cinder-accent-solid\)/,
    );
  });

  test('a selected row that is not a link marks the row itself', () => {
    const { container } = render(StackedListItem, {
      props: { selected: true, title: textSnippet('Reports worker') },
    });
    expect(container.querySelector('.cinder-stacked-list-item')?.getAttribute('aria-current')).toBe(
      'true',
    );
  });

  test('an unselected row has no current marker, and hover keeps the selected tint', () => {
    const { container } = render(StackedListItem, {
      props: { href: '/workers/payments', title: textSnippet('Payments worker 1') },
    });
    expect(container.querySelector('a')?.hasAttribute('aria-current')).toBe(false);
    expect(container.querySelector('li')?.hasAttribute('data-cinder-selected')).toBe(false);
    expect(stylesheet).toMatch(
      /--linked\.cinder-stacked-list-item--selected:hover\s*\{[^}]*background:\s*color-mix/,
    );
  });
});

describe('StackedListItem group row tint', () => {
  test('a group row is tinted whether it is open or shut, and an amber tone is a warning tint', () => {
    const { container } = render(StackedListItem, {
      props: {
        tone: 'warning',
        status: textSnippet('Missed runs, 4'),
        title: textSnippet('Daily summary missed 4 times since Oct 30'),
        details: textSnippet('Mon, Nov 2'),
      },
    });
    const row = container.querySelector('.cinder-stacked-list-item');
    expect(row?.classList.contains('cinder-stacked-list-item--group')).toBe(true);
    expect(row?.classList.contains('cinder-stacked-list-item--tone-warning')).toBe(true);
    expect(row?.hasAttribute('data-cinder-expanded')).toBe(false);
    expect(stylesheet).toMatch(
      /--group\.cinder-stacked-list-item--tone-neutral\s*\{[^}]*background:\s*color-mix\(in oklch, var\(--cinder-surface-inset\)/,
    );
    expect(stylesheet).toMatch(
      /--group\.cinder-stacked-list-item--tone-warning\s*\{[^}]*--cinder-status-warning-background/,
    );
  });

  test('a group row defaults to the neutral tint and shows all of line two when it is open', async () => {
    const { container, getByRole } = render(StackedListItem, {
      props: {
        status: textSnippet('Missed runs, 4'),
        title: textSnippet('Daily summary'),
        meta: textSnippet('Schedule, Assistant'),
        details: textSnippet('Mon, Nov 2'),
      },
    });
    const row = container.querySelector('.cinder-stacked-list-item');
    expect(row?.classList.contains('cinder-stacked-list-item--tone-neutral')).toBe(true);
    await fireEvent.click(getByRole('button', { name: /show/i }));
    expect(row?.hasAttribute('data-cinder-expanded')).toBe(true);
    expect(stylesheet).toMatch(
      /--group\[data-cinder-expanded\] \.cinder-stacked-list-item__meta\s*\{[^}]*white-space:\s*normal/,
    );
  });
});

describe('StackedListItem band group row', () => {
  function renderBand(extra: Record<string, unknown> = {}) {
    return render(StackedListItem, {
      props: {
        groupLayout: 'band',
        tone: 'warning',
        expandLabel: 'Show each',
        status: textSnippet('dot'),
        title: textSnippet('Missed 4 times since Oct 30'),
        meta: textSnippet('Interborough was off'),
        details: textSnippet('Mon Nov 2, 3:00 AM'),
        ...extra,
      },
    });
  }

  test('draws the dot outside one band that holds the chevron, title, muted text and the toggle label', () => {
    const { container, getByRole } = renderBand();
    const row = container.querySelector('.cinder-stacked-list-item');
    expect(row?.classList.contains('cinder-stacked-list-item--band')).toBe(true);
    expect(row?.classList.contains('cinder-stacked-list-item--lines')).toBe(false);
    const status = row?.querySelector('.cinder-stacked-list-item__band-status');
    const surface = row?.querySelector('.cinder-stacked-list-item__band-surface');
    expect(status?.textContent).toContain('dot');
    expect(surface?.contains(status ?? null)).toBe(false);
    const toggle = getByRole('button', { name: /show each/i });
    expect(surface?.contains(toggle)).toBe(true);
    expect(toggle.querySelector('svg')).not.toBeNull();
    expect(toggle.textContent).toContain('Missed 4 times since Oct 30');
    expect(toggle.textContent).toContain('Interborough was off');
    expect(row?.querySelector('a')).toBeNull();
  });

  test('the row itself stays untinted, so only the band is, and the details sit on the page', () => {
    expect(stylesheet).toMatch(
      /--band\.cinder-stacked-list-item--group\s*\{[^}]*background:\s*transparent/,
    );
    expect(stylesheet).toMatch(/__band-surface\s*\{[^}]*background:\s*color-mix/);
  });

  test('the toggle opens and closes the details and says Hide while open', async () => {
    const { container, getByRole } = renderBand();
    const toggle = getByRole('button', { name: /show each/i });
    const details = container.querySelector('.cinder-stacked-list-item__details');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(details?.hasAttribute('hidden')).toBe(true);
    expect(toggle.getAttribute('aria-controls')).toBe(details?.getAttribute('id') ?? null);

    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toContain('Hide');
    expect(details?.hasAttribute('hidden')).toBe(false);
    expect(details?.textContent).toContain('Mon Nov 2, 3:00 AM');
  });

  test('shows the full title as a tooltip and the title ends in an ellipsis rather than growing the band', () => {
    const { container } = renderBand({ tooltip: 'Missed 4 times since Oct 30' });
    expect(
      container.querySelector('.cinder-stacked-list-item__band-title')?.getAttribute('title'),
    ).toBe('Missed 4 times since Oct 30');
    expect(stylesheet).toMatch(
      /__band-title\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis/,
    );
  });
});

describe('StackedListItem glyph tile', () => {
  test('a leadingTone wraps the leading glyph in a decorative tinted tile on the two-line layout', () => {
    const { container } = render(StackedListItem, {
      props: {
        lines: true,
        leadingTone: 'warning',
        leading: textSnippet('glyph'),
        title: textSnippet('Daily summary missed 4 runs since Oct 30'),
        description: textSnippet(
          'Interborough was off when it was due on Oct 30, Oct 31, Nov 1 and Nov 2.',
        ),
        actions: [{ label: 'View schedule', href: '/schedules/daily-summary' }],
      },
    });
    const row = container.querySelector('.cinder-stacked-list-item');
    expect(row?.classList.contains('cinder-stacked-list-item--lines')).toBe(true);
    expect(row?.classList.contains('cinder-stacked-list-item--has-leading-tile')).toBe(true);
    const tile = row?.querySelector('.cinder-stacked-list-item__leading-tile');
    expect(tile?.getAttribute('data-cinder-tone')).toBe('warning');
    expect(tile?.getAttribute('aria-hidden')).toBe('true');
    expect(tile?.textContent).toContain('glyph');
    expect(container.querySelectorAll('.cinder-stacked-list-item__actions a')).toHaveLength(1);
    expect(stylesheet).toMatch(
      /__leading-tile\[data-cinder-tone='warning'\]\s*\{[^}]*--cinder-status-warning-background/,
    );
  });

  test('without a tone the leading glyph is not wrapped, and lines is off by default', () => {
    const { container } = render(StackedListItem, {
      props: { leading: textSnippet('glyph'), title: textSnippet('Plain') },
    });
    expect(container.querySelector('.cinder-stacked-list-item__leading-tile')).toBeNull();
    expect(
      container
        .querySelector('.cinder-stacked-list-item')
        ?.classList.contains('cinder-stacked-list-item--lines'),
    ).toBe(false);
  });
});
