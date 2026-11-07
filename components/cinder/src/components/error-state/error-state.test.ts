/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import { declarationsFor } from '../../test/css.ts';

// setupHappyDom() MUST run before any `@testing-library/svelte` import. testing-library
// reads `globalThis.document` / `window` at module-init, so register happy-dom's globals first.
setupHappyDom();

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { default: ErrorState } = await import('./error-state.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('ErrorState rendering', () => {
  test('renders the title as a level-2 heading by default', () => {
    const { container } = render(ErrorState, {
      props: { title: 'Could not load runs', description: 'The server did not respond.' },
    });
    const heading = container.querySelector('.cinder-error-state-title');
    expect(heading?.tagName).toBe('H2');
    expect(heading?.textContent?.trim()).toBe('Could not load runs');
  });

  test('renders the description', () => {
    const { container } = render(ErrorState, {
      props: { title: 'Failed', description: 'The server did not respond.' },
    });
    expect(container.querySelector('.cinder-error-state-description')?.textContent?.trim()).toBe(
      'The server did not respond.',
    );
  });

  test('renders the detail behind a disclosure only when provided', () => {
    const withDetail = render(ErrorState, {
      props: { title: 'Failed', description: 'Nope.', detail: 'ECONNRESET' },
    });
    expect(withDetail.container.querySelector('.cinder-error-state-detail')?.textContent).toContain(
      'ECONNRESET',
    );
    const details = withDetail.container.querySelector('details.cinder-error-state-details');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);
    expect(details?.querySelector('summary')?.textContent?.trim()).toBe('Show the error details');
    cleanup();

    const withoutDetail = render(ErrorState, { props: { title: 'Failed', description: 'Nope.' } });
    expect(withoutDetail.container.querySelector('.cinder-error-state-detail')).toBeNull();
  });

  test('headingLevel overrides the title tag', () => {
    const { container } = render(ErrorState, {
      props: { title: 'Failed', description: 'Nope.', headingLevel: 4 },
    });
    expect(container.querySelector('.cinder-error-state-title')?.tagName).toBe('H4');
  });

  test('clamps an out-of-range headingLevel back to a valid tag', () => {
    const { container } = render(ErrorState, {
      props: { title: 'Failed', description: 'Nope.', headingLevel: 9 as never },
    });
    expect(container.querySelector('.cinder-error-state-title')?.tagName).toBe('H6');
  });

  test('merges the class prop onto the root and forwards native attributes', () => {
    const { container } = render(ErrorState, {
      props: {
        title: 'Failed',
        description: 'Nope.',
        class: 'extra',
        'data-testid': 'error-state-root',
      },
    });
    const root = container.querySelector('.cinder-error-state');
    expect(root?.classList.contains('extra')).toBe(true);
    expect(root?.getAttribute('data-testid')).toBe('error-state-root');
  });
});

describe('ErrorState alert semantics', () => {
  test('announces a failure as exactly one role="alert" named by its title', () => {
    const { container } = render(ErrorState, {
      props: { title: 'Failed', description: 'Nope.', onRetry: () => {} },
    });
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.getAttribute('aria-labelledby')).toBe(
      container.querySelector('.cinder-error-state-title')?.id ?? null,
    );
    expect(container.querySelector('.cinder-alert')).toBeNull();
  });

  test('keeps a single role="alert" without a retry button', () => {
    const { container } = render(ErrorState, { props: { title: 'Failed', description: 'Nope.' } });
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });
});

