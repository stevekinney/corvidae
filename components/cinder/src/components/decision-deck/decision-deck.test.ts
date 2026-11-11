/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

import type { DecisionDeckDecision } from './decision-deck.types.ts';

setupHappyDom();

const { fireEvent, render } = await import('@testing-library/svelte');
const { createRawSnippet, tick } = await import('svelte');
const { default: DecisionDeck } = await import('./decision-deck.svelte');

const items = [
  { id: 'receipts', title: 'Archive receipts', description: 'Move mail to Receipts.' },
  { id: 'digest', title: 'Label the weekly digest', eyebrow: 'News Weekly' },
  { id: 'invoices', title: 'Star invoices' },
];

function topCard(container: HTMLElement): HTMLElement {
  return requiredInstance(
    container.querySelector('[data-cinder-decision-card][data-depth="0"]'),
    HTMLElement,
  );
}

function topTitle(container: HTMLElement): string | null {
  return topCard(container).querySelector('.cinder-decision-card__title')?.textContent ?? null;
}

function action(container: HTMLElement, name: string): HTMLElement {
  return requiredInstance(container.querySelector(`[data-decision-action="${name}"]`), HTMLElement);
}

function undoText(container: HTMLElement): string | null {
  return container.querySelector('.cinder-decision-deck__undo-text')?.textContent ?? null;
}

function progressText(container: HTMLElement): string | null {
  return container.querySelector('.cinder-decision-deck__progress-text')?.textContent ?? null;
}

function pointer(target: EventTarget, type: string, clientX: number, clientY = 0): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      pointerId: 1,
      pointerType: 'touch',
      clientX,
      clientY,
      bubbles: true,
      cancelable: true,
    }),
  );
}

// A drag: press on the card, move the pointer to each distance, then release.
async function dragCard(card: HTMLElement, distances: number[], release = true): Promise<void> {
  pointer(card, 'pointerdown', 0);
  for (const distance of distances) {
    pointer(window, 'pointermove', distance);
    await tick();
  }
  if (release) {
    pointer(window, 'pointerup', distances.at(-1) ?? 0);
    await tick();
  }
}

describe('DecisionDeck structure', () => {
  test('names the deck, shows the top card, progress and three named buttons', () => {
    const { container, getByRole } = render(DecisionDeck, { items, label: 'Review queue' });

    expect(container.querySelector('section')?.getAttribute('aria-label')).toBe('Review queue');
    expect(getByRole('group', { name: 'Archive receipts' })).toBeTruthy();
    expect(topTitle(container)).toBe('Archive receipts');
    expect(progressText(container)).toBe('1 of 3');
    for (const name of ['Reject', 'Later', 'Accept']) {
      expect(getByRole('button', { name })).toBeTruthy();
    }
    expect(container.querySelector('.cinder-decision-deck__undo')).toBeNull();
  });

  test('reject and accept are the same size and variant, and reject is always rendered', () => {
    const { container } = render(DecisionDeck, { items });
    const reject = action(container, 'reject');
    const accept = action(container, 'accept');

    expect(reject.getAttribute('data-cinder-size')).toBe(accept.getAttribute('data-cinder-size'));
    expect(reject.getAttribute('data-cinder-variant')).toBe(
      accept.getAttribute('data-cinder-variant'),
    );
    expect(reject.getAttribute('data-cinder-icon-only')).toBe('');
    expect(reject.textContent).toContain('Reject');
  });

  test('only the top card is exposed; the cards under it are inert and hidden', () => {
    const { container } = render(DecisionDeck, { items });
    const cards = [...container.querySelectorAll('[data-cinder-decision-card]')];

    expect(cards).toHaveLength(3);
    expect(cards[0]?.getAttribute('aria-hidden')).toBeNull();
    expect(cards[0]?.getAttribute('tabindex')).toBe('0');
    expect(cards[0]?.getAttribute('aria-label')).toBe('Archive receipts');
    for (const hidden of cards.slice(1)) {
      expect(hidden.getAttribute('aria-hidden')).toBe('true');
      expect(hidden.hasAttribute('inert')).toBe(true);
      expect(hidden.hasAttribute('tabindex')).toBe(false);
    }
  });

  test('draws at most three cards of a longer queue', () => {
    const longQueue = Array.from({ length: 6 }, (_, index) => ({
      id: `item-${index}`,
      title: `Item ${index}`,
    }));
    const { container } = render(DecisionDeck, { items: longQueue });

    expect(container.querySelectorAll('[data-cinder-decision-card]')).toHaveLength(3);
    expect(progressText(container)).toBe('1 of 6');
  });

  test('describes the keys on the top card and merges a custom class', () => {
    const { container } = render(DecisionDeck, { items, class: 'extra' });
    const card = topCard(container);
    const hint = container.querySelector(`#${card.getAttribute('aria-describedby')}`);

    expect(hint?.textContent).toContain('right arrow key to accept');
    expect(card.getAttribute('aria-keyshortcuts')).toBe('ArrowRight ArrowLeft ArrowDown');
    expect(container.querySelector('.cinder-decision-deck')?.classList.contains('extra')).toBe(
      true,
    );
  });

  test('a card snippet replaces the built-in body', () => {
    const body = createRawSnippet((item: () => { title: string }) => ({
      render: () => `<span data-custom-body>Custom ${item().title}</span>`,
    }));
    const { container } = render(DecisionDeck, { items, card: body });

    expect(container.querySelector('.cinder-decision-card__title')).toBeNull();
    expect(topCard(container).querySelector('[data-custom-body]')?.textContent).toBe(
      'Custom Archive receipts',
    );
  });
});

