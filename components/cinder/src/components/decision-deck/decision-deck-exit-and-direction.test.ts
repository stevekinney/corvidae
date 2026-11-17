/// <reference lib="dom" />
/**
 * COR-2441 (from COR-2362): the decided card plays an exit animation, and the arrow keys, the swipe
 * and the exit follow the reading direction, so "accept" is always on the inline-end side.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

import type { DecisionDeckDecision } from './decision-deck.types.ts';

setupHappyDom();

const { fireEvent, render } = await import('@testing-library/svelte');
const { tick } = await import('svelte');
const { default: DecisionDeck } = await import('./decision-deck.svelte');

const items = [
  { id: 'receipts', title: 'Archive receipts' },
  { id: 'digest', title: 'Label the weekly digest' },
  { id: 'invoices', title: 'Star invoices' },
];

const stylesheet = readFileSync(new URL('./decision-deck.css', import.meta.url), 'utf8');

function topCard(container: HTMLElement): HTMLElement {
  return requiredInstance(
    container.querySelector('[data-cinder-decision-card][data-depth="0"]'),
    HTMLElement,
  );
}

function exitCopy(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-cinder-decision-exit]');
}

function action(container: HTMLElement, name: string): HTMLElement {
  return requiredInstance(container.querySelector(`[data-decision-action="${name}"]`), HTMLElement);
}

function pointer(target: EventTarget, type: string, clientX: number): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      pointerId: 1,
      pointerType: 'touch',
      clientX,
      clientY: 0,
      bubbles: true,
      cancelable: true,
    }),
  );
}

async function dragCard(card: HTMLElement, distance: number): Promise<void> {
  pointer(card, 'pointerdown', 0);
  pointer(window, 'pointermove', distance);
  await tick();
  pointer(window, 'pointerup', distance);
  await tick();
}

/** Renders the deck inside an element with this direction, which is where the deck reads it from. */
function renderIn(direction: 'ltr' | 'rtl', onDecision?: (decision: DecisionDeckDecision) => void) {
  const host = document.createElement('div');
  host.setAttribute('dir', direction);
  document.body.append(host);
  return render(DecisionDeck, { props: { items, onDecision }, target: host });
}