describe('ErrorState retry', () => {
  test('renders no button without onRetry', () => {
    const { container } = render(ErrorState, { props: { title: 'Failed', description: 'Nope.' } });
    expect(container.querySelector('button')).toBeNull();
  });

  test('renders a "Try again" button that calls onRetry', async () => {
    const onRetry = mock(() => {});
    const { getByRole } = render(ErrorState, {
      props: { title: 'Failed', description: 'Nope.', onRetry },
    });
    const button = getByRole('button', { name: 'Try again' });
    await fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('retryLabel overrides the button text', () => {
    const { getByRole } = render(ErrorState, {
      props: {
        title: 'Failed',
        description: 'Nope.',
        onRetry: () => {},
        retryLabel: 'Reload runs',
      },
    });
    expect(getByRole('button', { name: 'Reload runs' })).not.toBeNull();
  });
});

test('no console errors on render', () => {
  const originalError = console.error;
  const errors: unknown[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    render(ErrorState, {
      props: { title: 'Failed', description: 'Nope.', detail: 'E1', onRetry: () => {} },
    });
    expect(errors).toHaveLength(0);
  } finally {
    console.error = originalError;
  }
});

describe('ErrorState variant', () => {
  test('the default variant is the centred page layout with a 48px red disc and a warning glyph', async () => {
    const { container } = render(ErrorState, { props: { title: 'Failed', description: 'Nope.' } });
    const root = container.querySelector('.cinder-error-state');
    expect(root?.hasAttribute('data-cinder-variant')).toBe(false);
    expect(root?.getAttribute('data-cinder-tone')).toBe('danger');
    const disc = root?.querySelector('.cinder-error-state-icon');
    expect(disc?.getAttribute('aria-hidden')).toBe('true');
    expect(disc?.querySelector('svg')).not.toBeNull();

    const css = await Bun.file(new URL('./error-state.css', import.meta.url)).text();
    const rule = declarationsFor(css, '.cinder-error-state-icon');
    expect(rule.get('inline-size')).toBe('var(--cinder-space-12)');
    expect(rule.get('block-size')).toBe('var(--cinder-space-12)');
    expect(rule.get('background')).toBe('var(--cinder-status-danger-background)');
    expect(rule.get('color')).toBe('var(--cinder-status-danger-text)');
    const centred = declarationsFor(css, '.cinder-error-state');
    expect(centred.get('align-items')).toBe('center');
    expect(centred.get('justify-content')).toBe('center');
    // It fills the height left under the header, as the empty state does, so it centres there.
    expect(centred.get('min-block-size')).toBe('100%');
  });

  test('the title is 16px semibold and the sentence holds a 380px measure', async () => {
    const css = await Bun.file(new URL('./error-state.css', import.meta.url)).text();
    const title = declarationsFor(css, '.cinder-error-state-title');
    expect(title.get('font-size')).toBe('var(--cinder-text-lg)');
    expect(title.get('font-weight')).toBe('var(--cinder-font-semibold)');
    expect(declarationsFor(css, '.cinder-error-state-description').get('max-inline-size')).toBe(
      '23.75rem',
    );
  });

  test('flat renders no disc and keeps the error announced as a labelled alert', () => {
    const { container, getByRole } = render(ErrorState, {
      props: {
        title: 'Could not load runs',
        description: 'Nope.',
        detail: 'E1',
        variant: 'flat',
        onRetry: () => {},
      },
    });
    const root = container.querySelector('.cinder-error-state');
    expect(root?.getAttribute('data-cinder-variant')).toBe('flat');
    expect(root?.querySelector('.cinder-error-state-icon')).toBeNull();
    const alert = getByRole('alert');
    expect(alert.getAttribute('aria-labelledby')).toBe(
      container.querySelector('.cinder-error-state-title')?.id ?? null,
    );
    expect(alert.textContent).toContain('Nope.');
    expect(alert.textContent).toContain('E1');
    expect(getByRole('button', { name: 'Try again' })).not.toBeNull();
  });

  test('flat declares no padding of its own and aligns to the inline start', async () => {
    const css = await Bun.file(new URL('./error-state.css', import.meta.url)).text();
    const flat = declarationsFor(css, ".cinder-error-state[data-cinder-variant='flat']");
    expect(flat.get('padding')).toBe('0');
    expect(flat.get('align-items')).toBe('flex-start');
    expect(flat.get('min-block-size')).toBe('0');
  });
});

describe('ErrorState actions', () => {
  test('the retry button is the primary action and carries a refresh glyph', () => {
    const { getByRole } = render(ErrorState, {
      props: { title: 'Failed', description: 'Nope.', onRetry: () => {} },
    });
    const button = getByRole('button', { name: 'Try again' });
    expect(button.getAttribute('data-cinder-variant')).toBe('primary');
    expect(button.querySelector('svg')).not.toBeNull();
  });

  test('a secondaryAction snippet renders after the retry button in the same row', async () => {
    const { default: SecondaryActionFixture } =
      await import('../../test/fixtures/error-state-secondary-action-fixture.svelte');
    const { container, getAllByRole } = render(SecondaryActionFixture);
    const buttons = getAllByRole('button');
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'Retry now',
      'Open Health',
    ]);
    const row = container.querySelector('.cinder-error-state-action');
    expect(buttons.every((button) => row?.contains(button))).toBe(true);
    expect(buttons[1]?.getAttribute('data-cinder-variant')).toBe('secondary');
  });

  test('retryIcon replaces the refresh glyph on the primary button', async () => {
    const { default: RetryIconFixture } =
      await import('../../test/fixtures/error-state-retry-icon-fixture.svelte');
    const { getAllByRole, getByTestId } = render(RetryIconFixture);
    const [primary, secondary] = getAllByRole('button');
    expect(primary?.textContent?.trim()).toBe('New chat');
    expect(primary?.getAttribute('data-cinder-variant')).toBe('primary');
    expect(primary?.contains(getByTestId('pencil'))).toBe(true);
    expect(primary?.querySelectorAll('svg').length).toBe(1);
    expect(secondary?.textContent?.trim()).toBe('Back to chats');
    expect(secondary?.getAttribute('data-cinder-variant')).toBe('secondary');
  });

  test('a secondaryAction renders without a retry button', async () => {
    const { default: SecondaryActionFixture } =
      await import('../../test/fixtures/error-state-secondary-action-fixture.svelte');
    const { getAllByRole } = render(SecondaryActionFixture, { props: { withRetry: false } });
    expect(getAllByRole('button').map((button) => button.textContent?.trim())).toEqual([
      'Open Health',
    ]);
  });
});