describe('DecisionDeck decisions by button', () => {
  for (const [name, outcome, announced] of [
    ['accept', 'accept', 'Accepted: Archive receipts'],
    ['reject', 'reject', 'Rejected: Archive receipts'],
    ['later', 'later', 'Saved for later: Archive receipts'],
  ] as const) {
    test(`the ${name} button decides ${outcome}, advances the stack and shows Undo`, async () => {
      const decisions: DecisionDeckDecision[] = [];
      const { container } = render(DecisionDeck, {
        items,
        onDecision: (decision) => decisions.push(decision),
      });

      await fireEvent.click(action(container, name));

      expect(decisions).toHaveLength(1);
      expect(decisions[0]?.outcome).toBe(outcome);
      expect(decisions[0]?.item.id).toBe('receipts');
      expect(topTitle(container)).toBe('Label the weekly digest');
      expect(progressText(container)).toBe('2 of 3');
      expect(undoText(container)).toBe(announced);
      expect(container.querySelector('[role="status"]')?.textContent?.trim()).toBe(announced);
    });
  }

  test('the progress bar counts decided cards', async () => {
    const { container } = render(DecisionDeck, { items });
    const bar = requiredInstance(container.querySelector('[role="progressbar"]'), HTMLElement);

    expect(bar.getAttribute('aria-valuenow')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('3');
    await fireEvent.click(action(container, 'accept'));
    expect(bar.getAttribute('aria-valuenow')).toBe('1');
  });

  test('a custom label, progress text and decision sentence replace the defaults', async () => {
    const { container, getByRole } = render(DecisionDeck, {
      items,
      acceptLabel: 'Yes',
      rejectLabel: 'No',
      laterLabel: 'Maybe',
      undoLabel: 'Take back',
      progressText: (position: number, total: number) => `Card ${position}/${total}`,
      describeDecision: (decision: DecisionDeckDecision) => `${decision.outcome}!`,
    });

    expect(progressText(container)).toBe('Card 1/3');
    for (const name of ['Yes', 'No', 'Maybe']) expect(getByRole('button', { name })).toBeTruthy();
    await fireEvent.click(action(container, 'accept'));
    expect(undoText(container)).toBe('accept!');
    expect(getByRole('button', { name: 'Take back' })).toBeTruthy();
  });
});

describe('DecisionDeck keyboard', () => {
  for (const [key, outcome] of [
    ['ArrowRight', 'accept'],
    ['ArrowLeft', 'reject'],
    ['ArrowDown', 'later'],
  ] as const) {
    test(`${key} on the focused top card decides ${outcome} and keeps focus on the stack`, async () => {
      const decisions: DecisionDeckDecision[] = [];
      const { container, getByRole } = render(DecisionDeck, {
        items,
        label: 'Review queue',
        onDecision: (decision) => decisions.push(decision),
      });
      const card = topCard(container);
      card.focus();

      await fireEvent.keyDown(card, { key });

      expect(decisions.map((decision) => decision.outcome)).toEqual([outcome]);
      expect(topTitle(container)).toBe('Label the weekly digest');
      expect(document.activeElement).toBe(topCard(container));
      expect(getByRole('group', { name: 'Label the weekly digest' })).toBe(topCard(container));
    });
  }

  test('a modified arrow key, another key, or a key from inside the card decides nothing', async () => {
    const decisions: DecisionDeckDecision[] = [];
    const { container } = render(DecisionDeck, {
      items,
      onDecision: (decision) => decisions.push(decision),
    });
    const card = topCard(container);
    card.focus();

    await fireEvent.keyDown(card, { key: 'ArrowRight', ctrlKey: true });
    await fireEvent.keyDown(card, { key: 'ArrowRight', shiftKey: true });
    await fireEvent.keyDown(card, { key: 'ArrowUp' });
    await fireEvent.keyDown(card, { key: 'Enter' });
    const title = requiredInstance(card.querySelector('.cinder-decision-card__title'), HTMLElement);
    await fireEvent.keyDown(title, { key: 'ArrowRight' });

    expect(decisions).toHaveLength(0);
    expect(topTitle(container)).toBe('Archive receipts');
  });

  test('every decision is reachable without the arrow keys: the buttons are native buttons', () => {
    const { container } = render(DecisionDeck, { items });

    for (const name of ['reject', 'later', 'accept']) {
      const button = action(container, name);
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('type')).toBe('button');
      expect(button.hasAttribute('disabled')).toBe(false);
    }
  });
});

