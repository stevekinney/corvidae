/// <reference lib="dom" />
import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRawSnippet } from 'svelte';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, fireEvent, waitFor } = await import('@testing-library/svelte');
const { default: Fixture } = await import('../../test/fixtures/dropdown-compound-fixture.svelte');
const { default: OnclickFixture } =
  await import('../../test/fixtures/dropdown-trigger-onclick-fixture.svelte');
const { default: DropdownTrigger } = await import('./dropdown-trigger.svelte');

describe('DropdownTrigger', () => {
  test('throws when rendered outside a Dropdown', () => {
    expect(() =>
      render(DropdownTrigger, {
        props: {
          children: createRawSnippet(() => ({ render: () => '<span>x</span>', setup: () => {} })),
        },
      }),
    ).toThrow(/missing_context/);
  });

  test('renders a button with aria-haspopup="menu"', () => {
    const { container } = render(Fixture);
    const trigger = container.querySelector('.cinder-dropdown-trigger');
    expect(trigger?.tagName.toLowerCase()).toBe('button');
    expect(trigger?.getAttribute('aria-haspopup')).toBe('menu');
  });

  test('aria-expanded reflects the open state and flips on click', async () => {
    const { container } = render(Fixture);
    const trigger = requiredInstance(
      container.querySelector('.cinder-dropdown-trigger'),
      HTMLElement,
    );
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    await fireEvent.click(trigger);
    await waitFor(() => {
      expect(
        container.querySelector('.cinder-dropdown-trigger')?.getAttribute('aria-expanded'),
      ).toBe('true');
    });
  });

  test('a consumer onclick that calls preventDefault suppresses opening the dropdown', async () => {
    const { container } = render(OnclickFixture, {
      onclick: (event: MouseEvent) => {
        event.preventDefault();
      },
    });
    const trigger = requiredInstance(
      container.querySelector('.cinder-dropdown-trigger'),
      HTMLElement,
    );
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    await fireEvent.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  test('a consumer onclick without preventDefault still opens the dropdown and is invoked', async () => {
    const handleClick = mock((_event: MouseEvent) => {});
    const { container } = render(OnclickFixture, { onclick: handleClick });
    const trigger = requiredInstance(
      container.querySelector('.cinder-dropdown-trigger'),
      HTMLElement,
    );
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    await fireEvent.click(trigger);

    expect(handleClick).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(
        container.querySelector('.cinder-dropdown-trigger')?.getAttribute('aria-expanded'),
      ).toBe('true');
    });
  });

  test('a consumer style prop merges with the anchor-name style instead of clobbering it', () => {
    const { container } = render(Fixture, { props: { triggerStyle: 'margin-top: 4px;' } });
    const trigger = requiredInstance(
      container.querySelector('.cinder-dropdown-trigger'),
      HTMLElement,
    );

    expect(trigger.style.getPropertyValue('margin-top')).toBe('4px');
    expect(trigger.style.getPropertyValue('anchor-name')).toBe('--actions-menu-menu');
  });

  // COR-2489: on the run page at 375 the "More actions" trigger was drawn 44px tall on touch, in a
  // row of 32px buttons. It is drawn at a Button's painted height and reaches 44px through a hit
  // area that takes no layout space.
  test('on a coarse pointer the trigger is drawn compact and its hit area is extended, not drawn 44px', () => {
    const css = readFileSync(new URL('../dropdown/dropdown.css', import.meta.url), 'utf8');
    const coarse = css.slice(css.indexOf('@media (any-pointer: coarse)'));
    const face = /\.cinder-dropdown-trigger:not\(\.cinder-button\) \{([^}]*)\}/.exec(coarse)?.[1];
    expect(face).toContain('min-block-size: var(--_cinder-painted-height-md);');
    expect(face).toContain('position: relative;');
    const hitArea = /\.cinder-dropdown-trigger:not\(\.cinder-button\)::before \{([^}]*)\}/.exec(
      coarse,
    )?.[1];
    expect(hitArea).toContain('position: absolute;');
    expect(hitArea).toContain(
      'inset-block: min(0px, calc((100% - var(--cinder-touch-target-min)) / 2));',
    );
    // The painted height is not the coarse control height, which rises to 44px.
    const foundation = readFileSync(
      new URL('../../styles/foundation.css', import.meta.url),
      'utf8',
    );
    expect(foundation).toContain('--_cinder-painted-height-md: 2rem;');
  });

  // COR-2489 design round: the run header's "More actions" was a 50x32 pill beside 24px buttons.
  // In a header's actions the trigger is drawn as a Button at the row's compact size, and an
  // icon-only trigger is square there and outside a header.
  test('in a header the trigger is a compact Button, and an icon-only trigger is square', async () => {
    const { default: HeaderFixture } =
      await import('../../test/fixtures/dropdown-trigger-header-fixture.svelte');
    const { container } = render(HeaderFixture);
    const inHeader = requiredInstance(container.querySelector('.in-header'), HTMLElement);
    const button = requiredInstance(
      container.querySelector('.cinder-page-header .cinder-button:not(.cinder-dropdown-trigger)'),
      HTMLElement,
    );
    expect(inHeader.classList.contains('cinder-button')).toBe(true);
    expect(inHeader.classList.contains('button-size-extra-small')).toBe(true);
    expect(button.classList.contains('button-size-extra-small')).toBe(true);
    expect(inHeader.hasAttribute('data-cinder-compact')).toBe(true);
    expect(button.hasAttribute('data-cinder-compact')).toBe(true);
    expect(inHeader.classList.contains('button-variant-secondary')).toBe(true);
    expect(inHeader.dataset['cinderHitTarget']).toBe('44');
    expect(inHeader.hasAttribute('data-cinder-icon-only')).toBe(true);

    // Outside a header it keeps its own bordered face, marked icon-only.
    const loose = requiredInstance(container.querySelector('.loose'), HTMLElement);
    expect(loose.classList.contains('cinder-button')).toBe(false);
    expect(loose.hasAttribute('data-cinder-compact')).toBe(false);
    expect(loose.hasAttribute('data-cinder-icon-only')).toBe(true);

    // The Button's icon-only rules square a compact trigger; the trigger's own face is squared
    // in dropdown.css at its height on each pointer.
    const buttonCss = readFileSync(new URL('../button/button.css', import.meta.url), 'utf8');
    expect(buttonCss).toMatch(
      /\.cinder-button\[data-cinder-compact\]\[data-cinder-icon-only\] \{\s*min-width: var\(--_cinder-compact-control-height\);/,
    );
    const css = readFileSync(new URL('../dropdown/dropdown.css', import.meta.url), 'utf8');
    const square =
      /\.cinder-dropdown-trigger:not\(\.cinder-button\)\[data-cinder-icon-only\] \{([^}]*)\}/g;
    const [fine, coarse] = [...css.matchAll(square)].map((match) => match[1] ?? '');
    expect(fine).toContain('aspect-ratio: 1;');
    expect(fine).toContain('padding-inline: 0;');
    expect(fine).toContain('min-inline-size: var(--cinder-button-height-md);');
    expect(coarse).toContain('min-inline-size: var(--_cinder-painted-height-md);');
  });

  test('the internal anchor-name declaration wins when a consumer style redeclares it', () => {
    const { container } = render(Fixture, {
      props: { triggerStyle: 'anchor-name: --consumer-injected;' },
    });
    const trigger = requiredInstance(
      container.querySelector('.cinder-dropdown-trigger'),
      HTMLElement,
    );

    expect(trigger.style.getPropertyValue('anchor-name')).toBe('--actions-menu-menu');
  });
});
