/// <reference lib="dom" />
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

import type { StatusListRow } from '../../test/fixtures/status-list-fixture.svelte';

setupHappyDom();

// A controllable `matchMedia`, installed before the shared phone query is first read, so a test
// can put the viewport in its phone form and back.
type Listener = () => void;
const listeners = new Set<Listener>();
let phone = false;
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: (query: string) => ({
    media: query,
    get matches() {
      return phone;
    },
    addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
    addListener: (listener: Listener) => listeners.add(listener),
    removeListener: (listener: Listener) => listeners.delete(listener),
  }),
});

afterAll(() => {
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  else Reflect.deleteProperty(window, 'matchMedia');
});

const { render, cleanup, fireEvent } = await import('@testing-library/svelte');
const { createRawSnippet, flushSync } = await import('svelte');
const { default: StackedListItem } = await import('./stacked-list-item.svelte');
const { default: ExtrasFixture } =
  await import('../../test/fixtures/stacked-list-item-extras-fixture.svelte');
const { default: StatusListFixture } =
  await import('../../test/fixtures/status-list-fixture.svelte');

const stylesheet = readFileSync(new URL('./stacked-list-item.css', import.meta.url), 'utf8');

/**
 * The declarations of the phone rule for a status-first row with a trailing control, which is not a
 * group row or one whose actions drop under it, ending in `cell`.
 */
function cappedRule(cell: string): string {
  const escaped = cell
    .replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
    .replaceAll(' ', String.raw`\s*`);
  return (
    new RegExp(
      String.raw`\.cinder-stacked-list-item--lines\.cinder-stacked-list-item--has-trailing:not\(\s*\.cinder-stacked-list-item--band,\s*\.cinder-stacked-list-item--group,\s*\.cinder-stacked-list-item--phone-buttons\s*\)\.cinder-stacked-list-item--status-leading\s*${escaped}\s*\{([^}]*)\}`,
    ).exec(stylesheet)?.[1] ?? ''
  );
}

function textSnippet(text: string) {
  return createRawSnippet(() => ({ render: () => `<span>${text}</span>`, setup: () => {} }));
}

function setPhone(next: boolean) {
  phone = next;
  for (const listener of listeners) listener();
  flushSync();
}

const rows: StatusListRow[] = [
  {
    id: 'a',
    title: 'Refund order 4471',
    day: 'Today',
    status: 'Waiting on you',
    time: '10:42 AM',
    meta: 'Chat, Tool runner',
  },
];

const actions = [
  { label: 'Memory', href: '/memory' },
  { label: 'New chat', disabled: true, disabledReason: 'Connect a provider to start a chat' },
];

