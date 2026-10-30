/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import { declarationsFor } from '../../test/css.ts';

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

  test('icon uses subtle text rather than disabled text', () => {
    const iconRule = emptyStateCss.match(/\.cinder-empty-state-icon\s*\{[^}]*\}/)?.[0];

    expect(iconRule).toContain('color: var(--cinder-text-subtle);');
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

test('uses the container gap as the sole vertical spacing mechanism', async () => {
  const css = await Bun.file(new URL('./empty-state.css', import.meta.url)).text();
  expect(css).toContain('gap: var(--cinder-space-2);');
  expect(css).not.toContain('margin-bottom: var(--cinder-space-2);');
  expect(css).not.toContain('margin-top: var(--cinder-space-4);');
});

describe('EmptyState align', () => {
  test('centres by default and marks no alignment attribute', () => {
    const { container } = render(EmptyState, { props: { title: 'Empty' } });
    expect(container.querySelector('.cinder-empty-state')?.hasAttribute('data-cinder-align')).toBe(
      false,
    );
  });

  test("align='start' marks the root and its rule aligns content to the inline start", () => {
    const { container } = render(EmptyState, { props: { title: 'Empty', align: 'start' } });
    expect(container.querySelector('.cinder-empty-state')?.getAttribute('data-cinder-align')).toBe(
      'start',
    );
    const declarations = declarationsFor(
      emptyStateCss,
      ".cinder-empty-state[data-cinder-align='start']",
    );
    expect(declarations.get('align-items')).toBe('flex-start');
    expect(declarations.get('text-align')).toBe('start');
    const base = declarationsFor(emptyStateCss, '.cinder-empty-state');
    expect(base.get('align-items')).toBe('center');
    expect(base.get('text-align')).toBe('center');
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

  test('done renders no action even when action and onClearFilters are passed', () => {
    const { container } = render(EmptyState, {
      props: { title: 'All done', kind: 'done', action: actionSnippet, onClearFilters: () => {} },
    });
    expect(rootOf(container)?.getAttribute('data-cinder-kind')).toBe('done');
    expect(container.querySelector('.cinder-empty-state-action')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
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
    const disc = declarationsFor(emptyStateCss, '.cinder-empty-state-icon');
    expect(disc.get('border-radius')).toBe('var(--cinder-radius-full)');
  });
});

describe('EmptyState size', () => {
  test('defaults to the default size', () => {
    const { container } = render(EmptyState, { props: { title: 'Empty' } });
    expect(rootOf(container)?.getAttribute('data-cinder-size')).toBe('default');
  });

  test('compact marks the root and shrinks padding, disc, and title in the stylesheet', () => {
    const { container } = render(EmptyState, { props: { title: 'Empty', size: 'compact' } });
    expect(rootOf(container)?.getAttribute('data-cinder-size')).toBe('compact');
    const root = declarationsFor(emptyStateCss, ".cinder-empty-state[data-cinder-size='compact']");
    expect(root.get('padding-block')).toBe('var(--cinder-space-6)');
    const base = declarationsFor(emptyStateCss, '.cinder-empty-state');
    expect(base.get('padding-block')).toBe('var(--cinder-space-12)');
    const title = declarationsFor(
      emptyStateCss,
      ".cinder-empty-state[data-cinder-size='compact'] .cinder-empty-state-title",
    );
    expect(title.get('font-size')).toBe('var(--cinder-text-base)');
  });

  test('compact makes the Clear filters button small', () => {
    const { getByRole } = render(EmptyState, {
      props: { title: 'No matches', kind: 'filtered', size: 'compact', onClearFilters: () => {} },
    });
    expect(getByRole('button', { name: 'Clear filters' }).getAttribute('data-cinder-size')).toBe(
      'sm',
    );
  });

  test('an unknown size falls back to default', () => {
    const { container } = render(EmptyState, { props: { title: 'Empty', size: 'huge' as never } });
    expect(rootOf(container)?.getAttribute('data-cinder-size')).toBe('default');
  });
});

describe('EmptyState restyle', () => {
  test('title is larger and semibold, description has a measure and the actions row is spaced', () => {
    const title = declarationsFor(emptyStateCss, '.cinder-empty-state-title');
    expect(title.get('font-size')).toBe('var(--cinder-text-xl)');
    expect(title.get('font-weight')).toBe('var(--cinder-font-semibold)');
    const description = declarationsFor(emptyStateCss, '.cinder-empty-state-description');
    expect(description.get('max-inline-size')).toBe('42ch');
    const action = declarationsFor(emptyStateCss, '.cinder-empty-state-action');
    expect(action.get('gap')).toBe('var(--cinder-space-3)');
    expect(action.get('flex-wrap')).toBe('wrap');
  });
});
