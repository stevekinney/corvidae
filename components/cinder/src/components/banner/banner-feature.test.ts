/**
 * COR-2363: the feature banner is an announcement, not a status. It is a labelled region with no
 * live region, draws an indigo wash with a glow and no border, sets its glyph art in a 48px accent
 * disc with an 8px halo, and moves its actions under the words below 560px of its own width.
 * happy-dom does not compute styles from stylesheets, so the CSS is pinned against the source, as
 * `banner-layout.test.ts` does.
 */

import { requiredInstance } from '@lostgradient/testing';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { createRawSnippet } from 'svelte';

import { declarationsFor } from '../../test/css.ts';
import Banner from './banner.svelte';

const css = await Bun.file(new URL('./banner.css', import.meta.url)).text();

function textSnippet(text: string) {
  return createRawSnippet(() => ({
    render: () => `<span>${text}</span>`,
    setup: () => {},
  }));
}

const art = createRawSnippet(() => ({
  render: () => '<svg data-testid="feature-art"></svg>',
  setup: () => {},
}));

const actions = createRawSnippet(() => ({
  render: () => '<span><button type="button">Start a plan</button></span>',
  setup: () => {},
}));

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('Banner feature variant', () => {
  test('is a region named by its title, with no status, alert or live region', () => {
    const { container } = render(Banner, {
      props: {
        variant: 'feature',
        title: 'Plan a night out',
        children: textSnippet('Pick three bars and share one link.'),
      },
    });
    const root = requiredInstance(container.querySelector('.cinder-banner'), HTMLElement);
    expect(root.getAttribute('role')).toBe('region');
    expect(root.getAttribute('data-cinder-variant')).toBe('feature');
    const labelledBy = root.getAttribute('aria-labelledby');
    expect(labelledBy).not.toBeNull();
    expect(root.hasAttribute('aria-label')).toBe(false);
    const title = requiredInstance(container.querySelector('.cinder-banner__title'), HTMLElement);
    expect(title.id).toBe(labelledBy ?? '');
    expect(title.textContent).toBe('Plan a night out');
    expect(
      container.querySelector('[role="status"], [role="alert"], [aria-live], [aria-atomic]'),
    ).toBeNull();
  });

  test('is named "Announcement" when it has no title', () => {
    const { container } = render(Banner, {
      props: { variant: 'feature', children: textSnippet('Something new is here.') },
    });
    const root = container.querySelector('.cinder-banner');
    expect(root?.getAttribute('aria-label')).toBe('Announcement');
    expect(root?.hasAttribute('aria-labelledby')).toBe(false);
  });

  test('a page’s own aria-label wins over the title', () => {
    const { container } = render(Banner, {
      props: {
        variant: 'feature',
        title: 'Plan a night out',
        'aria-label': 'New: group plans',
        children: textSnippet('Pick three bars.'),
      },
    });
    const root = container.querySelector('.cinder-banner');
    expect(root?.getAttribute('aria-label')).toBe('New: group plans');
    expect(root?.hasAttribute('aria-labelledby')).toBe(false);
  });

  test('draws no status surface', () => {
    const { container } = render(Banner, {
      props: { variant: 'feature', title: 'New', children: textSnippet('Try it.') },
    });
    const root = requiredInstance(container.querySelector('.cinder-banner'), HTMLElement);
    expect(root.classList.contains('cinder-_status-surface')).toBe(false);
    expect(root.classList.contains('cinder-_status-surface-border')).toBe(false);
  });

  test('renders its art in a decorative disc, in place of the leading icon', () => {
    const { container } = render(Banner, {
      props: { variant: 'feature', title: 'New', art, children: textSnippet('Try it.') },
    });
    const disc = requiredInstance(container.querySelector('.cinder-banner__art'), HTMLElement);
    expect(disc.getAttribute('aria-hidden')).toBe('true');
    expect(disc.querySelector('[data-testid="feature-art"]')).not.toBeNull();
    expect(container.querySelector('.cinder-banner__icon')).toBeNull();
  });

  test('ignores art on a status variant', () => {
    const { container } = render(Banner, {
      props: { variant: 'info', art, children: textSnippet('Heads up.') },
    });
    expect(container.querySelector('.cinder-banner__art')).toBeNull();
  });

  test('renders trailing actions and dismisses through the existing props', async () => {
    let dismissed = 0;
    const { container } = render(Banner, {
      props: {
        variant: 'feature',
        title: 'New',
        actions,
        onDismiss: () => {
          dismissed += 1;
        },
        children: textSnippet('Try it.'),
      },
    });
    expect(container.querySelector('.cinder-banner__actions button')?.textContent).toBe(
      'Start a plan',
    );
    const dismiss = requiredInstance(
      container.querySelector('.cinder-banner__dismiss'),
      HTMLButtonElement,
    );
    await fireEvent.click(dismiss);
    expect(dismissed).toBe(1);
    expect(container.querySelector('.cinder-banner')).toBeNull();
  });

  test('has no dismiss button when dismissible is false', () => {
    const { container } = render(Banner, {
      props: {
        variant: 'feature',
        title: 'New',
        dismissible: false,
        children: textSnippet('Try it.'),
      },
    });
    expect(container.querySelector('.cinder-banner__dismiss')).toBeNull();
  });
});