describe('ErrorState retry status', () => {
  test('renders the progress line under the description and out of any live region', () => {
    const { container } = render(ErrorState, {
      props: {
        title: 'Couldn’t load runs',
        description: 'Interborough didn’t answer.',
        retryStatus: 'Retrying in 8 s (attempt 3 of 8)',
      },
    });
    const status = container.querySelector('.cinder-error-state-status');
    expect(status?.textContent).toBe('Retrying in 8 s (attempt 3 of 8)');
    expect(status?.getAttribute('aria-live')).toBe('off');
    expect(
      status?.previousElementSibling?.classList.contains('cinder-error-state-description'),
    ).toBe(true);
  });

  test('renders no progress line without retryStatus', () => {
    const { container } = render(ErrorState, { props: { title: 'Failed', description: 'Nope.' } });
    expect(container.querySelector('.cinder-error-state-status')).toBeNull();
  });
});

describe('ErrorState details disclosure', () => {
  test('detailsLabel overrides the disclosure text and the disclosure opens by activation', async () => {
    const { container, getByText } = render(ErrorState, {
      props: { title: 'Failed', description: 'Nope.', detail: 'HTTP 500', detailsLabel: 'Details' },
    });
    const summary = getByText('Details');
    expect(summary.tagName).toBe('SUMMARY');
    const details = container.querySelector('details');
    expect(details?.hasAttribute('open')).toBe(false);
    details!.open = true;
    expect(container.querySelector('.cinder-error-state-detail')?.textContent).toBe('HTTP 500');
  });
});

