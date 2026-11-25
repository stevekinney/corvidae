/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';

import {
  atRuleDeclarationsFor,
  declarationsFor,
} from '@lostgradient/component-tooling/test/css.ts';
import { setupHappyDom } from '@lostgradient/testing';

// setupHappyDom() MUST run before any `@testing-library/svelte` import. testing-library
// reads `globalThis.document` / `window` at module-init, so register happy-dom's globals first.
setupHappyDom();

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { createRawSnippet } = await import('svelte');
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
    const details = withDetail.container.querySelector('.cinder-error-state-details');
    expect(details).not.toBeNull();
    expect(details?.querySelector('.cinder-error-state-detail')?.hasAttribute('hidden')).toBe(true);
    expect(
      withDetail
        .getByRole('button', { name: 'Show the error details' })
        .getAttribute('aria-expanded'),
    ).toBe('false');
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

  test('a narrow row puts the action on a line of its own, by its own width (COR-2394)', async () => {
    const css = await Bun.file(new URL('./error-state.css', import.meta.url)).text();
    const row = declarationsFor(css, ".cinder-error-state[data-cinder-variant='row']");
    expect(row.get('container-type')).toBe('inline-size');
    expect(row.get('container-name')).toBe('cinder-error-state');
    // The row has no padding, so its content box is its width: 28rem keeps the retry at the inline
    // end whenever it has room, and a full-width row on a phone still drops it.
    expect(row.get('padding')).toBe('0');
    expect(css).not.toMatch(/@media[^{]*width/);
    const action = atRuleDeclarationsFor(
      css,
      'container',
      'cinder-error-state (max-width: 28rem)',
      ".cinder-error-state[data-cinder-variant='row'] .cinder-error-state-action",
    );
    expect(action.get('flex-basis')).toBe('100%');
    // Trailing-edge actions everywhere (owner, 2026-11-13): the dropped retry ends the row.
    expect(action.get('justify-content')).toBe('flex-end');
  });
});

