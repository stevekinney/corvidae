/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';

import { declarationsFor } from '@lostgradient/component-tooling/test/css.ts';
import { setupHappyDom } from '@lostgradient/testing';

// setupHappyDom() MUST run before any `@testing-library/svelte` import. testing-library
// reads `globalThis.document` / `window` at module-init (top-level, not inside test bodies),
// so we register happy-dom's globals first and then dynamic-import testing-library below.
setupHappyDom();

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { createRawSnippet } = await import('svelte');
const { default: EmptyState } = await import('./empty-state.svelte');

const emptyStateCss = await Bun.file(new URL('./empty-state.css', import.meta.url)).text();

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('EmptyState rendering', () => {
  test('renders with required title prop', () => {
    const { container } = render(EmptyState, { props: { title: 'No results' } });
    expect(container.querySelector('.cinder-empty-state')).not.toBeNull();
  });

  test('shows title text', () => {
    const { container } = render(EmptyState, { props: { title: 'Nothing here yet' } });
    const heading = container.querySelector('.cinder-empty-state-title');
    expect(heading?.textContent?.trim()).toBe('Nothing here yet');
  });

  test('shows description when provided', () => {
    const { container } = render(EmptyState, {
      props: { title: 'Empty', description: 'Try adding some items.' },
    });
    const description = container.querySelector('.cinder-empty-state-description');
    expect(description).not.toBeNull();
    expect(description?.textContent?.trim()).toBe('Try adding some items.');
  });

  test('does not render description element when description is omitted', () => {
    const { container } = render(EmptyState, { props: { title: 'Empty' } });
    expect(container.querySelector('.cinder-empty-state-description')).toBeNull();
  });

  test('shows icon snippet content when provided', () => {
    const iconSnippet = createRawSnippet(() => ({
      render: () => `<svg data-testid="icon-svg" aria-hidden="true"></svg>`,
    }));

    const { container } = render(EmptyState, {
      props: { title: 'No data', icon: iconSnippet },
    });

    const iconContainer = container.querySelector('.cinder-empty-state-icon');
    expect(iconContainer).not.toBeNull();
    expect(iconContainer?.querySelector('[data-testid="icon-svg"]')).not.toBeNull();
  });

  test('shows action snippet content when provided', () => {
    const actionSnippet = createRawSnippet(() => ({
      render: () => `<button>Add item</button>`,
    }));

    const { container } = render(EmptyState, {
      props: { title: 'Empty', action: actionSnippet },
    });

    const actionContainer = container.querySelector('.cinder-empty-state-action');
    expect(actionContainer).not.toBeNull();
    expect(actionContainer?.querySelector('button')?.textContent).toBe('Add item');
  });

  test('defaults the title to an h3', () => {
    const { container } = render(EmptyState, { props: { title: 'Default level' } });
    const heading = container.querySelector('.cinder-empty-state-title');
    expect(heading?.tagName).toBe('H3');
  });

  test('headingLevel overrides the title tag', () => {
    const { container } = render(EmptyState, {
      props: { title: 'Custom level', headingLevel: 2 },
    });
    const heading = container.querySelector('.cinder-empty-state-title');
    expect(heading?.tagName).toBe('H2');
    expect(heading?.textContent?.trim()).toBe('Custom level');
  });

  test('clamps an out-of-range headingLevel back to a valid tag', () => {
    const { container } = render(EmptyState, {
      // 7 is outside the union but reachable at runtime; should clamp to h6.
      props: { title: 'Clamped', headingLevel: 7 as never },
    });
    expect(container.querySelector('.cinder-empty-state-title')?.tagName).toBe('H6');
  });

  test('clamps headingLevel=0 up to h1', () => {
    const { container } = render(EmptyState, {
      props: { title: 'Clamped', headingLevel: 0 as never },
    });
    expect(container.querySelector('.cinder-empty-state-title')?.tagName).toBe('H1');
  });

  test('falls back to h3 for a non-numeric headingLevel', () => {
    const { container } = render(EmptyState, {
      props: { title: 'Clamped', headingLevel: NaN as never },
    });
    expect(container.querySelector('.cinder-empty-state-title')?.tagName).toBe('H3');
  });

  test('applies class prop to root element', () => {
    const { container } = render(EmptyState, {
      props: { title: 'Empty', class: 'my-custom-class' },
    });
    const root = container.querySelector('.cinder-empty-state');
    expect(root?.classList.contains('my-custom-class')).toBe(true);
    expect(root?.classList.contains('cinder-empty-state')).toBe(true);
  });

  test('no console errors on basic render', () => {
    const originalError = console.error;
    const errors: unknown[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      render(EmptyState, { props: { title: 'Clean render' } });
      expect(errors).toHaveLength(0);
    } finally {
      console.error = originalError;
    }
  });

  test('icon uses muted text rather than disabled text', () => {
    const iconRule = emptyStateCss.match(/\.cinder-empty-state-icon\s*\{[^}]*\}/)?.[0];

    expect(iconRule).toContain('color: var(--cinder-text-muted);');
    expect(iconRule).not.toContain('var(--cinder-text-disabled)');
  });
});