describe('ErrorState neutral tone', () => {
  test('is a plain group with a neutral disc and a search glyph, not an alert', async () => {
    const { container, getByRole } = render(ErrorState, {
      props: {
        title: 'This run doesn’t exist',
        description: 'It may have been deleted.',
        tone: 'neutral',
      },
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    const group = getByRole('group');
    expect(group.getAttribute('aria-labelledby')).toBe(
      container.querySelector('.cinder-error-state-title')?.id ?? null,
    );
    expect(container.querySelector('.cinder-error-state')?.getAttribute('data-cinder-tone')).toBe(
      'neutral',
    );
    expect(container.querySelector('.cinder-error-state-icon svg')).not.toBeNull();

    const css = await Bun.file(new URL('./error-state.css', import.meta.url)).text();
    const neutral = declarationsFor(
      css,
      ".cinder-error-state[data-cinder-tone='neutral'] .cinder-error-state-icon",
    );
    expect(neutral.get('background')).toBe('var(--cinder-surface-inset)');
  });

  test('an unknown tone behaves as a failure and stays announced', () => {
    const { container } = render(ErrorState, {
      props: { title: 'Failed', description: 'Nope.', tone: 'bogus' as never },
    });
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });
});

describe('ErrorState bordered', () => {
  test('is off by default and marks the centred root when on', async () => {
    const { container } = render(ErrorState, { props: { title: 'Failed', description: 'Nope.' } });
    expect(
      container.querySelector('.cinder-error-state')?.hasAttribute('data-cinder-bordered'),
    ).toBe(false);
    cleanup();
    const bordered = render(ErrorState, {
      props: { title: 'Failed', description: 'Nope.', bordered: true },
    });
    expect(
      bordered.container.querySelector('.cinder-error-state')?.hasAttribute('data-cinder-bordered'),
    ).toBe(true);
    const css = await Bun.file(new URL('./error-state.css', import.meta.url)).text();
    const rule = declarationsFor(css, '.cinder-error-state[data-cinder-bordered]');
    expect(rule.get('border')).toBe('1px solid var(--cinder-border)');
    expect(rule.get('border-radius')).toBe('var(--cinder-radius-lg)');
    expect(rule.get('padding-inline')).toBe('var(--cinder-space-8)');
  });

  test('draws no box on the flat variant, which sits inside a container of its own', () => {
    const { container } = render(ErrorState, {
      props: { title: 'Failed', description: 'Nope.', bordered: true, variant: 'flat' },
    });
    expect(
      container.querySelector('.cinder-error-state')?.hasAttribute('data-cinder-bordered'),
    ).toBe(false);
  });
});

describe('ErrorState retryVariant', () => {
  test('is primary by default, the page’s one primary action', () => {
    const { getByRole } = render(ErrorState, {
      props: { title: 'Failed', description: 'Nope.', onRetry: () => {} },
    });
    expect(getByRole('button', { name: 'Try again' }).getAttribute('data-cinder-variant')).toBe(
      'primary',
    );
  });

  test('is secondary when a section of a page asks for it, and still calls onRetry', async () => {
    const onRetry = mock(() => {});
    const { getByRole } = render(ErrorState, {
      props: {
        title: 'Failed',
        description: 'Nope.',
        onRetry,
        retryVariant: 'secondary',
      },
    });
    const button = getByRole('button', { name: 'Try again' });
    expect(button.getAttribute('data-cinder-variant')).toBe('secondary');
    await fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('ErrorState retry glyph', () => {
  test('is the 14px refresh glyph, the size of the glyph in every button, not the 24px icon default', () => {
    const { getByRole } = render(ErrorState, {
      props: { title: 'Failed', description: 'Nope.', onRetry: () => {} },
    });
    const glyph = getByRole('button', { name: 'Try again' }).querySelector('svg');
    expect(glyph?.getAttribute('width')).toBe('14');
    expect(glyph?.getAttribute('height')).toBe('14');
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
  });
});