describe('Banner feature styles', () => {
  const root = declarationsFor(css, ".cinder-banner[data-cinder-variant='feature']");

  test('is a rounded block with no border and an indigo wash with a glow at the inline end', () => {
    expect(root.get('border')).toBe('0');
    expect(root.get('border-radius')).toBe('var(--cinder-radius-surface)');
    const background = root.get('background') ?? '';
    expect(background).toContain('radial-gradient(');
    expect(background).toContain('at var(--_cinder-banner-glow-at)');
    expect(background).toContain(
      'color-mix(in oklch, var(--cinder-surface), var(--cinder-accent-solid) 9%)',
    );
    expect(background).not.toContain('--cinder-status-');
    expect(root.get('--_cinder-banner-glow-at')).toBe('100% 50%');
    expect(
      declarationsFor(css, ".cinder-banner[data-cinder-variant='feature']:dir(rtl)").get(
        '--_cinder-banner-glow-at',
      ),
    ).toBe('0% 50%');
  });

  test('sets its art in a 48px accent disc with an 8px translucent halo', () => {
    const disc = declarationsFor(css, '.cinder-banner__art');
    expect(disc.get('inline-size')).toBe('3rem');
    expect(disc.get('block-size')).toBe('3rem');
    expect(disc.get('border-radius')).toBe('var(--cinder-radius-full)');
    expect(disc.get('background')).toBe('var(--cinder-accent-solid)');
    expect(disc.get('box-shadow')).toContain('0 0 0 var(--cinder-space-2)');
    expect(disc.get('box-shadow')).toContain('transparent');
  });

  test('draws a 16px bold title over muted words', () => {
    const title = declarationsFor(
      css,
      ".cinder-banner[data-cinder-variant='feature'] .cinder-banner__title",
    );
    expect(title.get('font-size')).toBe('var(--cinder-text-lg)');
    expect(title.get('font-weight')).toBe('var(--cinder-font-bold)');
    expect(
      declarationsFor(
        css,
        ".cinder-banner[data-cinder-variant='feature'] > .cinder-banner__content",
      ).get('color'),
    ).toBe('var(--cinder-text-muted)');
  });

  test('trails its actions and drops them below 560px through the layout every banner shares', () => {
    // The container, the trailing track and the narrow rule live on `.cinder-banner` itself
    // (`banner-layout.test.ts`); the feature variant adds no actions layout of its own.
    expect(root.get('container-type')).toBeUndefined();
    expect(declarationsFor(css, '.cinder-banner').get('container-name')).toBe('cinder-banner');
    expect(css).toMatch(
      /@container cinder-banner \(max-width: 34\.99rem\)\s*\{\s*\.cinder-banner > \.cinder-banner__actions\s*\{[^}]*grid-column: 2;[^}]*grid-row: 2;/,
    );
  });

  test('a button label never wraps', () => {
    for (const control of ['button', 'a']) {
      expect(declarationsFor(css, `.cinder-banner__actions ${control}`).get('white-space')).toBe(
        'nowrap',
      );
    }
  });
});