describe('DecisionDeck swipe', () => {
  test('a drag shows the stamp and moves the card while the pointer is down', async () => {
    const { container } = render(DecisionDeck, { items });
    const card = topCard(container);

    await dragCard(card, [20, 55], false);

    expect(card.hasAttribute('data-dragging')).toBe(true);
    expect(card.style.transform).toBe('translateX(55px) rotate(2.75deg)');
    const accept = requiredInstance(card.querySelector('[data-stamp="accept"]'), HTMLElement);
    const reject = requiredInstance(card.querySelector('[data-stamp="reject"]'), HTMLElement);
    expect(accept.style.opacity).toBe('0.5');
    expect(reject.style.opacity).toBe('0');
    expect(accept.getAttribute('aria-hidden')).toBe('true');
    pointer(window, 'pointerup', 55);
  });

  test('a short release springs back and decides nothing', async () => {
    const decisions: DecisionDeckDecision[] = [];
    const { container } = render(DecisionDeck, {
      items,
      onDecision: (decision) => decisions.push(decision),
    });
    const card = topCard(container);

    await dragCard(card, [30, 100]);

    expect(decisions).toHaveLength(0);
    expect(card.hasAttribute('data-dragging')).toBe(false);
    expect(card.style.transform).toBe('');
    expect(topTitle(container)).toBe('Archive receipts');
    expect(container.querySelector('.cinder-decision-deck__undo')).toBeNull();
  });

  test('a release at the threshold to the right accepts', async () => {
    const decisions: DecisionDeckDecision[] = [];
    const { container } = render(DecisionDeck, {
      items,
      onDecision: (decision) => decisions.push(decision),
    });

    await dragCard(topCard(container), [60, 110]);

    expect(decisions.map((decision) => decision.outcome)).toEqual(['accept']);
    expect(topTitle(container)).toBe('Label the weekly digest');
    expect(topCard(container).style.transform).toBe('');
    expect(undoText(container)).toBe('Accepted: Archive receipts');
  });

  test('a release past the threshold to the left rejects', async () => {
    const decisions: DecisionDeckDecision[] = [];
    const { container } = render(DecisionDeck, {
      items,
      onDecision: (decision) => decisions.push(decision),
    });

    await dragCard(topCard(container), [-60, -140]);

    expect(decisions.map((decision) => decision.outcome)).toEqual(['reject']);
    expect(undoText(container)).toBe('Rejected: Archive receipts');
  });

  test('the threshold prop moves the line', async () => {
    const decisions: DecisionDeckDecision[] = [];
    const { container } = render(DecisionDeck, {
      items,
      threshold: 50,
      onDecision: (decision) => decisions.push(decision),
    });

    await dragCard(topCard(container), [30, 60]);

    expect(decisions.map((decision) => decision.outcome)).toEqual(['accept']);
  });

  test('a cancelled pointer springs the card back without deciding', async () => {
    const decisions: DecisionDeckDecision[] = [];
    const { container } = render(DecisionDeck, {
      items,
      onDecision: (decision) => decisions.push(decision),
    });
    const card = topCard(container);

    await dragCard(card, [60, 160], false);
    pointer(window, 'pointercancel', 160);
    await tick();

    expect(decisions).toHaveLength(0);
    expect(card.hasAttribute('data-dragging')).toBe(false);
    expect(card.style.transform).toBe('');
  });

  test('a mostly vertical move is left to the page and never decides', async () => {
    const decisions: DecisionDeckDecision[] = [];
    const { container } = render(DecisionDeck, {
      items,
      onDecision: (decision) => decisions.push(decision),
    });
    const card = topCard(container);

    pointer(card, 'pointerdown', 0, 0);
    pointer(window, 'pointermove', 3, 40);
    pointer(window, 'pointermove', 200, 40);
    pointer(window, 'pointerup', 200, 40);
    await tick();

    expect(decisions).toHaveLength(0);
    expect(card.hasAttribute('data-dragging')).toBe(false);
  });

  test('a press on a control inside the card does not start a drag', async () => {
    const body = createRawSnippet(() => ({
      render: () => '<button type="button" data-inner>Open</button>',
    }));
    const decisions: DecisionDeckDecision[] = [];
    const { container } = render(DecisionDeck, {
      items,
      card: body,
      onDecision: (decision) => decisions.push(decision),
    });
    const inner = requiredInstance(container.querySelector('[data-inner]'), HTMLElement);

    pointer(inner, 'pointerdown', 0);
    pointer(window, 'pointermove', 160);
    pointer(window, 'pointerup', 160);
    await tick();

    expect(decisions).toHaveLength(0);
    expect(topCard(container).hasAttribute('data-dragging')).toBe(false);
  });

  test('a swipe leaves Undo visible, so an accidental swipe is never final', async () => {
    const { container } = render(DecisionDeck, { items });

    await dragCard(topCard(container), [60, 140]);

    expect(action(container, 'undo').textContent).toContain('Undo');
    expect(undoText(container)).toBe('Accepted: Archive receipts');
  });
});

