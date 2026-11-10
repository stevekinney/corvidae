/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';

import Ajv2020 from 'ajv/dist/2020';

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
const { default: pageHeaderSchema } = await import('./page-header.schema.ts');

describe('PageHeader', () => {
  test('schema requires a string title and supports an optional string description', () => {
    const validate = new Ajv2020({ strict: false }).compile(pageHeaderSchema);

    expect(pageHeaderSchema.required).toEqual(['title']);
    expect(pageHeaderSchema.properties).toMatchObject({
      title: { type: 'string' },
      description: { type: 'string' },
      headingLevel: { enum: [1, 2, 3, 4, 5, 6], default: 1 },
      error: { type: 'boolean', default: false },
      statusPlacement: { enum: ['inline', 'below'], default: 'below' },
    });
    expect(pageHeaderSchema.metadata?.unsupportedProps?.map((prop) => prop.name)).toEqual([
      'actions',
      'breadcrumbs',
      'status',
    ]);
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

  test('draws no rule by default; divider opts in, and a flush header never draws one', () => {
    const plain = render(PageHeader, { props: { title: 'Runs' } });
    const header = () => plain.container.querySelector('.cinder-page-header');
    expect(header()?.hasAttribute('data-cinder-divider')).toBe(false);
    cleanup();
    const ruled = render(PageHeader, { props: { title: 'Runs', divider: true } });
    expect(
      ruled.container.querySelector('.cinder-page-header')?.getAttribute('data-cinder-divider'),
    ).toBe('true');
    cleanup();
    const flush = render(PageHeader, { props: { title: 'Runs', divider: true, flush: true } });
    expect(
      flush.container.querySelector('.cinder-page-header')?.hasAttribute('data-cinder-divider'),
    ).toBe(false);
  });

  test('flush marks the header so it draws no padding', () => {
    const { container } = render(PageHeader, { props: { title: 'Allowed models', flush: true } });
    expect(container.querySelector('.cinder-page-header')?.getAttribute('data-cinder-flush')).toBe(
      'true',
    );
    cleanup();
    const plain = render(PageHeader, { props: { title: 'Allowed models' } });
    expect(
      plain.container.querySelector('.cinder-page-header')?.hasAttribute('data-cinder-flush'),
    ).toBe(false);
  });

  test('a header whose only action is the create "+" keeps it on the title row on a phone', () => {
    const { container } = render(PageHeader, {
      props: { title: 'Schedules', createAction: { label: 'New schedule' } },
    });
    expect(
      container
        .querySelector('.cinder-page-header')
        ?.classList.contains('cinder-page-header--create-only'),
    ).toBe(true);
    expect(stylesheet).toMatch(
      /@container cinder-page-header \(max-width: 32rem\)\s*\{\s*\.cinder-page-header--create-only \.cinder-page-header__row\s*\{\s*flex-wrap:\s*nowrap/,
    );
  });

  test('a header with other actions beside the create "+" still drops them to their own row', () => {
    const actions = createRawSnippet(() => ({
      render: () => `<button>Export</button>`,
      setup: () => {},
    }));
    const { container } = render(PageHeader, {
      props: { title: 'Runs', actions, createAction: { label: 'Start run' } },
    });
    expect(
      container
        .querySelector('.cinder-page-header')
        ?.classList.contains('cinder-page-header--create-only'),
    ).toBe(false);
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

    test('keeps the inline status on the first line of a wrapping title', () => {
      expect(stylesheet).toMatch(/__title-line\s*\{[^}]*align-items:\s*flex-start/);
      expect(stylesheet).toMatch(
        /__status\[data-cinder-placement='inline'\]\s*\{[^}]*min-block-size:/,
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

    test('in a narrow container the title takes the row and the actions drop beneath it (W05)', () => {
      expect(stylesheet).toMatch(/\.cinder-page-header\s*\{[^}]*container-type:\s*inline-size/);
      const narrow = stylesheet.slice(stylesheet.indexOf('@container cinder-page-header'));
      expect(narrow).toMatch(/__row\s*\{\s*flex-wrap:\s*wrap/);
      expect(narrow).toMatch(/__heading-group\s*\{\s*flex-basis:\s*100%/);
      expect(narrow).toMatch(/__actions\s*\{[^}]*flex-basis:\s*100%/);
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