describe('EmptyState native attribute passthrough', () => {
  test('forwards id to the root div', () => {
    const { container } = render(EmptyState, {
      props: { title: 'Empty', id: 'my-empty-state' },
    });
    const root = container.querySelector('.cinder-empty-state');
    expect(root?.getAttribute('id')).toBe('my-empty-state');
  });

  test('forwards data-* attributes to the root div', () => {
    const { container } = render(EmptyState, {
      props: { title: 'Empty', 'data-testid': 'empty-state-fixture' },
    });
    const root = container.querySelector('.cinder-empty-state');
    expect(root?.getAttribute('data-testid')).toBe('empty-state-fixture');
  });

  test('forwards aria-describedby to the root div', () => {
    const { container } = render(EmptyState, {
      props: { title: 'Empty', 'aria-describedby': 'desc-id' },
    });
    const root = container.querySelector('.cinder-empty-state');
    expect(root?.getAttribute('aria-describedby')).toBe('desc-id');
  });

  test('consumer class is merged with cinder-empty-state, not replaced', () => {
    const { container } = render(EmptyState, {
      props: { title: 'Empty', class: 'extra-class', 'data-testid': 'passthrough-class' },
    });
    const root = container.querySelector('.cinder-empty-state');
    expect(root?.classList.contains('cinder-empty-state')).toBe(true);
    expect(root?.classList.contains('extra-class')).toBe(true);
  });
});

test('spaces the stack with the container gap and logical margins only', async () => {
  const css = await Bun.file(new URL('./empty-state.css', import.meta.url)).text();
  const root = declarationsFor(css, '.cinder-empty-state');
  expect(root.get('gap')).toBe('var(--cinder-space-1)');
  expect(css).not.toContain('margin-bottom:');
  expect(css).not.toContain('margin-top:');
});

test('sets its own sans face so a monospace parent never reaches the title', () => {
  expect(declarationsFor(emptyStateCss, '.cinder-empty-state').get('font-family')).toBe(
    'var(--cinder-font-sans)',
  );
});

test('breaks a long unbroken name inside the title and the sentence instead of overflowing', () => {
  expect(declarationsFor(emptyStateCss, '.cinder-empty-state-title').get('overflow-wrap')).toBe(
    'anywhere',
  );
  expect(
    declarationsFor(emptyStateCss, '.cinder-empty-state-description').get('overflow-wrap'),
  ).toBe('anywhere');
});

describe('EmptyState has one layout (owner report, 2026-11-19)', () => {
  test('the root carries no layout, size, alignment or border variant, whatever a caller passes', () => {
    const { container } = render(EmptyState, {
      props: {
        title: 'Empty',
        // A caller that still passes an old variant prop gets the one layout regardless.
        ...({ layout: 'row', size: 'compact', align: 'start', bordered: true } as object),
      },
    });
    const root = container.querySelector('.cinder-empty-state');
    for (const attribute of [
      'data-cinder-layout',
      'data-cinder-size',
      'data-cinder-align',
      'data-cinder-bordered',
    ]) {
      expect(root?.hasAttribute(attribute)).toBe(false);
    }
  });

  test('the stylesheet has no variant rule for a caller to reach', () => {
    expect(emptyStateCss).not.toMatch(/data-cinder-(layout|size|align|bordered)/);
  });

  test('is stacked and centred across, top-aligned at one offset, never boxed', () => {
    const base = declarationsFor(emptyStateCss, '.cinder-empty-state');
    expect(base.get('flex-direction')).toBe('column');
    expect(base.get('align-items')).toBe('center');
    expect(base.get('text-align')).toBe('center');
    expect(base.get('justify-content')).toBe('flex-start');
    expect(base.get('min-block-size')).toBe('0');
    expect(base.get('padding-block')).toBe('var(--cinder-space-12)');
    expect(base.has('border')).toBe(false);
    expect(base.has('background')).toBe(false);
  });

  test('holds the title, the sentence and the details to a measure of about 60 characters', () => {
    for (const part of ['title', 'description', 'details']) {
      const words = declarationsFor(emptyStateCss, `.cinder-empty-state-${part}`);
      expect(words.get('max-inline-size')).toBe('60ch');
    }
  });
});