describe('DecisionDeck undo', () => {
  test('restores the exact previous card and reports the undone decision', async () => {
    const undone: DecisionDeckDecision[] = [];
    const { container } = render(DecisionDeck, {
      items,
      onUndo: (decision) => undone.push(decision),
    });

    await fireEvent.click(action(container, 'reject'));
    expect(topTitle(container)).toBe('Label the weekly digest');
    await fireEvent.click(action(container, 'undo'));

    expect(topTitle(container)).toBe('Archive receipts');
    expect(progressText(container)).toBe('1 of 3');
    expect(container.querySelector('.cinder-decision-deck__undo')).toBeNull();
    expect(undone.map((decision) => [decision.item.id, decision.outcome])).toEqual([
      ['receipts', 'reject'],
    ]);
    expect(container.querySelector('[role="status"]')?.textContent?.trim()).toBe(
      'Undo: Archive receipts',
    );
  });

  test('steps back one decision at a time, most recent first', async () => {
    const { container } = render(DecisionDeck, { items });

    await fireEvent.click(action(container, 'accept'));
    await fireEvent.click(action(container, 'reject'));
    expect(topTitle(container)).toBe('Star invoices');
    expect(undoText(container)).toBe('Rejected: Label the weekly digest');

    await fireEvent.click(action(container, 'undo'));
    expect(topTitle(container)).toBe('Label the weekly digest');
    expect(undoText(container)).toBe('Accepted: Archive receipts');

    await fireEvent.click(action(container, 'undo'));
    expect(topTitle(container)).toBe('Archive receipts');
    expect(container.querySelector('.cinder-decision-deck__undo')).toBeNull();
  });

  test('puts focus back on the button that made the decision', async () => {
    const { container } = render(DecisionDeck, { items });
    const reject = action(container, 'reject');
    reject.focus();

    await fireEvent.click(reject);
    expect(document.activeElement).toBe(action(container, 'reject'));

    const undo = action(container, 'undo');
    undo.focus();
    await fireEvent.click(undo);

    expect(document.activeElement).toBe(action(container, 'reject'));
    expect(topTitle(container)).toBe('Archive receipts');
  });

  test('puts focus back on the card after a keyboard decision', async () => {
    const { container } = render(DecisionDeck, { items });
    const card = topCard(container);
    card.focus();

    await fireEvent.keyDown(card, { key: 'ArrowRight' });
    expect(topTitle(container)).toBe('Label the weekly digest');
    expect(document.activeElement).toBe(topCard(container));

    const undo = action(container, 'undo');
    undo.focus();
    await fireEvent.click(undo);

    expect(topTitle(container)).toBe('Archive receipts');
    expect(document.activeElement).toBe(topCard(container));
  });

  test('undoes a swipe and focuses the card even when the swipe did not hold focus', async () => {
    const { container } = render(DecisionDeck, { items });

    await dragCard(topCard(container), [60, 140]);
    const undo = action(container, 'undo');
    undo.focus();
    await fireEvent.click(undo);

    expect(topTitle(container)).toBe('Archive receipts');
    expect(document.activeElement).toBe(topCard(container));
  });
});

