/// <reference lib="dom" />
/**
 * COR-2770: the phone form is chosen in CSS, not in script. Both forms are in the markup at every
 * viewport (the whole trail and the back link to the parent), and a viewport query in
 * `breadcrumbs.css` shows one of them. happy-dom evaluates no viewport query, so these tests pin the
 * markup the component renders and the declarations the stylesheet holds; the browser checks in
 * `scripts/browser-fixtures/tests/breadcrumbs-first-paint.playwright.ts` measure what paints.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  atRuleDeclarationsFor,
  declarationsFor,
} from '@lostgradient/component-tooling/test/css.ts';
import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { createRawSnippet, flushSync } = await import('svelte');
const { default: Breadcrumbs } = await import('./breadcrumbs.svelte');

const stylesheet = readFileSync(new URL('./breadcrumbs.css', import.meta.url), 'utf8');
const PHONE_QUERY = '(width < 640px)';
const PHONE = ".cinder-breadcrumbs[data-cinder-phone-below='640px']";

afterEach(() => {
  cleanup();
});

const trail = [{ label: 'Runs', href: '/runs' }, { label: 'Look up order 4472' }];

describe('Breadcrumbs phone form', () => {
  test('renders both forms: the whole trail and a back link labelled with the parent', () => {
    const { container } = render(Breadcrumbs, { items: trail });

    const back = container.querySelector<HTMLAnchorElement>('.cinder-breadcrumbs__back');
    expect(back?.getAttribute('href')).toBe('/runs');
    expect(back?.getAttribute('aria-label')).toBe('Back to Runs');
    expect(back?.textContent?.trim()).toBe('Runs');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('a.cinder-breadcrumbs__link')?.getAttribute('href')).toBe(
      '/runs',
    );
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    const nav = container.querySelector('nav');
    expect(nav?.getAttribute('data-cinder-phone-below')).toBe('640px');
    expect(nav?.hasAttribute('data-cinder-collapsed')).toBe(false);
  });

  test('the back link of a deeper trail goes to the parent, and every ancestor stays in the list', () => {
    const { container } = render(Breadcrumbs, {
      items: [
        { label: 'Home', href: '/' },
        { label: 'Goals', href: '/goals' },
        { label: 'Draft release notes' },
      ],
    });

    expect(container.querySelector('.cinder-breadcrumbs__back')?.getAttribute('href')).toBe(
      '/goals',
    );
    expect(
      [...container.querySelectorAll('a.cinder-breadcrumbs__link')].map((link) =>
        link.getAttribute('href'),
      ),
    ).toEqual(['/', '/goals']);
  });

  test('a trail at a section root shows only the current page', () => {
    const { container } = render(Breadcrumbs, { items: [{ label: 'Runs' }] });

    expect(container.querySelector('.cinder-breadcrumbs__back')).toBeNull();
    expect(container.querySelectorAll('li')).toHaveLength(1);
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('Runs');
  });

  test('a parent without an href has no back link', () => {
    const { container } = render(Breadcrumbs, {
      items: [{ label: 'Runs' }, { label: 'Look up order 4472' }],
    });

    expect(container.querySelector('.cinder-breadcrumbs__back')).toBeNull();
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  test('backLabel names the back link and replaces {label}', () => {
    const { container } = render(Breadcrumbs, { items: trail, backLabel: 'Return to {label}' });

    expect(container.querySelector('.cinder-breadcrumbs__back')?.getAttribute('aria-label')).toBe(
      'Return to Runs',
    );
  });

  test('collapseBelow={false} renders only the whole trail', () => {
    const { container } = render(Breadcrumbs, { items: trail, collapseBelow: false });

    expect(container.querySelector('.cinder-breadcrumbs__back')).toBeNull();
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('nav')?.hasAttribute('data-cinder-phone-below')).toBe(false);
    expect(container.querySelector('style')).toBeNull();
  });

  test('the default length adds no style of its own: breadcrumbs.css holds its rules', () => {
    const { container } = render(Breadcrumbs, { items: trail });

    expect(container.querySelector('style')).toBeNull();
  });

  test('another length brings the phone form for that length in a style beside the trail', () => {
    const { container } = render(Breadcrumbs, { items: trail, collapseBelow: '48rem' });

    expect(container.querySelector('nav')?.getAttribute('data-cinder-phone-below')).toBe('48rem');
    const style = container.querySelector('nav > style')?.textContent ?? '';
    expect(style).toContain('@media not all and (min-width: 48rem)');
    expect(style).toContain(
      '.cinder-breadcrumbs[data-cinder-phone-below="48rem"] .cinder-breadcrumbs__back { display: inline-flex; }',
    );
    expect(style).not.toContain('640px');
    expect(container.querySelector('.cinder-breadcrumbs__back')?.getAttribute('href')).toBe(
      '/runs',
    );
  });

  test('rejects a breakpoint that is not a CSS length', () => {
    expect(() => render(Breadcrumbs, { items: trail, collapseBelow: 'phone' })).toThrow(
      'Breadcrumbs collapseBelow must be a CSS length such as "640px", or false.',
    );
  });

  test('wider than 640px the back link is display: none, so only the whole trail shows', () => {
    expect(declarationsFor(stylesheet, '.cinder-breadcrumbs__back').get('display')).toBe('none');
  });

  test('narrower than 640px the ancestors are display: none and the back link and the current page show', () => {
    expect(
      atRuleDeclarationsFor(
        stylesheet,
        'media',
        PHONE_QUERY,
        `${PHONE} .cinder-breadcrumbs__item:not(:last-child)`,
      ).get('display'),
    ).toBe('none');
    expect(
      atRuleDeclarationsFor(
        stylesheet,
        'media',
        PHONE_QUERY,
        `${PHONE} .cinder-breadcrumbs__back`,
      ).get('display'),
    ).toBe('inline-flex');
    expect(atRuleDeclarationsFor(stylesheet, 'media', PHONE_QUERY, PHONE).get('display')).toBe(
      'flex',
    );
  });

  test('the phone form is keyed to the trail that asks for 640px, and no rule outside the query hides an ancestor', () => {
    for (const selector of [
      PHONE,
      `${PHONE} .cinder-breadcrumbs__back`,
      `${PHONE} .cinder-breadcrumbs__list`,
      `${PHONE} .cinder-breadcrumbs__current`,
    ]) {
      expect(
        atRuleDeclarationsFor(stylesheet, 'media', PHONE_QUERY, selector).size,
      ).toBeGreaterThan(0);
    }
    const outsideQuery = stylesheet.slice(0, stylesheet.indexOf(`@media ${PHONE_QUERY}`));
    expect(outsideQuery).not.toContain('data-cinder-phone-below');
  });

  test('the back link has a 44px hit area that takes no layout space', () => {
    const hit = declarationsFor(stylesheet, '.cinder-breadcrumbs__back::after');
    expect(hit.get('block-size')).toBe('var(--cinder-touch-target-min)');
    expect(hit.get('position')).toBe('absolute');
  });

  test('the back link is not capped, so the current page truncates before the parent does', () => {
    const rule = declarationsFor(stylesheet, '.cinder-breadcrumbs__back');
    expect(rule.get('flex')).toBe('0 1 auto');
    expect(rule.has('max-inline-size')).toBe(false);
  });

  test('on a tablet trail the current crumb shrinks before any ancestor does', () => {
    const shrink = (selector: string): number =>
      Number(declarationsFor(stylesheet, selector).get('flex-shrink'));
    expect(shrink('.cinder-breadcrumbs__item:last-child')).toBeGreaterThan(
      shrink('.cinder-breadcrumbs__item'),
    );
  });

  test('the current crumb outweighs an ancestor so far that no fraction of a pixel reaches it', () => {
    // A ratio of 100 to 1 still shrinks a four-character "Runs" by a third of a pixel when the
    // current title is long, which is enough for its ellipsis to engage on a label that fits ("Ru…").
    const list = atRuleDeclarationsFor(
      stylesheet,
      'media',
      PHONE_QUERY,
      `${PHONE} .cinder-breadcrumbs__list`,
    );
    const listFactor = Number(/^1 (\d+) auto$/.exec(list.get('flex') ?? '')?.[1]);
    const leafFactor = Number(
      declarationsFor(stylesheet, '.cinder-breadcrumbs__item:last-child').get('flex-shrink'),
    );
    expect(listFactor).toBeGreaterThanOrEqual(100_000);
    expect(leafFactor).toBeGreaterThanOrEqual(100_000);
  });
});

describe('Breadcrumbs current page popover', () => {
  const longTitle =
    'Please refund order 4471, it arrived damaged, and also check whether the Parcelly damage claims batch from last week was filed for the same carrier';
  const longTrail = [
    { label: 'Chat', href: '/chat' },
    { label: longTitle, popover: true as const },
  ];

  test('draws the current page as a bordered button that keeps the full title', () => {
    const { container } = render(Breadcrumbs, { items: longTrail });

    const trigger = container.querySelector<HTMLButtonElement>('.cinder-breadcrumbs__trigger');
    expect(trigger?.tagName).toBe('BUTTON');
    expect(trigger?.getAttribute('aria-current')).toBe('page');
    expect(trigger?.querySelector('.cinder-breadcrumbs__trigger-label')?.textContent).toBe(
      longTitle,
    );
    expect(stylesheet).toMatch(
      /\.cinder-breadcrumbs__trigger\s*\{[^}]*max-inline-size:[^;]*18\.75rem/,
    );
    expect(stylesheet).toMatch(
      /\.cinder-breadcrumbs__trigger-label\s*\{[^}]*text-overflow:\s*ellipsis/,
    );
  });

  test('opens a dialog popover holding the full title', async () => {
    const { container } = render(Breadcrumbs, { items: longTrail });
    const trigger = container.querySelector<HTMLButtonElement>('.cinder-breadcrumbs__trigger');
    if (!trigger) throw new Error('missing trigger');

    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(trigger);
    flushSync();

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    const panel = document.querySelector('.cinder-breadcrumbs__popover-text');
    expect(panel?.textContent).toBe(longTitle);
  });

  test('a snippet fills the popover with anything else', async () => {
    const content = createRawSnippet(() => ({
      render: () => '<span class="custom-popover">Rename or delete this chat</span>',
    }));
    const { container } = render(Breadcrumbs, {
      items: [
        { label: 'Chat', href: '/chat' },
        { label: 'Refund order 4471', popover: content },
      ],
    });
    const trigger = container.querySelector<HTMLButtonElement>('.cinder-breadcrumbs__trigger');
    if (!trigger) throw new Error('missing trigger');
    await fireEvent.click(trigger);
    flushSync();

    expect(document.querySelector('.custom-popover')?.textContent).toBe(
      'Rename or delete this chat',
    );
  });

  test('keeps the popover trigger beside the back link, for the phone form', () => {
    const { container } = render(Breadcrumbs, { items: longTrail });

    expect(container.querySelector('.cinder-breadcrumbs__back')?.getAttribute('href')).toBe(
      '/chat',
    );
    expect(container.querySelector('.cinder-breadcrumbs__trigger')).not.toBeNull();
  });

  test('an ancestor entry never becomes a trigger', () => {
    const { container } = render(Breadcrumbs, {
      items: [{ label: 'Chat', href: '/chat', popover: true }, { label: 'Current' }],
    });

    expect(container.querySelector('.cinder-breadcrumbs__trigger')).toBeNull();
  });
});

describe('Breadcrumbs maxVisible (sweep S18)', () => {
  const deep = [
    { label: 'Home', href: '/' },
    { label: 'Agents', href: '/agents' },
    { label: 'Tool runner', href: '/agents/tool-runner' },
    { label: 'Memory' },
  ];

  test('shows every ancestor when the container is not measured as narrow', () => {
    const { container } = render(Breadcrumbs, { items: deep });

    expect(container.querySelector('.cinder-breadcrumbs__overflow')).toBeNull();
    expect(container.querySelectorAll('.cinder-breadcrumbs__link')).toHaveLength(3);
  });

  test('folds the earliest ancestors into a "…" button, keeping the nearest ones', () => {
    const { container } = render(Breadcrumbs, { items: deep, maxVisible: 1 });

    const links = [...container.querySelectorAll('.cinder-breadcrumbs__link')];
    expect(links.map((link) => link.textContent)).toEqual(['Tool runner']);
    const button = container.querySelector('.cinder-breadcrumbs__overflow');
    expect(button?.getAttribute('aria-label')).toBe('Show earlier pages');
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('Memory');
  });

  test('the "…" button lists the hidden ancestors as links and reports a click', async () => {
    const opened: string[] = [];
    const { container } = render(Breadcrumbs, {
      items: deep,
      maxVisible: 1,
      onOverflowNavigate: (item: { label: string }, event: MouseEvent) => {
        event.preventDefault();
        opened.push(item.label);
      },
    });

    await fireEvent.click(container.querySelector('.cinder-breadcrumbs__overflow') as Element);
    flushSync();
    const hidden = [...document.querySelectorAll('.cinder-breadcrumbs__overflow-link')];
    expect(hidden.map((link) => link.textContent)).toEqual(['Home', 'Agents']);
    await fireEvent.click(hidden[1] as Element);
    expect(opened).toEqual(['Agents']);
  });

  test('maxVisible of zero folds every ancestor, and a trail that fits folds none', () => {
    const none = render(Breadcrumbs, { items: deep, maxVisible: 0 });
    expect(none.container.querySelectorAll('.cinder-breadcrumbs__link')).toHaveLength(0);
    expect(none.container.querySelector('.cinder-breadcrumbs__overflow')).not.toBeNull();
    none.unmount();

    const fits = render(Breadcrumbs, { items: deep, maxVisible: 5 });
    expect(fits.container.querySelector('.cinder-breadcrumbs__overflow')).toBeNull();
  });

  test('a maxVisible that is not a whole number is refused', () => {
    expect(() => render(Breadcrumbs, { items: deep, maxVisible: -1 })).toThrow('maxVisible');
    expect(() => render(Breadcrumbs, { items: deep, maxVisible: 1.5 })).toThrow('maxVisible');
  });
});
