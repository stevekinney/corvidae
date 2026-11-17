/// <reference lib="dom" />
/**
 * COR-2441 design correction: the round controls are drawn compact and reach 44px through Button's
 * hit area; the last card's exit is laid over the empty state so nothing jumps; the exit copy obeys
 * the same reduced-motion guards as every other motion rule in the file.
 */
import { describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { fireEvent, render } = await import('@testing-library/svelte');
const { default: DecisionDeck } = await import('./decision-deck.svelte');

const css = await Bun.file(new URL('./decision-deck.css', import.meta.url)).text();
const buttonCss = await Bun.file(new URL('../button/button.css', import.meta.url)).text();
const readme = await Bun.file(new URL('./README.md', import.meta.url)).text();

const items = [
  { id: 'receipts', title: 'Archive receipts' },
  { id: 'digest', title: 'Label the weekly digest' },
];

describe('DecisionDeck round controls', () => {
  test('reject and accept are drawn at 40px, Later at 32px, with 20px and 16px glyphs', () => {
    expect(css).toMatch(
      /\.cinder-decision-deck__action\.cinder-button\[data-cinder-icon-only\] \{[^}]*inline-size: 2\.5rem;[^}]*block-size: 2\.5rem/,
    );
    expect(css).toMatch(
      /\[data-decision-action='later'\] \{[^}]*inline-size: 2rem;[^}]*block-size: 2rem/,
    );
    expect(css).toMatch(
      /\[data-cinder-icon-only\]\s*\.cinder-button__icon\s*> svg \{[^}]*inline-size: 1\.25rem/,
    );
    expect(css).toMatch(
      /\[data-decision-action='later'\]\s*\.cinder-button__icon\s*> svg \{[^}]*inline-size: 1rem/,
    );
    expect(css).not.toContain('4.25rem');
  });

  test('every control keeps Button hit area, which reaches 44px on a coarse pointer', () => {
    const { container } = render(DecisionDeck, { items });
    for (const name of ['reject', 'later', 'accept']) {
      const button = requiredInstance(
        container.querySelector(`[data-decision-action="${name}"]`),
        HTMLElement,
      );
      expect(button.getAttribute('data-cinder-hit-target'), name).toBe('44');
    }
    // The pseudo-element grows the 40px and 32px faces to the touch minimum, and is Button's own.
    expect(buttonCss).toMatch(
      /@media \(any-pointer: coarse\)\s*\{[\s\S]*?\[data-cinder-hit-target='44'\]::before\s*\{[^}]*inset-block: min\(0px, calc\(\(100% - var\(--cinder-touch-target-min\)\) \/ 2\)\)/,
    );
    // Nothing in the deck overrides the pseudo-element or lowers the touch minimum.
    expect(css).not.toContain('::before');
    expect(css).not.toContain('--cinder-touch-target-min');
  });
});

describe('DecisionDeck last card', () => {
  test('the leaving copy is out of flow over the empty state, which is not pushed down', async () => {
    const { container } = render(DecisionDeck, { items: [items[0]!] });
    await fireEvent.click(
      requiredInstance(container.querySelector('[data-decision-action="accept"]'), HTMLElement),
    );

    const finish = requiredInstance(
      container.querySelector('.cinder-decision-deck__finish'),
      HTMLElement,
    );
    const empty = requiredInstance(
      finish.querySelector('.cinder-decision-deck__empty'),
      HTMLElement,
    );
    const leaving = requiredInstance(
      finish.querySelector('.cinder-decision-deck__leaving'),
      HTMLElement,
    );
    expect(leaving.querySelector('[data-cinder-decision-exit]')).not.toBeNull();
    // The empty state has no in-flow sibling before it, so it sits where it will finally rest.
    expect(empty.previousElementSibling).toBe(leaving);
    expect(
      container.querySelector('.cinder-decision-deck > .cinder-decision-deck__stack'),
    ).toBeNull();
    // The copy is positioned out of flow, so it adds no height above the empty state.
    expect(css).toMatch(/\.cinder-decision-deck__finish \{[^}]*position: relative/);
    expect(css).toMatch(
      /\.cinder-decision-deck__leaving \{[^}]*position: absolute;[^}]*inset-block-start: 0/,
    );
  });

  test('the empty state keeps its place in the document when the copy is removed', async () => {
    const { container } = render(DecisionDeck, { items: [items[0]!] });
    await fireEvent.click(
      requiredInstance(container.querySelector('[data-decision-action="accept"]'), HTMLElement),
    );
    const empty = requiredInstance(
      container.querySelector('.cinder-decision-deck__empty'),
      HTMLElement,
    );
    const parent = empty.parentElement;

    requiredInstance(
      container.querySelector('[data-cinder-decision-exit]'),
      HTMLElement,
    ).dispatchEvent(new Event('animationend', { bubbles: true }));
    await Promise.resolve();

    // The same element, in the same wrapper: it was not re-created or moved.
    expect(container.querySelector('.cinder-decision-deck__empty')).toBe(empty);
    expect(empty.parentElement).toBe(parent);
  });
});

describe('DecisionDeck exit under reduced motion', () => {
  test('the exit copy is hidden under the same guards as the other motion rules', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*:root:not\(\[data-cinder-reduced-motion='false'\]\):not\(\[data-reduced-motion='off'\]\)\s*\.cinder-decision-card\[data-cinder-decision-exit\] \{\s*display: none;/,
    );
    expect(css).toMatch(
      /:root\[data-cinder-reduced-motion='true'\] \.cinder-decision-card\[data-cinder-decision-exit\] \{\s*display: none;/,
    );
  });
});

describe('DecisionDeck custom body note', () => {
  test('the README says the card snippet renders a second time while the copy leaves', () => {
    expect(readme).toContain('rendered a second time');
    expect(readme).toContain('unique ids');
  });
});