describe('DecisionDeck exit animation', () => {
  test('a decided card leaves as a decorative copy that plays the exit animation', async () => {
    const { container } = render(DecisionDeck, { items });

    await fireEvent.click(action(container, 'accept'));

    const copy = exitCopy(container);
    expect(copy).not.toBeNull();
    expect(copy?.getAttribute('data-cinder-decision-exit')).toBe('accept');
    expect(copy?.getAttribute('aria-hidden')).toBe('true');
    expect(copy?.hasAttribute('inert')).toBe(true);
    expect(copy?.textContent).toContain('Archive receipts');
    // The copy is not a card of the deck: the next card is already the top card.
    expect(container.querySelectorAll('[data-cinder-decision-card]')).toHaveLength(2);
    expect(topCard(container).textContent).toContain('Label the weekly digest');
    expect(copy?.style.getPropertyValue('--_cinder-decision-exit-x')).toBe('120%');
  });

  test('accept leaves toward the inline-end side, reject toward the inline-start side, later downward', async () => {
    for (const [name, x, y] of [
      ['accept', '120%', '0%'],
      ['reject', '-120%', '0%'],
      ['later', '0%', '80%'],
    ] as const) {
      const { container, unmount } = render(DecisionDeck, { items });
      await fireEvent.click(action(container, name));
      const copy = exitCopy(container);
      expect(copy?.style.getPropertyValue('--_cinder-decision-exit-x'), name).toBe(x);
      expect(copy?.style.getPropertyValue('--_cinder-decision-exit-y'), name).toBe(y);
      unmount();
    }
  });

  test('a swipe starts the exit from where the card was released', async () => {
    const { container } = render(DecisionDeck, { items });

    await dragCard(topCard(container), 140);

    const copy = exitCopy(container);
    expect(copy?.getAttribute('data-cinder-decision-exit')).toBe('accept');
    expect(copy?.style.getPropertyValue('--_cinder-decision-exit-from')).toBe('140px');
  });

  test('the copy is removed when the animation ends', async () => {
    const { container } = render(DecisionDeck, { items });
    await fireEvent.click(action(container, 'reject'));

    const copy = requiredInstance(exitCopy(container), HTMLElement);
    copy.dispatchEvent(new Event('animationend', { bubbles: true }));
    await tick();

    expect(exitCopy(container)).toBeNull();
  });

  test('the last card also plays its exit beside the all-caught-up state', async () => {
    const { container } = render(DecisionDeck, { items: [items[0]!] });

    await fireEvent.click(action(container, 'accept'));

    expect(exitCopy(container)).not.toBeNull();
    expect(container.querySelector('.cinder-decision-deck__empty')).not.toBeNull();
  });

  test('Undo drops the copy', async () => {
    const { container } = render(DecisionDeck, { items });
    await fireEvent.click(action(container, 'accept'));
    expect(exitCopy(container)).not.toBeNull();

    await fireEvent.click(action(container, 'undo'));

    expect(exitCopy(container)).toBeNull();
  });

  test('the stylesheet animates the copy and draws nothing for a person who asks for less motion', () => {
    expect(stylesheet).toMatch(
      /\.cinder-decision-card\[data-cinder-decision-exit\]\s*\{[^}]*animation: cinder-decision-exit/,
    );
    expect(stylesheet).toContain('@keyframes cinder-decision-exit');
    const reduced = stylesheet.slice(stylesheet.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\[data-cinder-decision-exit\]\s*\{\s*display: none;/);
  });
});

describe('DecisionDeck under right to left', () => {
  test('left to right: the right arrow accepts and the left arrow rejects', async () => {
    const decisions: DecisionDeckDecision[] = [];
    const { container } = renderIn('ltr', (decision) => decisions.push(decision));

    await fireEvent.keyDown(topCard(container), { key: 'ArrowRight' });
    await fireEvent.keyDown(topCard(container), { key: 'ArrowLeft' });

    expect(decisions.map((decision) => decision.outcome)).toEqual(['accept', 'reject']);
  });

  test('right to left: the left arrow accepts and the right arrow rejects', async () => {
    const decisions: DecisionDeckDecision[] = [];
    const { container } = renderIn('rtl', (decision) => decisions.push(decision));

    await fireEvent.keyDown(topCard(container), { key: 'ArrowLeft' });
    await fireEvent.keyDown(topCard(container), { key: 'ArrowRight' });

    expect(decisions.map((decision) => decision.outcome)).toEqual(['accept', 'reject']);
  });

  test('the down arrow is later in both directions', async () => {
    for (const direction of ['ltr', 'rtl'] as const) {
      const decisions: DecisionDeckDecision[] = [];
      const { container, unmount } = renderIn(direction, (decision) => decisions.push(decision));
      await fireEvent.keyDown(topCard(container), { key: 'ArrowDown' });
      expect(
        decisions.map((decision) => decision.outcome),
        direction,
      ).toEqual(['later']);
      unmount();
    }
  });

  test('right to left: a swipe toward the left accepts, and its exit leaves toward the left', async () => {
    const decisions: DecisionDeckDecision[] = [];
    const { container } = renderIn('rtl', (decision) => decisions.push(decision));

    await dragCard(topCard(container), -140);

    expect(decisions.map((decision) => decision.outcome)).toEqual(['accept']);
    expect(exitCopy(container)?.style.getPropertyValue('--_cinder-decision-exit-x')).toBe('-120%');
  });

  test('right to left: a swipe toward the right rejects', async () => {
    const decisions: DecisionDeckDecision[] = [];
    const { container } = renderIn('rtl', (decision) => decisions.push(decision));

    await dragCard(topCard(container), 140);

    expect(decisions.map((decision) => decision.outcome)).toEqual(['reject']);
  });

  test('the default keyboard hint names the arrows of the reading direction', async () => {
    for (const [direction, accept, reject] of [
      ['ltr', 'right', 'left'],
      ['rtl', 'left', 'right'],
    ] as const) {
      const { container, unmount } = renderIn(direction);
      await tick();
      expect(
        container.querySelector('.cinder-decision-deck__sr-only')?.textContent,
        direction,
      ).toBe(
        `Press the ${accept} arrow key to accept, the ${reject} arrow key to reject, or the down arrow key to decide later.`,
      );
      unmount();
    }
  });
});
