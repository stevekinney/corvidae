/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';

import Ajv2020 from 'ajv/dist/2020';

import { readComponentSchema } from '@lostgradient/component-tooling/scripts/lib/metadata-files.ts';
import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

// setupHappyDom() MUST run before any `@testing-library/svelte` import.
setupHappyDom();

const { render, cleanup } = await import('@testing-library/svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const { createRawSnippet, flushSync } = await import('svelte');
const { default: PageHeader } = await import('./page-header.svelte');
const { default: Harness } = await import('./page-header-harness.test.svelte');
const { fireEvent } = await import('@testing-library/svelte');
const { readFileSync } = await import('node:fs');
const stylesheet = readFileSync(new URL('./page-header.css', import.meta.url), 'utf8');
const pageHeaderSchema = readComponentSchema('page-header');

describe('PageHeader actions row height', () => {
  test('adds no block padding beyond the title line box', () => {
    const rule = stylesheet.match(/\.cinder-page-header__actions\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).not.toMatch(/padding/);
  });
});

describe('PageHeader', () => {
  test('regular actions use their own size and keep the error emphasis context', async () => {
    const { getByRole, rerender } = render(Harness, {
      props: { withActions: true, error: true },
    });

    const action = getByRole('button', { name: 'Add a memory' });
    const create = getByRole('button', { name: 'New agent' });
    expect(action.getAttribute('data-cinder-size')).toBe('xs');
    expect(create.getAttribute('data-cinder-size')).toBe('xs');

    await rerender({ compactActions: false });

    expect(action.getAttribute('data-cinder-size')).toBe('md');
    expect(create.getAttribute('data-cinder-size')).toBe('md');
    expect(action.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(action.hasAttribute('data-cinder-compact')).toBe(false);
  });

  test('schema requires a string title and supports an optional string description', () => {
    const validate = new Ajv2020({ strict: false }).compile(pageHeaderSchema);

    expect(pageHeaderSchema.required).toEqual(['title']);
    expect(pageHeaderSchema.properties).toMatchObject({
      title: { type: 'string' },
      description: { type: 'string' },
      headingLevel: { enum: [1, 2, 3, 4, 5, 6], default: 1 },
      error: { type: 'boolean', default: false },
      compactActions: { type: 'boolean', default: true },
      statusPlacement: { enum: ['inline', 'below'], default: 'below' },
      variant: { enum: ['default', 'large', 'hero'], default: 'default' },
      tone: { enum: ['plain', 'tint', 'accent', 'night'], default: 'plain' },
      titleSoft: { type: 'string' },
      eyebrow: { type: 'string' },
    });
    expect(pageHeaderSchema.metadata?.unsupportedProps?.map((prop) => prop.name)).toEqual([
      'actions',
      'art',
      'breadcrumbs',
      'decisions',
      'facts',
      'focal',
      'media',
      'status',
    ]);
    expect(validate({ title: 'Poor Decisions', variant: 'hero', tone: 'accent' })).toBe(true);
    expect(validate({ title: 'Poor Decisions', tone: 'neon' })).toBe(false);
    expect(validate({ title: 'Approvals', description: 'Review pending requests.' })).toBe(true);
    expect(validate({})).toBe(false);
    expect(validate({ title: 'Approvals', headingLevel: 2 })).toBe(true);
    expect(validate({ title: 'Approvals', headingLevel: 7 })).toBe(false);
  });

  test.each([1, 2, 3, 4, 5, 6] as const)(
    'renders headingLevel %i as its heading element',
    (level) => {
      const { container } = render(PageHeader, {
        props: { title: 'Approvals', headingLevel: level },
      });
      expect(container.querySelector('.cinder-page-header__title')?.tagName).toBe(`H${level}`);
    },
  );

  test.each([
    [0, 'H1'],
    [9, 'H6'],
    [Number.NaN, 'H1'],
  ])('clamps an out-of-range headingLevel %p from untyped callers to %s', (level, tag) => {
    const { container } = render(PageHeader, {
      props: { title: 'Approvals', headingLevel: level as never },
    });
    expect(container.querySelector('.cinder-page-header__title')?.tagName).toBe(tag);
  });

  test('renders the required title as h1 by default', () => {
    const { container } = render(PageHeader, { props: { title: 'Approvals' } });
    const titleEl = container.querySelector('.cinder-page-header__title');
    expect(titleEl).not.toBeNull();
    expect(titleEl?.tagName).toBe('H1');
    expect(titleEl?.textContent?.trim()).toBe('Approvals');
  });

  test('renders named title, description, breadcrumb, and action regions', () => {
    const title = createRawSnippet(() => ({
      render: () => `<span>Schedules</span>`,
      setup: () => {},
    }));
    const description = createRawSnippet(() => ({
      render: () => `<span>Manage automated schedules.</span>`,
      setup: () => {},
    }));
    const breadcrumbs = createRawSnippet(() => ({
      render: () => `<nav aria-label="Breadcrumb">Home / Schedules</nav>`,
      setup: () => {},
    }));
    const actions = createRawSnippet(() => ({
      render: () => `<button>New schedule</button>`,
      setup: () => {},
    }));

    const { container } = render(PageHeader, {
      props: { title, description, breadcrumbs, actions },
    });

    expect(container.querySelector('h1')?.textContent).toBe('Schedules');
    expect(container.querySelector('.cinder-page-header__description')?.textContent).toBe(
      'Manage automated schedules.',
    );
    expect(
      container.querySelector('.cinder-page-header__breadcrumbs nav')?.getAttribute('aria-label'),
    ).toBe('Breadcrumb');
    expect(container.querySelector('.cinder-page-header__actions button')?.textContent).toBe(
      'New schedule',
    );
  });

  test('does not render optional named regions when they are omitted', () => {
    const { container } = render(PageHeader, { props: { title: 'Schedules' } });
    expect(container.querySelector('.cinder-page-header__description')).toBeNull();
    expect(container.querySelector('.cinder-page-header__breadcrumbs')).toBeNull();
    expect(container.querySelector('.cinder-page-header__actions')).toBeNull();
  });

  test('draws no rule by default; divider opts in', () => {
    const plain = render(PageHeader, { props: { title: 'Runs' } });
    const header = () => plain.container.querySelector('.cinder-page-header');
    expect(header()?.hasAttribute('data-cinder-divider')).toBe(false);
    cleanup();
    const ruled = render(PageHeader, { props: { title: 'Runs', divider: true } });
    expect(
      ruled.container.querySelector('.cinder-page-header')?.getAttribute('data-cinder-divider'),
    ).toBe('true');
  });

  test('clamps the title to two lines by default, and to one line that lets an inline status drop under it with titleLines 1 (COR-2438)', () => {
    const plain = render(PageHeader, { props: { title: 'Runs' } });
    expect(
      plain.container.querySelector('.cinder-page-header')?.hasAttribute('data-cinder-title-lines'),
    ).toBe(false);
    cleanup();
    const single = render(PageHeader, { props: { title: 'Runs', titleLines: 1 } });
    expect(
      single.container
        .querySelector('.cinder-page-header')
        ?.getAttribute('data-cinder-title-lines'),
    ).toBe('1');
    const line =
      stylesheet.match(
        /\.cinder-page-header\[data-cinder-title-lines='1'\] \.cinder-page-header__title-line\s*\{[^}]*\}/,
      )?.[0] ?? '';
    expect(line).toContain('flex-wrap: wrap;');
    const title =
      stylesheet.match(
        /\.cinder-page-header\[data-cinder-title-lines='1'\] \.cinder-page-header__title\s*\{[^}]*\}/,
      )?.[0] ?? '';
    expect(title).toContain('line-clamp: 1;');
  });

  test('is flush with the content below by default, and insets only when asked (COR-2448)', () => {
    const { container } = render(PageHeader, { props: { title: 'Allowed models' } });
    const root = () => container.querySelector('.cinder-page-header');
    expect(root()?.hasAttribute('data-cinder-inset')).toBe(false);
    cleanup();
    const inset = render(PageHeader, { props: { title: 'Allowed models', inset: true } });
    expect(
      inset.container.querySelector('.cinder-page-header')?.getAttribute('data-cinder-inset'),
    ).toBe('true');

    // The base rules draw no padding; only the `inset` mark brings it back.
    expect(stylesheet).toMatch(/\.cinder-page-header__row \{[^}]*padding: 0;/u);
    expect(stylesheet).toMatch(
      /\[data-cinder-inset='true'\] \.cinder-page-header__row \{[^}]*padding: var\(--cinder-space-3\) var\(--cinder-space-4\);/u,
    );
    expect(stylesheet).not.toContain('data-cinder-flush');
  });

  test('actions and the create button render at xs, the create button in a slot of its own', () => {
    const { container } = render(Harness, { props: { withActions: true } });
    const buttons = container.querySelectorAll('.cinder-page-header__actions button');
    expect(buttons.length).toBe(3);
    for (const button of buttons) expect(button.getAttribute('data-cinder-size')).toBe('xs');
    // The create "+" is the last action, in its own slot after the others, so a narrow header can
    // keep it beside the title while the rest move.
    const slots = [...container.querySelectorAll('.cinder-page-header__row > *')];
    expect(slots.map((slot) => slot.className)).toEqual([
      'cinder-page-header__heading-group',
      'cinder-page-header__actions',
      'cinder-page-header__actions cinder-page-header__create-slot',
    ]);
    expect(slots[2]?.querySelector('.cinder-page-header__create')).not.toBeNull();
    expect(slots[1]?.querySelector('.cinder-page-header__create')).toBeNull();
  });

  // Owner decision reversing COR-2337: on a phone the title gets the full row.
  test('a narrow header moves every action but the create "+" to a row under the title', () => {
    const narrow =
      /@container cinder-page-header \(max-width: 32rem\)\s*\{([\s\S]*?)\n {2}\}/.exec(
        stylesheet,
      )?.[1] ?? '';
    expect(narrow).toMatch(/\.cinder-page-header__row \{\s*flex-wrap: wrap;/);
    expect(narrow).toMatch(/\.cinder-page-header__heading-group \{\s*flex-basis: 0;/);
    expect(narrow).toMatch(
      /\.cinder-page-header__actions:not\(\.cinder-page-header__create-slot\) \{\s*order: 1;\s*flex-basis: 100%;/,
    );
    // The "+" stays at the end of the title's line.
    expect(narrow).toMatch(
      /\.cinder-page-header__row > \.cinder-page-header__actions \+ \.cinder-page-header__create-slot \{\s*margin-inline-start: auto;/,
    );
    // A status item moves to the next line whole (it is a flex item of a wrapping row, kept to the
    // line's width), and breaks inside only when it is wider than a line, so a long identifier never
    // widens the page. No divider is left at the end of a line.
    expect(narrow).toMatch(
      /\.cinder-page-header__status > \* \{\s*max-inline-size: 100%;\s*overflow-wrap: anywhere;/,
    );
    expect(narrow).not.toMatch(/\.cinder-page-header__status > \* \{\s*white-space: nowrap;/);
    expect(narrow).toMatch(
      /\.cinder-page-header__status > \.cinder-divider\[data-cinder-orientation='vertical'\] \{\s*display: none;/,
    );
    expect(stylesheet).not.toMatch(/actions never move/);
  });

  test('a header with only the create "+" draws one actions slot, and none without actions', () => {
    const { container } = render(PageHeader, {
      props: { title: 'Agents', createAction: { label: 'New agent', href: '/agents/new' } },
    });
    const slots = container.querySelectorAll('.cinder-page-header__actions');
    expect(slots).toHaveLength(1);
    expect(slots[0]?.classList.contains('cinder-page-header__create-slot')).toBe(true);
    cleanup();
    const bare = render(PageHeader, { props: { title: 'Agents' } });
    expect(bare.container.querySelector('.cinder-page-header__actions')).toBeNull();
  });

  test('under an error header a primary action is secondary and still xs', () => {
    const { container } = render(Harness, { props: { withActions: true, error: true } });
    const primary = container.querySelector('.cinder-page-header__actions button');
    expect(primary?.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(primary?.getAttribute('data-cinder-size')).toBe('xs');
  });

  test('the title renders at the page-title token, which resolves to 24px', () => {
    const tokens = readFileSync(new URL('../../styles/tokens-base.css', import.meta.url), 'utf8');
    const declared = (name: string) =>
      tokens.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim() ?? '';
    const titleRule = stylesheet.match(/__title\s*\{[^}]*\}/)?.[0] ?? '';
    expect(titleRule).toContain('font-size: var(--_cinder-page-header-title-size)');
    expect(stylesheet).toMatch(
      /\.cinder-page-header\s*\{[^}]*--_cinder-page-header-title-size:\s*var\(--cinder-text-page-title\);/,
    );
    expect(titleRule).toContain('letter-spacing: var(--cinder-tracking-display)');
    expect(declared('--cinder-text-page-title')).toBe('var(--cinder-text-3xl)');
    expect(declared('--cinder-text-3xl')).toBe('1.5rem');
    expect(declared('--cinder-text-page-title-large')).toBe('1.75rem');
    expect(declared('--cinder-text-display')).toBe('var(--cinder-text-5xl)');
    expect(declared('--cinder-tracking-display')).toBe('-0.02em');
    expect(declared('--cinder-text-heading')).toBe('var(--cinder-text-2xl)');
    expect(declared('--cinder-text-2xl')).toBe('1.25rem');
    expect(declared('--cinder-leading-heading')).toBe('1.2');
    expect(declared('--cinder-font-heading')).toBe('650');
  });

  test('class prop merges onto root div element', () => {
    const { container } = render(PageHeader, {
      props: { title: 'Memory', class: 'my-page-header' },
    });

    const root = container.querySelector('.cinder-page-header');
    expect(root?.tagName).toBe('DIV');
    expect(root?.classList.contains('cinder-page-header')).toBe(true);
    expect(root?.classList.contains('my-page-header')).toBe(true);
  });

  test('rendering multiple page headers does not create banner landmarks', () => {
    const firstTarget = document.createElement('div');
    const secondTarget = document.createElement('div');
    document.body.append(firstTarget, secondTarget);

    render(PageHeader, {
      target: firstTarget,
      props: { title: 'Approvals' },
    });
    render(PageHeader, {
      target: secondTarget,
      props: { title: 'Schedules' },
    });

    expect(firstTarget.querySelectorAll('.cinder-page-header')).toHaveLength(1);
    expect(secondTarget.querySelectorAll('.cinder-page-header')).toHaveLength(1);
    expect(firstTarget.querySelectorAll('header')).toHaveLength(0);
    expect(secondTarget.querySelectorAll('header')).toHaveLength(0);
  });

  describe('create action', () => {
    test('is a secondary icon-only button named for the page', () => {
      const { getByRole, container } = render(Harness);

      const create = getByRole('button', { name: 'New agent' });
      expect(create.getAttribute('data-cinder-variant')).toBe('secondary');
      expect(create.hasAttribute('data-cinder-icon-only')).toBe(true);
      expect(create.querySelector('svg')).not.toBeNull();
      expect(container.querySelector('[role="tooltip"]')?.textContent).toBe('New agent');
    });

    test('names the tooltip without describing the button a second time', () => {
      const { getByRole } = render(Harness);

      expect(
        getByRole('button', { name: 'New agent' }).getAttribute('aria-describedby'),
      ).toBeNull();
    });

    test('is drawn last in the actions region, after custom actions', () => {
      const { container } = render(Harness, { props: { withActions: true } });

      const labels = [
        ...container.querySelectorAll('.cinder-page-header__actions .cinder-button'),
      ].map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim());
      expect(labels).toEqual(['Add a memory', 'Delete', 'New agent']);
    });

    test('is in the same place with no other actions', () => {
      const { container } = render(Harness);

      const actions = container.querySelector('.cinder-page-header__actions');
      expect(actions?.querySelectorAll('.cinder-button')).toHaveLength(1);
    });

    test('presses through onclick, and renders a link when given an href', async () => {
      let pressed = 0;
      const { getByRole } = render(Harness, { props: { onCreate: () => (pressed += 1) } });
      await fireEvent.click(getByRole('button', { name: 'New agent' }));
      expect(pressed).toBe(1);
      cleanup();

      const link = render(Harness, { props: { createHref: '/agents/new' } });
      const anchor = link.getByRole('link', { name: 'New agent' });
      expect(anchor.getAttribute('href')).toBe('/agents/new');
      expect(anchor.getAttribute('data-cinder-variant')).toBe('secondary');
    });

    test('is inert under a stale region, described by its reason, and presses nothing', async () => {
      let pressed = 0;
      const { getByRole } = render(Harness, {
        props: { stale: true, onCreate: () => (pressed += 1) },
      });

      const create = getByRole('button', { name: 'New agent' });
      expect(create.getAttribute('aria-disabled')).toBe('true');
      expect(create.getAttribute('aria-describedby')).not.toBeNull();
      await fireEvent.click(create);
      expect(pressed).toBe(0);
    });

    test('is absent when the page offers none', () => {
      const { container } = render(Harness, { props: { withCreate: false } });

      expect(container.querySelector('.cinder-page-header__actions')).toBeNull();
    });
  });

  describe('full-page error', () => {
    test('draws primary header actions as secondary while an error shows', () => {
      const { getByRole } = render(Harness, { props: { error: true, withActions: true } });

      expect(
        getByRole('button', { name: 'Add a memory' }).getAttribute('data-cinder-variant'),
      ).toBe('secondary');
      // Only primary is demoted; a danger button keeps its meaning.
      expect(getByRole('button', { name: 'Delete' }).getAttribute('data-cinder-variant')).toBe(
        'danger',
      );
      expect(getByRole('button', { name: 'New agent' }).getAttribute('data-cinder-variant')).toBe(
        'secondary',
      );
    });

    test('leaves primary actions primary otherwise, and follows the flag', async () => {
      const { getByRole, rerender } = render(Harness, { props: { withActions: true } });
      expect(
        getByRole('button', { name: 'Add a memory' }).getAttribute('data-cinder-variant'),
      ).toBe('primary');

      await rerender({ withActions: true, error: true });
      expect(
        getByRole('button', { name: 'Add a memory' }).getAttribute('data-cinder-variant'),
      ).toBe('secondary');
    });
  });

  describe('status', () => {
    test('sits on the title line when inline, and under the title otherwise', () => {
      const inline = render(Harness, { props: { withStatus: true, statusPlacement: 'inline' } });
      expect(
        inline.container.querySelector('.cinder-page-header__title-line .harness-status'),
      ).not.toBeNull();
      cleanup();

      const below = render(Harness, { props: { withStatus: true } });
      expect(
        below.container.querySelector('.cinder-page-header__title-line .harness-status'),
      ).toBeNull();
      const status = below.container.querySelector('.cinder-page-header__status');
      expect(status?.getAttribute('data-cinder-placement')).toBe('below');
      expect(status?.previousElementSibling?.className).toBe('cinder-page-header__title-line');
    });

    test('renders no status line without a status', () => {
      const { container } = render(Harness);

      expect(container.querySelector('.cinder-page-header__status')).toBeNull();
    });

    test('drops an inline status under the title in a narrow header, so the title keeps room', () => {
      expect(stylesheet).toMatch(
        /@container cinder-page-header \(max-width: 32rem\)\s*\{[^@]*__status\[data-cinder-placement='inline'\]\s*\{[^}]*flex:\s*1 1 100%/,
      );
    });

    test('keeps the inline status on the first line of a wrapping title', () => {
      expect(stylesheet).toMatch(/__title-line\s*\{[^}]*align-items:\s*flex-start/);
      expect(stylesheet).toMatch(
        /__status\[data-cinder-placement='inline'\]\s*\{[^}]*min-block-size:/,
      );
    });

    // COR-2438: the actions were centred on a 1.125rem line box under a 1.5rem title, and by a
    // margin that assumed every control was the compact height, so a taller control (a page's own
    // Dropdown menu, at the trigger's md height) sat lower than the title's first line.
    test('centres the status and the actions on the title first line, whatever their height', () => {
      const rule = (selector: string) =>
        stylesheet.match(new RegExp(`${selector}\\s*\\{[^}]*\\}`))?.[0] ?? '';
      const actions = rule('\\n  \\.cinder-page-header__actions');
      expect(actions).toContain('font-size: var(--_cinder-page-header-title-size)');
      expect(actions).toContain('line-height: var(--cinder-leading-tight)');
      expect(actions).toContain('block-size: 1lh');
      expect(actions).toContain('align-items: center');
      expect(actions).toContain('margin-block: 0');
      expect(actions).not.toContain('--cinder-text-xl');
      const status = rule("__status\\[data-cinder-placement='inline'\\]");
      expect(status).toContain(
        'min-block-size: calc(var(--_cinder-page-header-title-size) * var(--cinder-leading-tight))',
      );
      expect(stylesheet).not.toMatch(/__status\[data-cinder-placement='inline'\][^}]*text-xl/);
      expect(
        rule('\\.cinder-page-header__actions \\.cinder-dropdown-trigger:not\\(\\.cinder-button\\)'),
      ).toContain('min-block-size: var(--_cinder-compact-control-height)');
      // A Dropdown's trigger is centred as a flex item, not set on a baseline in the line box.
      expect(rule('\\.cinder-page-header__actions \\.cinder-dropdown')).toContain(
        'display: inline-flex',
      );
    });

    test('a narrow header lets the dropped actions row grow to its controls', () => {
      expect(stylesheet).toMatch(
        /@container cinder-page-header \(max-width: 32rem\)\s*\{[^@]*__actions:not\(\.cinder-page-header__create-slot\)\s*\{[^}]*block-size:\s*auto/,
      );
    });
  });

  describe('inert create action', () => {
    test('inertReason keeps the + focusable, ignores the press and describes it', async () => {
      const onclick = mock(() => {});
      const { container } = render(PageHeader, {
        props: {
          title: 'Workflows',
          createAction: { label: 'New workflow', onclick, inertReason: 'Off until the list loads' },
        },
      });
      const create = requiredInstance(
        container.querySelector('.cinder-page-header__create'),
        HTMLElement,
      );
      expect(create.getAttribute('aria-disabled')).toBe('true');
      expect(create.hasAttribute('disabled')).toBe(false);
      create.focus();
      expect(document.activeElement).toBe(create);
      await fireEvent.click(create);
      expect(onclick).not.toHaveBeenCalled();
      const describedBy = create.getAttribute('aria-describedby') ?? '';
      expect(document.getElementById(describedBy)?.textContent).toBe('Off until the list loads');
    });

    test('an inert href create action has no href to open in a new tab or drag', () => {
      const { container } = render(PageHeader, {
        props: {
          title: 'Workflows',
          createAction: {
            label: 'New workflow',
            href: '/workflows/new',
            inertReason: 'Off until the list loads',
          },
        },
      });
      const create = requiredInstance(
        container.querySelector('.cinder-page-header__create'),
        HTMLAnchorElement,
      );
      expect(create.hasAttribute('href')).toBe(false);
      expect(create.getAttribute('aria-disabled')).toBe('true');
    });
  });

  describe('long title', () => {
    const longTitle = 'Please refund order 4471, it arrived damaged, and also check the claims';

    function withHeadingBox(scrollHeight: number, clientHeight: number, run: () => void) {
      const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
      const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
        configurable: true,
        get: () => scrollHeight,
      });
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
        configurable: true,
        get: () => clientHeight,
      });
      try {
        run();
      } finally {
        if (scroll) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scroll);
        else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
        if (client) Object.defineProperty(HTMLElement.prototype, 'clientHeight', client);
        else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
      }
    }

    test('the header is a size container and never wraps its actions to a second row', () => {
      expect(stylesheet).toMatch(/\.cinder-page-header\s*\{[^}]*container-type:\s*inline-size/);
      expect(stylesheet).not.toMatch(/__actions\s*\{[^}]*flex-basis:\s*100%/);
    });

    test('clamps to two lines and never uses the native title attribute', () => {
      const { container } = render(Harness, { props: { title: longTitle } });

      const heading = container.querySelector('.cinder-page-header__title');
      expect(heading?.hasAttribute('title')).toBe(false);
      expect(stylesheet).toMatch(/__title\s*\{[^}]*-webkit-line-clamp:\s*2/);
    });

    test('a title that is cut off is a keyboard stop with the Cinder tooltip, a short one is not', () => {
      withHeadingBox(60, 40, () => {
        const { container } = render(Harness, { props: { title: longTitle } });
        flushSync();
        const heading = container.querySelector('.cinder-page-header__title');
        expect(heading?.getAttribute('tabindex')).toBe('0');
      });
      cleanup();
      withHeadingBox(40, 40, () => {
        const { container } = render(Harness, { props: { title: 'Approvals' } });
        flushSync();
        expect(
          container.querySelector('.cinder-page-header__title')?.hasAttribute('tabindex'),
        ).toBe(false);
      });
    });

    test('takes the tooltip words from titleText when the title is a snippet', () => {
      withHeadingBox(60, 40, () => {
        const { container } = render(Harness, {
          props: { title: 'Plain title', titleText: 'Plain title' },
        });
        flushSync();
        const heading = container.querySelector('.cinder-page-header__title');
        expect(heading?.querySelector('em')?.textContent).toBe('Plain title');
        expect(heading?.getAttribute('tabindex')).toBe('0');
      });
    });
  });
});

describe('PageHeader narrowActions (COR-2327 B2)', () => {
  test('by default draws no narrow-actions attribute, so the narrow layout is the one it was', () => {
    const { container } = render(PageHeader, { props: { title: 'Plan the week' } });
    const root = container.querySelector('.cinder-page-header');
    expect(root?.hasAttribute('data-cinder-narrow-actions')).toBe(false);
    const ownRow = render(PageHeader, { props: { title: 'Plan', narrowActions: 'own-row' } });
    expect(
      ownRow.container
        .querySelector('.cinder-page-header')
        ?.hasAttribute('data-cinder-narrow-actions'),
    ).toBe(false);
  });

  test('beside-status marks the header, and its layout is scoped to that mark inside the narrow query', () => {
    const { container } = render(PageHeader, {
      props: { title: 'Plan the week', narrowActions: 'beside-status' },
    });
    expect(
      container.querySelector('.cinder-page-header')?.getAttribute('data-cinder-narrow-actions'),
    ).toBe('beside-status');

    const narrow = stylesheet.slice(
      stylesheet.indexOf('@container cinder-page-header (max-width: 32rem)'),
    );
    const scoped = /\.cinder-page-header\[data-cinder-narrow-actions='beside-status'\]/gu;
    // Every new rule is under the mark, so a header without it keeps today's narrow layout.
    expect(narrow.match(scoped)?.length ?? 0).toBeGreaterThanOrEqual(6);
    expect(stylesheet.slice(0, stylesheet.indexOf('@container cinder-page-header'))).not.toContain(
      'data-cinder-narrow-actions',
    );
    expect(narrow).toMatch(
      /\[data-cinder-narrow-actions='beside-status'\] \.cinder-page-header__row \{[^}]*display: grid;/u,
    );
    expect(narrow).toMatch(
      /\.cinder-page-header__actions:not\(\.cinder-page-header__create-slot\) \{[^}]*grid-column: 2;[^}]*grid-row: 2;/u,
    );
  });

  // COR-2438: in a narrow chat header the More menu sat on the status's line, 30px under the title.
  test('beside-status with a one-line title keeps the actions on the title line and the status under both', () => {
    const { container } = render(PageHeader, {
      props: { title: 'Hello', narrowActions: 'beside-status', titleLines: 1 },
    });
    expect(
      container.querySelector('.cinder-page-header')?.getAttribute('data-cinder-title-lines'),
    ).toBe('1');
    const narrow = stylesheet.slice(
      stylesheet.indexOf('@container cinder-page-header (max-width: 32rem)'),
    );
    const oneLine =
      ".cinder-page-header[data-cinder-narrow-actions='beside-status'][data-cinder-title-lines='1']";
    expect(narrow).toContain(
      `${oneLine}\n      .cinder-page-header__title {\n      grid-column: 1;`,
    );
    expect(narrow).toContain(
      `${oneLine}\n      .cinder-page-header__actions:not(.cinder-page-header__create-slot) {\n      grid-row: 1;`,
    );
    expect(narrow).toContain(
      `${oneLine}\n      .cinder-page-header__status {\n      grid-column: 1 / -1;`,
    );
  });

  test('beside-status with no status puts the actions on the title line, not alone on a second row', () => {
    const { container } = render(PageHeader, {
      props: { title: 'Hello', narrowActions: 'beside-status', overflow: [{ label: 'Archive' }] },
    });
    expect(container.querySelector('.cinder-page-header__status')).toBeNull();
    expect(container.querySelector('.cinder-page-header__actions')).not.toBeNull();

    const narrow = stylesheet.slice(
      stylesheet.indexOf('@container cinder-page-header (max-width: 32rem)'),
    );
    const noStatus =
      "[data-cinder-narrow-actions='beside-status']\n      .cinder-page-header__row:not(:has(.cinder-page-header__status))";
    expect(narrow).toContain(
      `${noStatus}\n      .cinder-page-header__title {\n      grid-column: 1;`,
    );
    expect(narrow).toContain(
      `${noStatus}\n      .cinder-page-header__actions:not(.cinder-page-header__create-slot) {\n      grid-row: 1;`,
    );
    expect(narrow).toContain(
      `${noStatus}\n      .cinder-page-header__description {\n      grid-row: 2;`,
    );
  });
});

describe('PageHeader actionsNote', () => {
  const actions = createRawSnippet(() => ({
    render: () => `<button type="button">Run again</button>`,
    setup: () => {},
  }));

  test('draws the caption under the actions and describes their group with it', () => {
    const { container } = render(PageHeader, {
      props: { title: 'Release notes', actions, actionsNote: 'Run again runs on 1.3.0.' },
    });
    const note = container.querySelector('.cinder-page-header__actions-note');
    expect(note?.textContent?.trim()).toBe('Run again runs on 1.3.0.');
    const group = container.querySelector('.cinder-page-header__actions');
    expect(group?.getAttribute('role')).toBe('group');
    expect(group?.getAttribute('aria-describedby')).toBe(note?.id);
    // A sibling of the actions in the header's row, after them.
    expect(note?.parentElement?.classList.contains('cinder-page-header__row')).toBe(true);
    expect(group?.nextElementSibling).toBe(note);
  });

  test('takes a snippet, and the id a button can point its own aria-describedby at', () => {
    const link = createRawSnippet(() => ({
      render: () => `<a href="/settings/models">Connect a provider</a>`,
      setup: () => {},
    }));
    const { container } = render(PageHeader, {
      props: { title: 'Run', actions, actionsNote: link, actionsNoteId: 'run-again-reason' },
    });
    const note = container.querySelector('#run-again-reason');
    expect(note?.querySelector('a')?.textContent).toBe('Connect a provider');
  });

  test('draws no caption, and no group, without actions or without words', () => {
    const bare = render(PageHeader, {
      props: { title: 'Runs', actionsNote: 'Nothing to explain' },
    });
    expect(bare.container.querySelector('.cinder-page-header__actions-note')).toBeNull();
    bare.unmount();
    const empty = render(PageHeader, { props: { title: 'Runs', actions, actionsNote: '' } });
    expect(empty.container.querySelector('.cinder-page-header__actions-note')).toBeNull();
    expect(
      empty.container.querySelector('.cinder-page-header__actions')?.hasAttribute('role'),
    ).toBe(false);
  });

  test('sits at the inline end under the actions when wide, and starts the line below 640px', () => {
    expect(stylesheet).toMatch(
      /\.cinder-page-header__actions-note \{[^}]*grid-row: 2;[^}]*text-align: end;/,
    );
    const narrow = stylesheet.slice(
      stylesheet.indexOf('@container cinder-page-header (max-width: 40rem)'),
    );
    expect(narrow).toMatch(/\.cinder-page-header__actions-note \{[^}]*text-align: start;/);
  });
});