describe('StackedListItem on a phone', () => {
  test('the status moves to line two beside the kind and agent, and the word and dot are unchanged', () => {
    setPhone(true);
    const { container } = render(StatusListFixture, { props: { rows } });
    const row = container.querySelector('.cinder-stacked-list-item');
    expect(row?.hasAttribute('data-cinder-phone')).toBe(true);
    // One status element in both forms: the word is the same, only its place in the grid changes.
    expect(row?.querySelector('.cinder-stacked-list-item__status')?.textContent).toContain(
      'Waiting on you',
    );
    expect(stylesheet).toContain("'leading status line line trailing'");
    expect(stylesheet).toMatch(
      /--status-leading:not\(\s*\.cinder-stacked-list-item--no-line-two\s*\)\s*\.cinder-stacked-list-item__status:has\(\*\)\s*\{/,
    );
    cleanup();
    setPhone(false);
  });

  test('a line-two status gives up its fixed column on a phone and reads word, dot, then the preview', () => {
    setPhone(true);
    const { container } = render(StatusListFixture, { props: { rows, placement: 'line-two' } });
    const row = container.querySelector('.cinder-stacked-list-item');
    expect(row?.classList.contains('cinder-stacked-list-item--status-line-two')).toBe(true);
    expect(row?.hasAttribute('data-cinder-phone')).toBe(true);
    // The phone rules name the line-two placement as well as the leading one: an auto status track
    // in place of the fixed column, no end padding, and the dot separator after the word.
    expect(stylesheet).toMatch(
      /--status-line-two\s*>\s*\.cinder-stacked-list-item__layout\s*\{\s*--_cinder-status-track:\s*auto;/,
    );
    expect(stylesheet).toMatch(
      /--status-line-two\s*\.cinder-stacked-list-item__status:has\(\*\)\s*\{\s*margin-inline-end:/,
    );
    cleanup();
    setPhone(false);
  });

  test('a row on a tablet or desktop has no phone attribute', () => {
    setPhone(false);
    const { container } = render(StatusListFixture, { props: { rows } });
    expect(
      container.querySelector('.cinder-stacked-list-item')?.hasAttribute('data-cinder-phone'),
    ).toBe(false);
  });

  test('below 640px the trailing actions collapse into one menu button with the same actions', async () => {
    setPhone(true);
    const { container, getByRole } = render(ExtrasFixture, { props: { mode: 'actions', actions } });
    expect(container.querySelector('.cinder-stacked-list-item__actions')).toBeNull();
    const trigger = getByRole('button', { name: 'More actions' });
    expect(trigger.classList.contains('cinder-stacked-list-item__actions-trigger')).toBe(true);
    // Drawn at the compact height of a small Button, not at the raised control height.
    expect(stylesheet).toMatch(
      /__actions-trigger\.cinder-dropdown-trigger\s*\{[^}]*inline-size:\s*var\(--_cinder-painted-height-sm\)/,
    );
    expect(stylesheet).not.toMatch(
      /__actions-trigger[^{]*\{[^}]*inline-size:\s*var\(--cinder-control-height-md\)/,
    );
    // Under a coarse pointer it reaches 44px through a positioned pseudo-element, taking no space.
    expect(stylesheet).toMatch(
      /@media \(any-pointer: coarse\)\s*\{[\s\S]*?\.cinder-stacked-list-item \.cinder-stacked-list-item__actions-trigger::before\s*\{[^}]*position:\s*absolute;[^}]*var\(--cinder-touch-target-min\)/,
    );

    await fireEvent.click(trigger);
    const menuItems = [...document.querySelectorAll('.cinder-dropdown-item')];
    expect(menuItems.map((item) => item.textContent?.trim())).toEqual([
      expect.stringContaining('Memory'),
      expect.stringContaining('New chat'),
    ]);
    const newChat = menuItems[1];
    expect(newChat?.getAttribute('aria-disabled')).toBe('true');
    const reasonId = newChat?.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(reasonId)?.textContent).toContain('Connect a provider');
    cleanup();
    setPhone(false);
  });

  test('one action on a phone stays its own compact secondary button, not a menu of one', () => {
    setPhone(true);
    const { container, getByRole, queryByRole } = render(ExtrasFixture, {
      props: { mode: 'actions', actions: [{ label: 'Verdict', href: '/verdict' }] },
    });
    expect(queryByRole('button', { name: 'More actions' })).toBeNull();
    const row = container.querySelector('.cinder-stacked-list-item');
    expect(row?.classList.contains('cinder-stacked-list-item--collapsed-actions')).toBe(false);
    const action = getByRole('link', { name: 'Verdict' });
    expect(action.getAttribute('href')).toBe('/verdict');
    expect(action.classList.contains('button-size-small')).toBe(true);
    expect(action.classList.contains('button-variant-secondary')).toBe(true);
    cleanup();
    setPhone(false);
  });

  test('below 448 an ordinary one-action line row puts the action under its body (COR-2403)', () => {
    setPhone(true);
    const { container, getByRole } = render(StackedListItem, {
      props: {
        lines: true,
        wrapMeta: true,
        leadingTone: 'warning',
        leading: textSnippet('warning'),
        title: textSnippet('Connect a provider before the next run'),
        meta: textSnippet('Scheduled runs cannot start until a provider is connected.'),
        actions: [{ label: 'Connect provider', href: '/settings/providers' }],
      },
    });
    const row = container.querySelector('.cinder-stacked-list-item');
    expect(row?.classList.contains('cinder-stacked-list-item--lines')).toBe(true);
    expect(row?.classList.contains('cinder-stacked-list-item--has-leading')).toBe(true);
    expect(row?.classList.contains('cinder-stacked-list-item--has-trailing')).toBe(true);
    expect(row?.classList.contains('cinder-stacked-list-item--collapsed-actions')).toBe(false);
    expect(row?.classList.contains('cinder-stacked-list-item--phone-buttons')).toBe(false);
    expect(getByRole('link', { name: 'Connect provider' }).classList).toContain(
      'button-size-small',
    );

    const ordinaryLineActionMatch =
      /@container cinder-stacked-list-item \(max-width: 448px\) \{[\s\S]*?\.cinder-stacked-list-item--lines\.cinder-stacked-list-item--has-leading\.cinder-stacked-list-item--single-action:not\([\s\S]*?\)\.cinder-stacked-list-item--status-leading\s*> \.cinder-stacked-list-item__layout\s*\{([^}]*)\}/.exec(
        stylesheet,
      ) ?? [];
    const [ordinaryLineActionSelector = '', ordinaryLineAction = ''] = ordinaryLineActionMatch;
    // Lines flattens `__body`, so these must name its actual grid items rather than creating an
    // implicit `body` track. The same rule follows both row-width and viewport-width phone grids.
    expect(ordinaryLineAction).toContain("'leading title title time'");
    expect(ordinaryLineAction).toContain("'leading status line line'");
    expect(ordinaryLineAction).toContain("'trailing trailing trailing trailing'");
    expect(ordinaryLineAction).not.toContain('body');
    for (const exception of [
      'cinder-stacked-list-item--collapsed-actions',
      'cinder-stacked-list-item--trailing-glyph',
      'cinder-stacked-list-item--phone-buttons',
    ]) {
      expect(ordinaryLineActionSelector).toContain(exception);
    }

    const narrowActionBlock = stylesheet.slice(
      stylesheet.indexOf('@container cinder-stacked-list-item (max-width: 448px)', 7000),
    );
    const trailingRule = (selector: string) =>
      new RegExp(`${selector}\\s+\\.cinder-stacked-list-item__trailing\\s*\\{([^}]*)\\}`).exec(
        narrowActionBlock,
      )?.[1] ?? '';
    const noLeadingAction = trailingRule(
      String.raw`\.cinder-stacked-list-item--lines\.cinder-stacked-list-item--single-action:not\([^)]*?\.cinder-stacked-list-item--has-leading[^)]*?\)\.cinder-stacked-list-item--status-leading`,
    );
    const leadingAction = trailingRule(
      String.raw`\.cinder-stacked-list-item--lines\.cinder-stacked-list-item--has-leading\.cinder-stacked-list-item--single-action:not\([^)]*?\)\.cinder-stacked-list-item--status-leading`,
    );
    for (const [action, textStart] of [
      [noLeadingAction, 'title / -1'],
      [leadingAction, 'status / -1'],
    ]) {
      expect(action).toContain(`grid-column: ${textStart}`);
      expect(action).not.toContain('grid-row');
      expect(action).toContain('align-self: start');
      expect(action).toContain('margin-inline-start: 0');
      expect(action).toContain('margin-block-start: var(--cinder-space-2)');
    }
    cleanup();
    setPhone(false);
  });

  test('below 448 only a single data action takes the trailing row, not an arbitrary trailing control', () => {
    setPhone(true);
    const action = render(StackedListItem, {
      props: {
        lines: true,
        leading: textSnippet('warning'),
        title: textSnippet('Connect a provider'),
        meta: textSnippet('A provider is required.'),
        actions: [{ label: 'Connect provider', href: '/settings/providers' }],
      },
    });
    const actionRow = action.container.querySelector('.cinder-stacked-list-item');
    expect(actionRow?.classList.contains('cinder-stacked-list-item--single-action')).toBe(true);
    cleanup();

    const control = render(StackedListItem, {
      props: {
        lines: true,
        title: textSnippet('Post settled runs'),
        meta: textSnippet('Slack'),
        trailing: textSnippet('On'),
      },
    });
    const controlRow = control.container.querySelector('.cinder-stacked-list-item');
    expect(controlRow?.classList.contains('cinder-stacked-list-item--has-trailing')).toBe(true);
    expect(controlRow?.classList.contains('cinder-stacked-list-item--single-action')).toBe(false);
    cleanup();

    const mixed = render(StackedListItem, {
      props: {
        lines: true,
        title: textSnippet('Post settled runs'),
        trailing: textSnippet('On'),
        actions: [{ label: 'Connect provider', href: '/settings/providers' }],
      },
    });
    expect(
      mixed.container
        .querySelector('.cinder-stacked-list-item')
        ?.classList.contains('cinder-stacked-list-item--single-action'),
    ).toBe(false);
    cleanup();
    setPhone(false);
  });

  test('a narrow two-line row gives its action buttons a line of their own under the text, from a container query', () => {
    // A button beside the text of a 270px row left the title and the meta a few words wide.
    const block = stylesheet.slice(
      stylesheet.indexOf(
        '@container cinder-stacked-list-item (max-width: 448px) {\n    .cinder-stacked-list-item--lines.cinder-stacked-list-item--action-buttons',
      ),
    );
    const actionButtonRule =
      /\.cinder-stacked-list-item--lines\.cinder-stacked-list-item--action-buttons:not\(\s*\.cinder-stacked-list-item--single-action\.cinder-stacked-list-item--status-leading\s*\)\s*\.cinder-stacked-list-item__trailing\s*\{([^}]*)\}/.exec(
        block,
      ) ?? [];
    const [actionButtonSelector = '', rule = ''] = actionButtonRule;
    // A status-leading single action has a dedicated third row below its line cell. It must not
    // also receive this generic row-four placement, which would create an implicit row after it.
    expect(actionButtonSelector).toContain('cinder-stacked-list-item--single-action');
    expect(actionButtonSelector).toContain('cinder-stacked-list-item--status-leading');
    expect(rule).toMatch(/grid-row:\s*4;/);
    expect(rule).toMatch(/grid-column:\s*title \/ -1;/);
    expect(rule).toMatch(/align-self:\s*start;/);
    expect(rule).toMatch(/margin-inline-start:\s*0;/);
    expect(rule).toMatch(/margin-block-start:\s*var\(--cinder-space-2\);/);

    // Only a row that draws its actions as buttons beside the text carries the class.
    setPhone(true);
    const one = render(ExtrasFixture, {
      props: { mode: 'actions', actions: [{ label: 'Verdict', href: '/verdict' }] },
    });
    expect(
      one.container
        .querySelector('.cinder-stacked-list-item')
        ?.classList.contains('cinder-stacked-list-item--action-buttons'),
    ).toBe(true);
    cleanup();
    const two = render(ExtrasFixture, {
      props: {
        mode: 'actions',
        actions: [
          { label: 'Verdict', href: '/verdict' },
          { label: 'Run', href: '/run' },
        ],
      },
    });
    // The phone's one menu button is compact and stays beside the text.
    expect(
      two.container
        .querySelector('.cinder-stacked-list-item')
        ?.classList.contains('cinder-stacked-list-item--action-buttons'),
    ).toBe(false);
    cleanup();
    setPhone(false);
  });

  test('two actions on a phone are still one menu button', () => {
    setPhone(true);
    const { container, getByRole } = render(ExtrasFixture, {
      props: {
        mode: 'actions',
        actions: [
          { label: 'Verdict', href: '/verdict' },
          { label: 'Run', href: '/run' },
        ],
      },
    });
    const row = container.querySelector('.cinder-stacked-list-item');
    expect(row?.classList.contains('cinder-stacked-list-item--collapsed-actions')).toBe(true);
    expect(getByRole('button', { name: 'More actions' })).toBeDefined();
    cleanup();
    setPhone(false);
  });

  test('a status-first row narrower than 448px takes the phone arrangement from the 640px container query', () => {
    // Main's own-width 448px rule is a subset of the 640px one, so it has no block of its own.
    const phoneBlock = stylesheet.slice(
      stylesheet.indexOf('@container cinder-stacked-list-item (max-width: 639.98px)'),
    );
    expect(phoneBlock).toContain("'leading title title time trailing'");
    expect(phoneBlock).toContain("'leading status line line trailing'");
    expect(phoneBlock).toMatch(/--_cinder-status-track:\s*max-content;/);
    // The script's phone mark is read only by a row that follows the window (`phoneWidth`).
    for (const match of stylesheet.matchAll(/\[data-cinder-phone\]/g)) {
      expect(stylesheet.slice(Math.max(0, match.index - 40), match.index)).toContain(
        "[data-cinder-phone-width='viewport']",
      );
    }
  });

  test('on a phone the status word is never cut: its track is its own width, and a long time wraps and gives way (R10-02)', () => {
    setPhone(true);
    const { container } = render(StatusListFixture, {
      props: {
        rows: [
          {
            id: 'needs-setup',
            title: 'Add to the calendar',
            day: 'Yesterday',
            status: 'Needs setup',
            time: 'Yesterday, 6:00 PM',
            meta: 'When a review is waiting, run Add from Calendar',
          },
        ],
      },
    });
    const row = container.querySelector('.cinder-stacked-list-item');
    expect(row?.hasAttribute('data-cinder-phone')).toBe(true);
    expect(row?.querySelector('.cinder-stacked-list-item__status')?.textContent).toContain(
      'Needs setup',
    );
    const leadingPhone = (cell: string) =>
      new RegExp(
        String.raw`\.cinder-stacked-list-item--status-leading\s*${cell}\s*\{([^}]*)\}`,
        'g',
      );
    const phoneBlocks = stylesheet.slice(
      stylesheet.indexOf('/* A narrow row puts a leading status on line two'),
    );
    // The status track is the word's own width, so the word is never squeezed below it.
    const [, layout] = leadingPhone(String.raw`>\s*\.cinder-stacked-list-item__layout`).exec(
      phoneBlocks,
    ) ?? [undefined, ''];
    expect(layout).toMatch(/--_cinder-status-track:\s*max-content;/);
    // Not every row's time: that is only the rows with a trailing control.
    expect(layout).not.toContain('--_cinder-time-track');
    const [, status] = leadingPhone(String.raw`\.cinder-stacked-list-item__status`).exec(
      phoneBlocks,
    ) ?? [undefined, ''];
    expect(status).toMatch(/flex:\s*none;/);
    expect(status).toMatch(/min-inline-size:\s*max-content;/);
    // A row with a hook's switch at its end: the time gives way before the title. Its column is
    // exactly its widest line, and only a time given as text wraps, between its day and its clock.
    expect(cappedRule('> .cinder-stacked-list-item__layout')).toMatch(
      /--_cinder-time-track:\s*min-content;/,
    );
    expect(cappedRule('.cinder-stacked-list-item__time')).not.toContain('white-space');
    expect(cappedRule('.cinder-stacked-list-item__time-text')).toMatch(/white-space:\s*normal;/);
    // The phone grid reads the time track from that property.
    expect(stylesheet).toMatch(
      /\[title\] minmax\(0, 1fr\)\s*\[time\] var\(--_cinder-time-track, auto\) \[trailing\] auto;/,
    );
    cleanup();
    setPhone(false);
  });

  test('at 320 a group row keeps its time and its Show on one line: the disclosure never shrinks or breaks, and its time is never capped', () => {
    setPhone(true);
    const { container } = render(StackedListItem, {
      props: {
        title: textSnippet('Daily summary'),
        status: textSnippet('Missed runs'),
        time: textSnippet('Oct 30'),
        meta: textSnippet('Schedule, Assistant, every day at 3:00 AM'),
        details: textSnippet('Mon, Nov 2, 3:00 AM'),
      },
    });
    const row = container.querySelector('.cinder-stacked-list-item');
    expect(row?.classList.contains('cinder-stacked-list-item--group')).toBe(true);
    // The disclosure shares the time's cell, so the cell's rules reach it.
    const disclosure = row?.querySelector(
      '.cinder-stacked-list-item__time > .cinder-stacked-list-item__disclosure',
    );
    expect(disclosure?.textContent).toContain('Show');
    const own = /\.cinder-stacked-list-item__disclosure\s*\{([^}]*)\}/.exec(stylesheet)?.[1] ?? '';
    expect(own).toMatch(/flex:\s*none;/);
    expect(own).toMatch(/white-space:\s*nowrap;/);
    // The cap and the wrapping name a group row among the rows they leave alone.
    expect(cappedRule('> .cinder-stacked-list-item__layout')).not.toBe('');
    expect(cappedRule('.cinder-stacked-list-item__time-text')).not.toBe('');
    // The shared viewport-phone form also lets a timestamp reflow, but keeps group rows' time and
    // disclosure semantics intact.
    const wrappingTimeRules = [
      ...stylesheet.matchAll(
        /([^{}]*\.cinder-stacked-list-item__time(?:-text)?)\s*\{[^}]*white-space:\s*normal/g,
      ),
    ].map((match) => match[1] ?? '');
    expect(wrappingTimeRules).toHaveLength(2);
    expect(wrappingTimeRules[0]).toContain('--has-trailing');
    expect(wrappingTimeRules[0]).toContain('.cinder-stacked-list-item--group');
    expect(wrappingTimeRules[1]).toContain("[data-cinder-phone-width='viewport']");
    expect(wrappingTimeRules[1]).toContain('.cinder-stacked-list-item--status-leading');
    cleanup();
    setPhone(false);
  });

  test('on a coarse pointer a group disclosure reaches 44px without reserving that height in its row (COR-2403)', () => {
    const { container } = render(StackedListItem, {
      props: {
        title: textSnippet('Daily summary'),
        status: textSnippet('Missed runs'),
        time: textSnippet('Oct 30'),
        meta: textSnippet('Schedule, Assistant'),
        details: textSnippet('Mon, Nov 2, 3:00 AM'),
      },
    });
    expect(container.querySelector('.cinder-stacked-list-item__disclosure')?.textContent).toContain(
      'Show',
    );

    const coarse = stylesheet.slice(stylesheet.indexOf('@media (any-pointer: coarse)'));
    const compactDisclosure =
      /\.cinder-stacked-list-item__disclosure\s*\{([^}]*)\}/.exec(coarse)?.[1] ?? '';
    expect(compactDisclosure).toMatch(/min-block-size:\s*0;/);
    const hitArea =
      /\.cinder-stacked-list-item__disclosure::before\s*\{([^}]*)\}/.exec(coarse)?.[1] ?? '';
    expect(hitArea).toMatch(/position:\s*absolute;/);
    expect(hitArea).toContain('var(--cinder-touch-target-min)');
  });

  test('at 200% text in a 375px container a group row lets Show drop whole under its time, never past the row', () => {
    setPhone(true);
    // A phone-width container whose text is twice the size: the time and its Show no longer fit
    // beside each other, so the row must give somewhere other than the page's edge.
    const host = document.createElement('div');
    host.style.inlineSize = '375px';
    host.style.fontSize = '200%';
    document.body.append(host);
    const { container } = render(StackedListItem, {
      target: host,
      props: {
        title: textSnippet('Daily summary'),
        status: textSnippet('Missed runs'),
        time: 'Oct 30',
        meta: textSnippet('Schedule, Assistant, every day at 9:00 AM, missed 4 times since Oct 30'),
        details: textSnippet('Mon, Nov 2, 3:00 AM'),
      },
    });
    const row = container.querySelector('.cinder-stacked-list-item');
    expect(row?.classList.contains('cinder-stacked-list-item--group')).toBe(true);
    const cell = row?.querySelector('.cinder-stacked-list-item__time');
    // The time and Show are the cell's own items, so the cell's wrapping falls between them.
    expect(cell?.querySelector(':scope > .cinder-stacked-list-item__time-text')?.textContent).toBe(
      'Oct 30',
    );
    expect(
      cell?.querySelector(':scope > .cinder-stacked-list-item__disclosure')?.textContent,
    ).toContain('Show');
    // The group row's cell wraps, at its end, with no gap added between its lines.
    const group =
      /\.cinder-stacked-list-item--lines\.cinder-stacked-list-item--group\s+\.cinder-stacked-list-item__time\s*\{([^}]*)\}/.exec(
        stylesheet,
      )?.[1] ?? '';
    expect(group).toMatch(/flex-wrap:\s*wrap;/);
    expect(group).toMatch(/justify-content:\s*flex-end;/);
    expect(group).toMatch(/row-gap:\s*0;/);
    // Neither side breaks inside itself: the cell keeps the two-line layout's `nowrap`, so "Oct 30"
    // stays one piece, and Show never shrinks or breaks.
    expect(group).not.toContain('white-space');
    const base =
      /\.cinder-stacked-list-item--lines \.cinder-stacked-list-item__time\s*\{([^}]*)\}/.exec(
        stylesheet,
      )?.[1] ?? '';
    expect(base).toMatch(/white-space:\s*nowrap;/);
    const own = /\.cinder-stacked-list-item__disclosure\s*\{([^}]*)\}/.exec(stylesheet)?.[1] ?? '';
    expect(own).toMatch(/flex:\s*none;/);
    expect(own).toMatch(/white-space:\s*nowrap;/);
    cleanup();
    host.remove();
    setPhone(false);
  });

  test('at 375 a short title with a long time and no trailing control keeps the time on one line', () => {
    setPhone(true);
    const { container } = render(StackedListItem, {
      props: {
        title: textSnippet('Daily summary'),
        status: textSnippet('Active'),
        time: textSnippet('Next Fri Nov 6, 11:00 AM'),
        meta: textSnippet('Workflow, Release notes'),
      },
    });
    const row = container.querySelector('.cinder-stacked-list-item');
    // No trailing control, so neither the cap nor the wrapping reaches it: the time cell keeps the
    // two-line layout's own `nowrap` and an `auto` track, as it has on a tablet.
    expect(row?.classList.contains('cinder-stacked-list-item--has-trailing')).toBe(false);
    const base =
      /\.cinder-stacked-list-item--lines \.cinder-stacked-list-item__time\s*\{([^}]*)\}/.exec(
        stylesheet,
      )?.[1] ?? '';
    expect(base).toMatch(/white-space:\s*nowrap;/);
    expect(stylesheet).toMatch(/\[time\] var\(--_cinder-time-track, auto\)/);
    expect([...stylesheet.matchAll(/--_cinder-time-track:/g)]).toHaveLength(1);
    cleanup();
    setPhone(false);
  });

  test('at 200% text a viewport-width phone row reflows its timestamp instead of widening its list (COR-2403)', () => {
    setPhone(true);
    const { container } = render(StackedListItem, {
      props: {
        phoneWidth: 'viewport',
        title: textSnippet('Daily summary'),
        status: textSnippet('Waiting on you'),
        time: textSnippet('Yesterday, 6:00 PM'),
        meta: textSnippet('Workflow run, Assistant'),
      },
    });
    const row = container.querySelector('.cinder-stacked-list-item');
    expect(row?.getAttribute('data-cinder-phone-width')).toBe('viewport');
    expect(row?.hasAttribute('data-cinder-phone')).toBe(true);
    expect(row?.querySelector('.cinder-stacked-list-item__time')?.textContent?.trim()).toBe(
      'Yesterday, 6:00 PM',
    );
    expect(row?.querySelector('.cinder-stacked-list-item__meta')?.textContent).toBe(
      'Workflow run, Assistant',
    );

    const viewportPhoneTime =
      /\[data-cinder-phone-width='viewport'\]\[data-cinder-phone\]\.cinder-stacked-list-item--status-leading:not\(\s*\.cinder-stacked-list-item--group\s*\)\s+\.cinder-stacked-list-item__time\s*\{([^}]*)\}/.exec(
        stylesheet,
      )?.[1] ?? '';
    expect(viewportPhoneTime).toMatch(/white-space:\s*normal;/);
    cleanup();
    setPhone(false);
  });

  test('at 320 a row with a switch at its end keeps Delivered, Unavailable and Needs setup whole', () => {
    setPhone(true);
    for (const word of ['Delivered', 'Unavailable', 'Needs setup']) {
      const { container } = render(StackedListItem, {
        props: {
          title: textSnippet('Post settled runs'),
          badge: textSnippet('Plugin'),
          status: textSnippet(word),
          time: textSnippet('Yesterday, 6:00 PM'),
          meta: textSnippet('When a review is waiting, run Post message from Slack'),
          trailing: textSnippet('On'),
        },
      });
      const row = container.querySelector('.cinder-stacked-list-item');
      expect(row?.classList.contains('cinder-stacked-list-item--has-trailing')).toBe(true);
      expect(row?.querySelector('.cinder-stacked-list-item__status')?.textContent).toBe(word);
      cleanup();
    }
    // The word's track is its own width and it never shrinks; the time gives way to its widest line.
    const phoneBlocks = stylesheet.slice(
      stylesheet.indexOf('/* A narrow row puts a leading status on line two'),
    );
    expect(phoneBlocks).toMatch(/--_cinder-status-track:\s*max-content;/);
    expect(cappedRule('> .cinder-stacked-list-item__layout')).toContain('min-content');
    setPhone(false);
  });

  test('phoneActions="buttons" keeps each action a button, stacked full width under the text', () => {
    setPhone(true);
    const { container, getByRole, queryByRole } = render(ExtrasFixture, {
      props: {
        mode: 'actions',
        phoneActions: 'buttons',
        actions: [
          { label: 'Answer', href: '/reviews/one' },
          { label: 'Review', href: '/reviews/two' },
        ],
      },
    });
    expect(queryByRole('button', { name: 'More actions' })).toBeNull();
    const row = container.querySelector('.cinder-stacked-list-item');
    expect(row?.classList.contains('cinder-stacked-list-item--phone-buttons')).toBe(true);
    // Not the collapsed form, so the narrow container query puts the actions under the body.
    expect(row?.classList.contains('cinder-stacked-list-item--collapsed-actions')).toBe(false);
    expect(getByRole('link', { name: 'Answer' }).getAttribute('href')).toBe('/reviews/one');
    expect(getByRole('link', { name: 'Review' }).getAttribute('href')).toBe('/reviews/two');
    expect(stylesheet).toMatch(
      /--phone-buttons \.cinder-stacked-list-item__actions\s*\{[^}]*flex-direction:\s*column/,
    );
    expect(stylesheet).toMatch(
      /--phone-buttons \.cinder-stacked-list-item__actions > \.cinder-button\s*\{[^}]*inline-size:\s*100%/,
    );
    // A two-line row gives the actions a row of their own under both lines.
    expect(stylesheet).toMatch(
      /--phone-buttons\s*>\s*\.cinder-stacked-list-item__layout\s*\{[^}]*'trailing trailing trailing trailing'/,
    );
    cleanup();
    setPhone(false);
  });

  test('phoneActions="buttons" changes nothing on a tablet or desktop', () => {
    setPhone(false);
    const { container } = render(ExtrasFixture, {
      props: {
        mode: 'actions',
        phoneActions: 'buttons',
        actions: [{ label: 'Answer', href: '/a' }],
      },
    });
    const row = container.querySelector('.cinder-stacked-list-item');
    expect(row?.classList.contains('cinder-stacked-list-item--phone-buttons')).toBe(false);
    expect(container.querySelector('.cinder-stacked-list-item__actions')).not.toBeNull();
    cleanup();
  });

  test('an action marked `changes` carries data-changes as a button, a link and a menu item', async () => {
    setPhone(false);
    const wide = render(ExtrasFixture, {
      props: {
        mode: 'actions',
        actions: [
          { label: 'Answer', href: '/a', changes: true },
          { label: 'Plain', href: '/b' },
          { label: 'Press', onclick: () => undefined, changes: true },
        ],
      },
    });
    expect(wide.getByRole('link', { name: 'Answer' }).hasAttribute('data-changes')).toBe(true);
    expect(wide.getByRole('link', { name: 'Plain' }).hasAttribute('data-changes')).toBe(false);
    expect(wide.getByRole('button', { name: 'Press' }).hasAttribute('data-changes')).toBe(true);
    cleanup();

    setPhone(true);
    const narrow = render(ExtrasFixture, {
      props: {
        mode: 'actions',
        actions: [
          { label: 'Answer', href: '/a', changes: true },
          { label: 'Plain', href: '/b' },
        ],
      },
    });
    await fireEvent.click(narrow.getByRole('button', { name: 'More actions' }));
    const item = [...document.querySelectorAll('.cinder-dropdown-item')].find((element) =>
      element.textContent?.includes('Answer'),
    );
    expect(item?.hasAttribute('data-changes')).toBe(true);
    cleanup();
    setPhone(false);
  });

  test('a third line wraps under line two, starts at the left edge on a phone and is never cut', () => {
    setPhone(true);
    const { container, getByTestId } = render(ExtrasFixture, { props: { mode: 'detail' } });
    const row = container.querySelector('.cinder-stacked-list-item');
    const line = getByTestId('detail').closest('.cinder-stacked-list-item__detail');
    expect(line).not.toBeNull();
    // It is a sibling of line two inside the row, so it follows line two in reading order.
    expect(
      row?.querySelector('.cinder-stacked-list-item__line-two + .cinder-stacked-list-item__detail'),
    ).toBe(line);
    expect(stylesheet).toMatch(
      /__detail\s*\{[^}]*grid-row:\s*details;[^}]*overflow-wrap:\s*anywhere/,
    );
    expect(stylesheet).toMatch(
      /--lines:not\(\s*\.cinder-stacked-list-item--band,\s*\[data-cinder-phone-width='viewport'\]\s*\)\s+\.cinder-stacked-list-item__detail\s*\{[^}]*grid-column:\s*2 \/ 5/,
    );
    // A row that follows the window takes the same rule from the script's phone mark.
    expect(stylesheet).toMatch(
      /\[data-cinder-phone-width='viewport'\]\[data-cinder-phone\]\s+\.cinder-stacked-list-item__detail\s*\{[^}]*grid-column:\s*2 \/ 5/,
    );
    // Wrapping, not truncating: the third line carries no ellipsis or nowrap rule.
    const rule = /\.cinder-stacked-list-item__detail\s*\{[^}]*\}/.exec(stylesheet)?.[0] ?? '';
    expect(rule).not.toContain('nowrap');
    expect(rule).not.toContain('text-overflow');
    cleanup();
    setPhone(false);
  });
});