describe('DecisionDeck empty state', () => {
  test('shows All caught up after the last decision, with Undo still available', async () => {
    const { container, getByRole } = render(DecisionDeck, { items: items.slice(0, 2) });

    await fireEvent.click(action(container, 'accept'));
    const reject = action(container, 'reject');
    reject.focus();
    await fireEvent.click(reject);

    expect(container.querySelector('[data-cinder-decision-card]')).toBeNull();
    expect(container.querySelector('.cinder-decision-deck__actions')).toBeNull();
    expect(container.querySelector('.cinder-decision-deck__empty-title')?.textContent).toBe(
      'All caught up',
    );
    expect(container.querySelector('.cinder-decision-deck__empty-description')?.textContent).toBe(
      'Nothing is waiting for a decision.',
    );
    expect(progressText(container)).toBe('2 of 2');
    expect(getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(document.activeElement).toBe(container.querySelector('.cinder-decision-deck__empty'));
  });

  test('says how many cards were left for later', async () => {
    const { container } = render(DecisionDeck, { items: items.slice(0, 2) });

    await fireEvent.click(action(container, 'later'));
    await fireEvent.click(action(container, 'accept'));

    expect(container.querySelector('.cinder-decision-deck__empty-description')?.textContent).toBe(
      '1 left for later.',
    );
  });

  test('a custom title and description replace the defaults', () => {
    const { container } = render(DecisionDeck, {
      items: [],
      emptyTitle: 'Queue clear',
      emptyDescription: 'Come back tomorrow.',
    });

    expect(container.querySelector('.cinder-decision-deck__empty-title')?.textContent).toBe(
      'Queue clear',
    );
    expect(container.querySelector('.cinder-decision-deck__empty-description')?.textContent).toBe(
      'Come back tomorrow.',
    );
    expect(container.querySelector('.cinder-decision-deck__progress')).toBeNull();
  });

  test('undoing the last decision brings its card and the buttons back', async () => {
    const { container } = render(DecisionDeck, { items: items.slice(0, 1) });
    const accept = action(container, 'accept');
    accept.focus();

    await fireEvent.click(accept);
    expect(container.querySelector('[data-cinder-decision-card]')).toBeNull();

    const undo = action(container, 'undo');
    undo.focus();
    await fireEvent.click(undo);

    expect(topTitle(container)).toBe('Archive receipts');
    expect(document.activeElement).toBe(action(container, 'accept'));
  });
});

describe('DecisionDeck stylesheet', () => {
  const css = readFileSync(new URL('./decision-deck.css', import.meta.url), 'utf8');

  test('the card only pans vertically, so a horizontal drag is the deck own', () => {
    expect(css).toMatch(/\.cinder-decision-card \{[^}]*touch-action: pan-y/);
  });

  test('the spring is a transition that the drag switches off', () => {
    expect(css).toMatch(/\.cinder-decision-card \{[^}]*transition: transform/);
    expect(css).toMatch(/\.cinder-decision-card\[data-dragging\] \{[^}]*transition: none/);
  });

  test('reduced motion skips the spring', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[^@]*\.cinder-decision-card,[^}]*transition: none/,
    );
    expect(css).toMatch(
      /:root\[data-cinder-reduced-motion='true'\] \.cinder-decision-card,[^}]*transition: none/,
    );
  });

  test('reject and accept share one size and later is smaller', () => {
    expect(css).toMatch(/\[data-cinder-icon-only\] \{[^}]*inline-size: 4\.25rem/);
    expect(css).toMatch(/\[data-decision-action='later'\] \{[^}]*inline-size: 3rem/);
    expect(css).not.toMatch(/\[data-decision-action='(?:accept|reject)'\] \{[^}]*inline-size/);
  });
});