const actionSnippet = createRawSnippet(() => ({
  render: () => `<button data-testid="custom-action">Add item</button>`,
}));

function rootOf(container: HTMLElement) {
  return container.querySelector('.cinder-empty-state');
}

describe('EmptyState kind', () => {
  test('defaults to first-use and renders the action snippet', () => {
    const { container } = render(EmptyState, { props: { title: 'Empty', action: actionSnippet } });
    expect(rootOf(container)?.getAttribute('data-cinder-kind')).toBe('first-use');
    expect(container.querySelector('[data-testid="custom-action"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Clear filters');
  });

  test('first-use ignores onClearFilters', () => {
    const { container } = render(EmptyState, {
      props: { title: 'Empty', onClearFilters: () => {} },
    });
    expect(container.querySelector('.cinder-empty-state-action')).toBeNull();
  });

  test('filtered renders a Clear filters button that calls onClearFilters', async () => {
    const onClearFilters = mock(() => {});
    const { container, getByRole } = render(EmptyState, {
      props: { title: 'No matches', kind: 'filtered', onClearFilters },
    });
    expect(rootOf(container)?.getAttribute('data-cinder-kind')).toBe('filtered');
    await fireEvent.click(getByRole('button', { name: 'Clear filters' }));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  test('filtered renders no action region without onClearFilters or an action snippet', () => {
    const { container } = render(EmptyState, { props: { title: 'No matches', kind: 'filtered' } });
    expect(container.querySelector('.cinder-empty-state-action')).toBeNull();
  });

  test('filtered puts Clear filters before a custom action and honours clearFiltersLabel', () => {
    const { container } = render(EmptyState, {
      props: {
        title: 'No matches',
        kind: 'filtered',
        onClearFilters: () => {},
        clearFiltersLabel: 'Reset',
        action: actionSnippet,
      },
    });
    const buttons = [...container.querySelectorAll('.cinder-empty-state-action button')];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Reset', 'Add item']);
  });

  test('done renders its action, so a quiet link can follow the confirmation', () => {
    const linkAction = createRawSnippet(() => ({
      render: () => `<a class="cinder-link" href="/reviews/done">See past decisions</a>`,
    }));
    const { container, getByRole } = render(EmptyState, {
      props: { title: 'All caught up', kind: 'done', action: linkAction },
    });
    expect(rootOf(container)?.getAttribute('data-cinder-kind')).toBe('done');
    expect(getByRole('link', { name: 'See past decisions' })).not.toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  test('done ignores onClearFilters, which belongs to the filtered kind', () => {
    const { container } = render(EmptyState, {
      props: { title: 'All done', kind: 'done', onClearFilters: () => {} },
    });
    expect(container.querySelector('.cinder-empty-state-action')).toBeNull();
  });

  test('blocked, not-found and disabled mark the root and render their action', () => {
    for (const kind of ['blocked', 'not-found', 'disabled'] as const) {
      const { container } = render(EmptyState, {
        props: { title: 'Nope', kind, action: actionSnippet },
      });
      expect(rootOf(container)?.getAttribute('data-cinder-kind')).toBe(kind);
      expect(container.querySelector('[data-testid="custom-action"]')).not.toBeNull();
      cleanup();
    }
  });

  test('an unknown kind falls back to first-use', () => {
    const { container } = render(EmptyState, {
      props: { title: 'Empty', kind: 'bogus' as never, action: actionSnippet },
    });
    expect(rootOf(container)?.getAttribute('data-cinder-kind')).toBe('first-use');
    expect(container.querySelector('[data-testid="custom-action"]')).not.toBeNull();
  });

  test('each kind tints the icon disc in the stylesheet', () => {
    const firstUse = declarationsFor(
      emptyStateCss,
      ".cinder-empty-state[data-cinder-kind='first-use'] .cinder-empty-state-icon",
    );
    const done = declarationsFor(
      emptyStateCss,
      ".cinder-empty-state[data-cinder-kind='done'] .cinder-empty-state-icon",
    );
    expect(firstUse.get('background')).toBe('var(--cinder-accent-background)');
    expect(done.get('background')).toBe('var(--cinder-status-success-background)');
    expect(done.get('color')).toBe('var(--cinder-status-success-text)');
    const blocked = declarationsFor(
      emptyStateCss,
      ".cinder-empty-state[data-cinder-kind='blocked'] .cinder-empty-state-icon",
    );
    expect(blocked.get('background')).toBe('var(--cinder-status-warning-background)');
    expect(blocked.get('color')).toBe('var(--cinder-status-warning-text)');
    const disc = declarationsFor(emptyStateCss, '.cinder-empty-state-icon');
    expect(disc.get('border-radius')).toBe('var(--cinder-radius-full)');
  });

  test('neutral kinds keep the neutral disc, which is the base rule', () => {
    const disc = declarationsFor(emptyStateCss, '.cinder-empty-state-icon');
    expect(disc.get('background')).toBe('var(--cinder-surface-inset)');
    for (const kind of ['filtered', 'not-found', 'disabled']) {
      expect(emptyStateCss).not.toContain(`data-cinder-kind='${kind}'`);
    }
  });
});

describe('EmptyState default glyphs', () => {
  const glyphKinds = ['done', 'filtered', 'not-found', 'blocked', 'disabled'] as const;

  test('every kind except first-use shows a glyph in its disc when no icon is passed', () => {
    for (const kind of glyphKinds) {
      const { container } = render(EmptyState, { props: { title: 'State', kind } });
      const disc = container.querySelector('.cinder-empty-state-icon');
      expect(disc, kind).not.toBeNull();
      expect(disc?.getAttribute('aria-hidden')).toBe('true');
      expect(disc?.querySelector('svg'), kind).not.toBeNull();
      cleanup();
    }
  });

  test('first-use draws no disc until the view passes its own icon', () => {
    const { container } = render(EmptyState, { props: { title: 'No agents yet' } });
    expect(container.querySelector('.cinder-empty-state-icon')).toBeNull();
  });

  test('the glyphs are distinct per kind', () => {
    const markup = new Set<string>();
    for (const kind of glyphKinds) {
      const { container } = render(EmptyState, { props: { title: 'State', kind } });
      markup.add(container.querySelector('.cinder-empty-state-icon svg')?.innerHTML ?? '');
      cleanup();
    }
    expect(markup.size).toBe(glyphKinds.length);
  });

  test('a passed icon replaces the default glyph', () => {
    const own = createRawSnippet(() => ({
      render: () => `<svg data-testid="own-glyph" viewBox="0 0 24 24"></svg>`,
    }));
    const { container } = render(EmptyState, {
      props: { title: 'No matches', kind: 'filtered', icon: own },
    });
    expect(container.querySelectorAll('.cinder-empty-state-icon svg')).toHaveLength(1);
    expect(container.querySelector('[data-testid="own-glyph"]')).not.toBeNull();
  });
});

describe('EmptyState parts', () => {
  test('keeps its parts in reading order: disc, title, description, action', () => {
    const action = createRawSnippet(() => ({
      render: () => '<button type="button">Open Reviews</button>',
    }));
    const { container } = render(EmptyState, {
      props: {
        title: 'Nothing is waiting',
        description: 'Approvals show up here.',
        kind: 'done',
        action,
      },
    });
    const order = [...(rootOf(container)?.children ?? [])].map((child) => child.className);
    expect(order).toEqual([
      'cinder-empty-state-icon',
      'cinder-empty-state-title',
      'cinder-empty-state-description',
      'cinder-empty-state-action',
    ]);
  });

  test('draws the Clear filters button at the one button size', () => {
    const { getByRole } = render(EmptyState, {
      props: { title: 'No matches', kind: 'filtered', onClearFilters: () => {} },
    });
    expect(
      getByRole('button', { name: 'Clear filters' }).classList.contains('button-size-medium'),
    ).toBe(true);
  });
});

describe('EmptyState actions (one empty state everywhere, owner report 2026-11-19)', () => {
  const plus = createRawSnippet(() => ({ render: () => '<svg data-testid="plus"></svg>' }));

  test('draws its actions as buttons: the first primary, the rest secondary', async () => {
    let pressed = 0;
    const { container, getByRole } = render(EmptyState, {
      props: {
        title: 'No goals yet',
        actions: [
          { label: 'New goal', icon: plus, onclick: () => (pressed += 1) },
          { label: 'Ask an agent', href: '/chats/new' },
        ],
      },
    });
    const buttons = [...container.querySelectorAll('.cinder-empty-state-action > *')];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'New goal',
      'Ask an agent',
    ]);
    expect(buttons.every((button) => button.classList.contains('cinder-button'))).toBe(true);
    expect(buttons[0]?.classList.contains('button-variant-primary')).toBe(true);
    expect(buttons[1]?.classList.contains('button-variant-secondary')).toBe(true);
    expect(buttons[0]?.querySelector('[data-testid="plus"]')).not.toBeNull();
    expect(getByRole('link', { name: 'Ask an agent' }).getAttribute('href')).toBe('/chats/new');
    await fireEvent.click(getByRole('button', { name: 'New goal' }));
    expect(pressed).toBe(1);
  });

  test('an external action opens its address in a new tab', () => {
    const { getByRole } = render(EmptyState, {
      props: {
        title: 'No workers connected',
        actions: [
          { label: 'How to connect a worker', href: 'https://example.com', external: true },
        ],
      },
    });
    const link = getByRole('link', { name: 'How to connect a worker' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.classList.contains('cinder-button')).toBe(true);
  });

  test('an action can choose its variant, and an inert one says why and presses nothing', async () => {
    let pressed = 0;
    const { getByRole, container } = render(EmptyState, {
      props: {
        title: 'No schedules yet',
        actions: [
          {
            label: 'New schedule',
            variant: 'secondary',
            inertReason: 'You can’t create schedules',
            onclick: () => (pressed += 1),
          },
        ],
      },
    });
    const button = getByRole('button', { name: 'New schedule' });
    expect(button.classList.contains('button-variant-secondary')).toBe(true);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    const reason = container.querySelector(`#${button.getAttribute('aria-describedby') ?? ''}`);
    expect(reason?.textContent).toBe('You can’t create schedules');
    await fireEvent.click(button);
    expect(pressed).toBe(0);
  });

  test('puts the actions before the action snippet, and draws details under them', () => {
    const action = createRawSnippet(() => ({ render: () => '<span data-testid="extra"></span>' }));
    const children = createRawSnippet(() => ({ render: () => '<p data-testid="detail"></p>' }));
    const { container } = render(EmptyState, {
      props: {
        title: 'No agents yet',
        actions: [{ label: 'New agent' }],
        action,
        children,
      },
    });
    const parts = [...(container.querySelector('.cinder-empty-state-action')?.children ?? [])];
    expect(
      parts.map((part) => part.textContent?.trim() || part.getAttribute('data-testid')),
    ).toEqual(['New agent', 'extra']);
    expect(
      container.querySelector('.cinder-empty-state-details [data-testid="detail"]'),
    ).not.toBeNull();
  });
});

describe('EmptyState restyle', () => {
  test('disc is 48px, title is 16px semibold, and the actions row is spaced', () => {
    const disc = declarationsFor(emptyStateCss, '.cinder-empty-state-icon');
    expect(disc.get('inline-size')).toBe('var(--cinder-space-12)');
    expect(disc.get('block-size')).toBe('var(--cinder-space-12)');
    const title = declarationsFor(emptyStateCss, '.cinder-empty-state-title');
    expect(title.get('font-size')).toBe('var(--cinder-text-lg)');
    expect(title.get('font-weight')).toBe('var(--cinder-font-semibold)');
    const action = declarationsFor(emptyStateCss, '.cinder-empty-state-action');
    expect(action.get('gap')).toBe('var(--cinder-space-2)');
    expect(action.get('flex-wrap')).toBe('wrap');
    expect(action.get('justify-content')).toBe('flex-end');
    expect(action.get('max-inline-size')).toBe('60ch');
  });

  test('names its group by the title', () => {
    const { container } = render(EmptyState, {
      props: { title: 'No runs yet.', description: 'It will start soon.', headingLevel: 3 },
    });
    const title = container.querySelector('h3');
    expect(rootOf(container)?.getAttribute('aria-labelledby')).toBe(title?.id ?? null);
  });
});

describe('EmptyState illustration slot (COR-2325)', () => {
  const picture = createRawSnippet(() => ({
    render: () => '<svg data-testid="picture" viewBox="0 0 120 80"></svg>',
  }));

  test('draws the picture above the title, hidden from assistive technology, in place of the disc', () => {
    const { container } = render(EmptyState, {
      props: { title: 'No runs yet', kind: 'done', illustration: picture },
    });
    const wrapper = container.querySelector('.cinder-empty-state-illustration');
    expect(wrapper?.getAttribute('aria-hidden')).toBe('true');
    expect(wrapper?.querySelector('[data-testid="picture"]')).not.toBeNull();
    expect(container.querySelector('.cinder-empty-state-icon')).toBeNull();
    const order = [...(rootOf(container)?.children ?? [])].map((child) => child.className);
    expect(order).toEqual(['cinder-empty-state-illustration', 'cinder-empty-state-title']);
  });

  test('draws nothing extra without the slot', () => {
    const { container } = render(EmptyState, { props: { title: 'No runs yet' } });
    expect(container.querySelector('.cinder-empty-state-illustration')).toBeNull();
  });

  test('the stylesheet centres the picture and keeps it inside the region', () => {
    const wrapper = declarationsFor(emptyStateCss, '.cinder-empty-state-illustration');
    expect(wrapper.get('justify-content')).toBe('center');
    expect(wrapper.get('max-inline-size')).toBe('100%');
  });
});

describe('EmptyState details under the action (COR-2415)', () => {
  const button = createRawSnippet(() => ({
    render: () => '<button type="button" data-testid="connect">Connect a provider</button>',
  }));
  const steps = createRawSnippet(() => ({
    render: () =>
      '<div><p data-testid="by-hand">Or set it up by hand:</p><ol><li>One</li></ol></div>',
  }));

  test('draws the children after the action, in a block of their own, so the action stays buttons', () => {
    const { container } = render(EmptyState, {
      props: { title: 'Connect a provider', action: button, children: steps },
    });
    const order = [...(rootOf(container)?.children ?? [])].map((child) => child.className);
    expect(order).toEqual([
      'cinder-empty-state-title',
      'cinder-empty-state-action',
      'cinder-empty-state-details',
    ]);
    const action = container.querySelector('.cinder-empty-state-action');
    const details = container.querySelector('.cinder-empty-state-details');
    expect(action?.querySelector('[data-testid="connect"]')).not.toBeNull();
    expect(action?.querySelector('ol')).toBeNull();
    expect(details?.querySelector('[data-testid="by-hand"]')).not.toBeNull();
    expect(
      action!.compareDocumentPosition(details!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('draws them with no action at all when the state has none, and draws nothing without them', () => {
    const only = render(EmptyState, { props: { title: 'Connect a provider', children: steps } });
    expect(only.container.querySelector('.cinder-empty-state-action')).toBeNull();
    expect(only.container.querySelector('.cinder-empty-state-details')).not.toBeNull();
    cleanup();
    const none = render(EmptyState, { props: { title: 'Connect a provider' } });
    expect(none.container.querySelector('.cinder-empty-state-details')).toBeNull();
  });

  test('the stylesheet puts them under the action at the words’ measure, a step apart, and draws no box', () => {
    const details = declarationsFor(emptyStateCss, '.cinder-empty-state-details');
    expect(details.get('inline-size')).toBe('100%');
    expect(details.get('max-inline-size')).toBe('60ch');
    expect(details.get('margin-block-start')).toBe('var(--cinder-space-4)');
    expect(details.has('border')).toBe(false);
    expect(details.has('background')).toBe(false);
  });
});