describe('ErrorState actions', () => {
  test('the retry button is the primary action and carries a refresh glyph', () => {
    const { getByRole } = render(ErrorState, {
      props: { title: 'Failed', description: 'Nope.', onRetry: () => {} },
    });
    const button = getByRole('button', { name: 'Try again' });
    expect(button.classList.contains('button-variant-primary')).toBe(true);
    expect(button.querySelector('svg')).not.toBeNull();
  });

  test('keeps the secondary action on the left and the primary action on the right in DOM order', async () => {
    const { default: SecondaryActionFixture } =
      await import('../../test/fixtures/error-state-secondary-action-fixture.svelte');
    const { container, getAllByRole } = render(SecondaryActionFixture);
    const buttons = getAllByRole('button');
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'Open Health',
      'Try again',
    ]);
    const row = container.querySelector('.cinder-error-state-action');
    expect(buttons.every((button) => row?.contains(button))).toBe(true);
    expect(buttons[0]?.classList.contains('button-variant-secondary')).toBe(true);
    expect(buttons[1]?.classList.contains('button-variant-primary')).toBe(true);
  });

  test('retryIcon replaces the refresh glyph on the primary button', async () => {
    const { default: RetryIconFixture } =
      await import('../../test/fixtures/error-state-retry-icon-fixture.svelte');
    const { getAllByRole, getByTestId } = render(RetryIconFixture);
    const [secondary, primary] = getAllByRole('button');
    expect(secondary?.textContent?.trim()).toBe('Back to chats');
    expect(secondary?.classList.contains('button-variant-secondary')).toBe(true);
    expect(primary?.textContent?.trim()).toBe('New chat');
    expect(primary?.classList.contains('button-variant-primary')).toBe(true);
    expect(primary?.contains(getByTestId('pencil'))).toBe(true);
    expect(primary?.querySelectorAll('svg').length).toBe(1);
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

describe('ErrorState remediation', () => {
  test('renders the next step as its own line right after the description', () => {
    const { container } = render(ErrorState, {
      props: {
        title: 'Couldn’t load runs',
        description: 'The server answered with an error.',
        remediation: 'Check that the server is running, then try again.',
        retryStatus: 'Retrying in 8 s (attempt 3 of 8)',
      },
    });
    const remediation = container.querySelector('.cinder-error-state-remediation');
    expect(remediation?.tagName).toBe('P');
    expect(remediation?.textContent).toBe('Check that the server is running, then try again.');
    expect(
      remediation?.previousElementSibling?.classList.contains('cinder-error-state-description'),
    ).toBe(true);
    expect(remediation?.nextElementSibling?.classList.contains('cinder-error-state-status')).toBe(
      true,
    );
  });

  test('sits inside the labelled region, so assistive technology reads it with the title', () => {
    const { container } = render(ErrorState, {
      props: { title: 'Failed', description: 'Nope.', remediation: 'Sign in again.' },
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.getAttribute('aria-labelledby')).toBe(
      container.querySelector('.cinder-error-state-title')?.id ?? null,
    );
    expect(alert?.contains(container.querySelector('.cinder-error-state-remediation'))).toBe(true);
  });

  test('follows the description in the row variant and in the flat variant', () => {
    for (const variant of ['row', 'flat'] as const) {
      const { container } = render(ErrorState, {
        props: { title: 'Failed', description: 'Nope.', remediation: 'Sign in again.', variant },
      });
      expect(
        container
          .querySelector('.cinder-error-state-remediation')
          ?.previousElementSibling?.classList.contains('cinder-error-state-description'),
      ).toBe(true);
      cleanup();
    }
  });

  test('renders alongside a retry button, and on its own when onRetry is omitted', () => {
    const withRetry = render(ErrorState, {
      props: {
        title: 'Failed',
        description: 'Nope.',
        remediation: 'Try again.',
        onRetry: () => {},
      },
    });
    expect(withRetry.container.querySelector('.cinder-error-state-remediation')).not.toBeNull();
    expect(withRetry.container.querySelector('button')).not.toBeNull();
    cleanup();

    const withoutRetry = render(ErrorState, {
      props: { title: 'Failed', description: 'Nope.', remediation: 'Ask an owner for access.' },
    });
    expect(withoutRetry.container.querySelector('.cinder-error-state-remediation')).not.toBeNull();
    expect(withoutRetry.container.querySelector('button')).toBeNull();
  });

  test('renders no remediation element without the prop or with an empty one', () => {
    const without = render(ErrorState, { props: { title: 'Failed', description: 'Nope.' } });
    expect(without.container.querySelector('.cinder-error-state-remediation')).toBeNull();
    cleanup();

    const empty = render(ErrorState, {
      props: { title: 'Failed', description: 'Nope.', remediation: '' },
    });
    expect(empty.container.querySelector('.cinder-error-state-remediation')).toBeNull();
  });

  test('a row draws it on its own line under the sentence, not run on inside it', async () => {
    const { container } = render(ErrorState, {
      props: {
        title: 'Couldn’t load system problems.',
        description: 'The rest of Home is live.',
        remediation: 'Check the connection.',
        variant: 'row',
      },
    });
    const text = container.querySelector('.cinder-error-state-text');
    expect(text?.querySelector('.cinder-error-state-remediation')).not.toBeNull();

    const css = await Bun.file(new URL('./error-state.css', import.meta.url)).text();
    const rule = declarationsFor(
      css,
      ".cinder-error-state[data-cinder-variant='row'] .cinder-error-state-remediation",
    );
    expect(rule.get('display')).toBe('block');
    expect(rule.get('margin-block-start')).toBe('var(--cinder-space-1)');
    expect(rule.get('font-size')).toBe('inherit');
  });

  test('takes the description’s type and its colour token', async () => {
    const css = await Bun.file(new URL('./error-state.css', import.meta.url)).text();
    const rule = declarationsFor(css, '.cinder-error-state-remediation');
    expect(rule.get('font-size')).toBe('var(--cinder-text-sm)');
    expect(rule.get('color')).toBe('var(--cinder-text-muted)');
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
  test('uses the shared disclosure trigger for its glyph, focus, and coarse-pointer target', async () => {
    const css = await Bun.file(new URL('./error-state.css', import.meta.url)).text();
    const source = await Bun.file(new URL('./error-state.svelte', import.meta.url)).text();
    const triggerCss = await Bun.file(
      new URL('../disclosure-trigger/disclosure-trigger.css', import.meta.url),
    ).text();
    expect(source).toContain('import DisclosureTrigger');
    expect(source).toContain('class="cinder-error-state-details-summary"');
    expect(css).not.toContain('.cinder-error-state-details-summary::before');
    expect(triggerCss).toMatch(
      /@media \(any-pointer: coarse\)\s*\{\s*\.cinder-disclosure-trigger\s*\{[^}]*min-block-size:\s*var\(--cinder-touch-target-min\)/s,
    );
  });

  test('detailsLabel overrides the disclosure text and the disclosure opens by activation', async () => {
    const { container, getByRole } = render(ErrorState, {
      props: { title: 'Failed', description: 'Nope.', detail: 'HTTP 500', detailsLabel: 'Details' },
    });
    const trigger = getByRole('button', { name: 'Details' });
    const detail = container.querySelector<HTMLElement>('.cinder-error-state-detail');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(detail?.hidden).toBe(true);
    await fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(detail?.hidden).toBe(false);
    expect(detail?.textContent).toBe('HTTP 500');
  });
});

describe('ErrorState warning tone', () => {
  test('is a status with the warning disc and glyph, labelled by its title', async () => {
    const { container, getByRole } = render(ErrorState, {
      props: {
        title: 'Someone else changed this',
        description: 'Your edit was not saved.',
        remediation: 'Read it again, then change it.',
        tone: 'warning',
      },
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    const status = getByRole('status');
    expect(status.getAttribute('aria-labelledby')).toBe(
      container.querySelector('.cinder-error-state-title')?.id ?? null,
    );
    expect(container.querySelector('.cinder-error-state')?.getAttribute('data-cinder-tone')).toBe(
      'warning',
    );
    expect(container.querySelector('.cinder-error-state-icon svg')).not.toBeNull();
    expect(status.querySelector('.cinder-error-state-remediation')?.textContent).toBe(
      'Read it again, then change it.',
    );

    const css = await Bun.file(new URL('./error-state.css', import.meta.url)).text();
    const disc = declarationsFor(
      css,
      ".cinder-error-state[data-cinder-tone='warning'] .cinder-error-state-icon",
    );
    expect(disc.get('background')).toBe('var(--cinder-status-warning-background)');
    expect(disc.get('color')).toBe('var(--cinder-status-warning-text)');
    const glyph = declarationsFor(
      css,
      ".cinder-error-state[data-cinder-tone='warning'] .cinder-error-state-glyph",
    );
    expect(glyph.get('color')).toBe('var(--cinder-status-warning-text)');
  });

  test('announce raises a warning to an alert, and there is still one role', () => {
    const { container, queryByRole } = render(ErrorState, {
      props: { title: 'Conflict', description: 'It changed.', tone: 'warning', announce: true },
    });
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(queryByRole('status')).toBeNull();
  });

  test('the row and flat variants keep the warning tone', () => {
    for (const variant of ['row', 'flat'] as const) {
      const { container } = render(ErrorState, {
        props: { title: 'Conflict', description: 'It changed.', tone: 'warning', variant },
      });
      expect(container.querySelector('.cinder-error-state')?.getAttribute('data-cinder-tone')).toBe(
        'warning',
      );
      cleanup();
    }
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

  test('a bordered neutral row draws its box in the muted border a list row uses, not a status weight', async () => {
    const css = await Bun.file(new URL('./error-state.css', import.meta.url)).text();
    const neutral = declarationsFor(
      css,
      ".cinder-error-state[data-cinder-variant='row'][data-cinder-bordered][data-cinder-tone='neutral']",
    );
    expect(neutral.get('--_cinder-error-state-edge')).toBe('var(--cinder-border-muted)');
  });

  test('measure holds a state to a readable width, and is off by default', async () => {
    const plain = render(ErrorState, {
      props: { title: 'Gone', description: '', variant: 'row', tone: 'neutral' },
    });
    expect(
      plain.container.querySelector('.cinder-error-state')?.hasAttribute('data-cinder-measure'),
    ).toBe(false);
    plain.unmount();

    const measured = render(ErrorState, {
      props: { title: 'Gone', description: '', variant: 'row', tone: 'neutral', measure: true },
    });
    expect(
      measured.container.querySelector('.cinder-error-state')?.hasAttribute('data-cinder-measure'),
    ).toBe(true);
    const css = await Bun.file(new URL('./error-state.css', import.meta.url)).text();
    expect(
      declarationsFor(css, '.cinder-error-state[data-cinder-measure]').get('max-inline-size'),
    ).toBe('70ch');
    // The default state sets no width of its own beyond filling its column.
    expect(declarationsFor(css, '.cinder-error-state').get('max-inline-size')).toBeUndefined();
  });

  test('a row’s glyph sits on the title’s first line, not the middle of its lines', async () => {
    const css = await Bun.file(new URL('./error-state.css', import.meta.url)).text();
    const glyph = declarationsFor(
      css,
      ".cinder-error-state[data-cinder-variant='row'] .cinder-error-state-glyph",
    );
    expect(glyph.get('align-self')).toBe('flex-start');
    expect(glyph.get('margin-block-start')).toContain('1lh');
  });

  test('a row’s glyph and words are one start-aligned group the row centres with its action (COR-2648)', async () => {
    const { container } = render(ErrorState, {
      props: { variant: 'row', title: 'Failed', description: 'Nope.', onRetry: () => {} },
    });
    const lead = container.querySelector('.cinder-error-state-lead');
    expect(lead?.querySelector('.cinder-error-state-glyph')).not.toBeNull();
    expect(lead?.querySelector('.cinder-error-state-title')).not.toBeNull();
    // The action is the group's sibling, not inside it.
    expect(lead?.querySelector('.cinder-error-state-action')).toBeNull();
    expect(
      lead?.parentElement?.querySelector(':scope > .cinder-error-state-action'),
    ).not.toBeNull();

    const css = await Bun.file(new URL('./error-state.css', import.meta.url)).text();
    const group = declarationsFor(css, '.cinder-error-state-lead');
    expect(group.get('display')).toBe('flex');
    expect(group.get('align-items')).toBe('flex-start');
    // The body centres the group and the action on the row's one centre line.
    expect(
      declarationsFor(
        css,
        ".cinder-error-state[data-cinder-variant='row'] .cinder-error-state-body",
      ).get('align-items'),
    ).toBe('center');
  });

  test('a title-only row’s title is its last child and has no trailing margin (COR-2648)', async () => {
    const { container } = render(ErrorState, {
      props: { variant: 'row', title: 'Failed', description: '', onRetry: () => {} },
    });
    const title = container.querySelector('.cinder-error-state-title');
    expect(title?.matches(':last-child')).toBe(true);
    const css = await Bun.file(new URL('./error-state.css', import.meta.url)).text();
    expect(
      declarationsFor(
        css,
        ".cinder-error-state[data-cinder-variant='row'] .cinder-error-state-title:last-child",
      ).get('margin-block-end'),
    ).toBe('0');
  });

  test('announce raises a neutral state to an alert', () => {
    const { container, queryByRole } = render(ErrorState, {
      props: { title: 'Gone', description: 'Deleted.', tone: 'neutral', announce: true },
    });
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(queryByRole('group')).toBeNull();
    expect(container.querySelector('.cinder-error-state')?.getAttribute('data-cinder-tone')).toBe(
      'neutral',
    );
  });

  test('an unknown tone behaves as a failure and stays announced', () => {
    const { container } = render(ErrorState, {
      props: { title: 'Failed', description: 'Nope.', tone: 'bogus' as never },
    });
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });
});

describe('ErrorState row variant', () => {
  test('a row whose title is its whole sentence passes an empty description and draws no empty line', () => {
    const { container } = render(ErrorState, {
      props: { variant: 'row', title: 'Couldn’t load the saved secrets.', description: '' },
    });
    expect(container.querySelector('.cinder-error-state-title')?.textContent?.trim()).toBe(
      'Couldn’t load the saved secrets.',
    );
    expect(container.querySelector('.cinder-error-state-description')).toBeNull();
  });

  test('is a small glyph, the title above its description, and a secondary retry at the end', async () => {
    const onRetry = mock();
    const { container, getByRole } = render(ErrorState, {
      props: {
        variant: 'row',
        title: 'Couldn’t load system problems.',
        description: 'The rest of Home is live.',
        headingLevel: 3,
        onRetry,
      },
    });
    const root = container.querySelector('.cinder-error-state');
    expect(root?.getAttribute('data-cinder-variant')).toBe('row');
    // A failure is still announced as an alert, and the heading names it.
    expect(root?.querySelector('[role="alert"]')).not.toBeNull();
    expect(root?.querySelector('.cinder-error-state-title')?.tagName).toBe('H3');
    // No disc: the glyph is small and decorative.
    expect(root?.querySelector('.cinder-error-state-icon')).toBeNull();
    expect(root?.querySelector('.cinder-error-state-glyph')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    const button = getByRole('button', { name: 'Try again' });
    expect(button.classList.contains('button-variant-secondary')).toBe(true);
    // The retry is a plain word: no refresh glyph unless the caller gives one.
    expect(button.querySelector('svg')).toBeNull();
    await fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);

    const css = await Bun.file(new URL('./error-state.css', import.meta.url)).text();
    // The title is the row's heading, on a line of its own above the description, in the centred
    // page title's semibold weight with a small gap under it: the title and the sentence are one
    // size, so weight and the gap carry the hierarchy (COR-2560: it ran on into the sentence as
    // "Conflict The server…", and at medium weight read as an equal of the line under it).
    expect(css).toMatch(
      /\.cinder-error-state\[data-cinder-variant='row'\] \.cinder-error-state-title,\s*\.cinder-error-state\[data-cinder-variant='row'\] \.cinder-error-state-description \{\s*display: block;/,
    );
    // The row's own title rule (the combined rule above sets the description's normal weight).
    expect(css).toMatch(
      /\.cinder-error-state\[data-cinder-variant='row'\] \.cinder-error-state-title \{\s*margin-block-end: var\(--cinder-space-1\);\s*font-weight: var\(--cinder-font-semibold\);/,
    );
    // The same weight the centred page title uses.
    expect(declarationsFor(css, '.cinder-error-state-title').get('font-weight')).toBe(
      'var(--cinder-font-semibold)',
    );
    // A grouped list row's insets, so the retry ends on the same edge as a list row's button
    // (COR-2329: it ended 8px short).
    const body = declarationsFor(
      css,
      ".cinder-error-state[data-cinder-variant='row'] .cinder-error-state-body",
    );
    expect(body.get('padding-inline')).toBe('var(--cinder-space-4) var(--cinder-space-2)');
  });

  test('an icon given for the retry button is drawn', () => {
    const { getByRole } = render(ErrorState, {
      props: {
        variant: 'row',
        title: 'Failed.',
        description: 'Nope.',
        onRetry: () => undefined,
        retryIcon: createRawSnippet(() => ({ render: () => '<svg data-retry-icon></svg>' })),
      },
    });
    expect(
      getByRole('button', { name: 'Try again' }).querySelector('[data-retry-icon]'),
    ).not.toBeNull();
  });

  test('a neutral row is a plain group with the muted glyph', () => {
    const { container } = render(ErrorState, {
      props: { variant: 'row', tone: 'neutral', title: 'Canceled.', description: 'Try later.' },
    });
    expect(container.querySelector('[role="group"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('compact size', () => {
  test('a compact state keeps the disc and the alert, and its retry is a small secondary button with no glyph', async () => {
    const onRetry = mock(() => undefined);
    const { container, getByRole } = render(ErrorState, {
      props: {
        size: 'compact',
        title: 'Couldn’t load chats',
        description: 'Interborough didn’t send them back.',
        onRetry,
      },
    });
    const root = container.querySelector('.cinder-error-state');
    expect(root?.getAttribute('data-cinder-size')).toBe('compact');
    expect(container.querySelector('.cinder-error-state-icon')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    const button = getByRole('button', { name: 'Try again' });
    expect(button.classList.contains('button-variant-secondary')).toBe(true);
    expect(button.querySelector('svg')).toBeNull();
    await fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('the default size keeps the primary retry, and compact is ignored by the flat and row layouts', () => {
    const plain = render(ErrorState, {
      props: { title: 'Failed.', description: 'Nope.', onRetry: () => undefined },
    });
    expect(
      plain.container.querySelector('.cinder-error-state')?.hasAttribute('data-cinder-size'),
    ).toBe(false);
    expect(
      plain.getByRole('button', { name: 'Try again' }).classList.contains('button-variant-primary'),
    ).toBe(true);
    const flat = render(ErrorState, {
      props: { variant: 'flat', size: 'compact', title: 'Failed.', description: 'Nope.' },
    });
    expect(
      flat.container
        .querySelector('.cinder-error-state[data-cinder-variant="flat"]')
        ?.hasAttribute('data-cinder-size'),
    ).toBe(false);
  });
});

describe('ErrorState secondaryAction', () => {
  const openHealth = () =>
    createRawSnippet(() => ({
      render: () => '<a href="/health" data-open-health>Open Health</a>',
    }));

  test('the default and row variants both draw it, and it stands alone with no retry', () => {
    for (const variant of ['default', 'row'] as const) {
      const alone = render(ErrorState, {
        props: {
          title: 'Failed.',
          description: 'Nope.',
          variant,
          secondaryAction: openHealth(),
        },
      });
      const action = alone.container.querySelector('.cinder-error-state-action');
      expect(action?.querySelector('[data-open-health]'), variant).not.toBeNull();
      expect(alone.queryByRole('button', { name: 'Try again' }), variant).toBeNull();
      cleanup();

      const both = render(ErrorState, {
        props: {
          title: 'Failed.',
          description: 'Nope.',
          variant,
          onRetry: () => {},
          secondaryAction: openHealth(),
        },
      });
      const actions = both.container.querySelector('.cinder-error-state-action');
      const children = [...(actions?.children ?? [])];
      // The secondary action comes first in DOM order, before the retry button.
      expect(children[0]?.hasAttribute('data-open-health'), variant).toBe(true);
      expect(actions?.querySelector('button')?.textContent?.trim(), variant).toBe('Try again');
      cleanup();
    }
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
    expect(rule.get('border')).toBe('var(--cinder-border-width) solid var(--cinder-border)');
    expect(rule.get('border-radius')).toBe('var(--cinder-radius-lg)');
    expect(rule.get('padding-inline')).toBe('var(--cinder-space-8)');
  });

  test('a row draws a quiet hairline in its tone’s border token, not the centred panel', async () => {
    const css = await Bun.file(new URL('./error-state.css', import.meta.url)).text();
    for (const [tone, token] of [
      ['danger', '--cinder-status-danger-border'],
      ['warning', '--cinder-status-warning-border'],
      // Nothing failed, so a neutral row is drawn in the muted hairline list rows use (COR-2534).
      ['neutral', '--cinder-border-muted'],
    ] as const) {
      const { container } = render(ErrorState, {
        props: { title: 'Failed.', description: 'Nope.', variant: 'row', bordered: true, tone },
      });
      const root = container.querySelector('.cinder-error-state');
      expect(root?.hasAttribute('data-cinder-bordered')).toBe(true);
      expect(root?.getAttribute('data-cinder-tone')).toBe(tone);
      const selector =
        tone === 'danger'
          ? ".cinder-error-state[data-cinder-variant='row'][data-cinder-bordered]"
          : `.cinder-error-state[data-cinder-variant='row'][data-cinder-bordered][data-cinder-tone='${tone}']`;
      // The tone's own border token feeds the edge, in a rule for that tone.
      const block = css.slice(css.indexOf(`${selector} {`));
      expect(block.slice(0, block.indexOf('}'))).toContain(`var(${token})`);
      cleanup();
    }
    const rule = declarationsFor(
      css,
      ".cinder-error-state[data-cinder-variant='row'][data-cinder-bordered]",
    );
    expect(rule.get('border-color')).toBe('var(--_cinder-error-state-edge)');
    expect(rule.get('background')).toBe('none');
    expect(rule.get('padding')).toBe('0');
  });

  test('the row hairline is quiet, about 1.5:1 on the page surface in both schemes (COR-2560)', async () => {
    // The status border tokens read 1.9:1 (light) and 4.7:1 (dark) for danger on the page
    // surface, so the hairline mixes each toward transparent per scheme. These shares were
    // computed from the resolved tokens (light 65% and dark 32% for danger, light 65% and dark
    // 43% for warning); a change to them is a change to how loud the row is.
    const css = await Bun.file(new URL('./error-state.css', import.meta.url)).text();
    expect(css).toMatch(
      /light-dark\(\s*color-mix\(in oklch, var\(--cinder-status-danger-border\) 65%, transparent\),\s*color-mix\(in oklch, var\(--cinder-status-danger-border\) 32%, transparent\)\s*\)/,
    );
    expect(css).toMatch(
      /light-dark\(\s*color-mix\(in oklch, var\(--cinder-status-warning-border\) 65%, transparent\),\s*color-mix\(in oklch, var\(--cinder-status-warning-border\) 43%, transparent\)\s*\)/,
    );
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
    expect(
      getByRole('button', { name: 'Try again' }).classList.contains('button-variant-primary'),
    ).toBe(true);
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
    expect(button.classList.contains('button-variant-secondary')).toBe(true);
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
