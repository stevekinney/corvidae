/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, cleanup, fireEvent, screen } = await import('@testing-library/svelte');
const { default: ChatQuestion } = await import('./chat-question.svelte');

const ENVIRONMENT = {
  type: 'string',
  enum: ['staging', 'production'],
  'x-labels': { staging: 'Staging', production: 'Production' },
  'x-descriptions': {
    staging: 'Deploys to the staging site',
    production: 'Deploys to the live site',
  },
};

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  jest.clearAllTimers();
  jest.useRealTimers();
});

/** Moves the fake clock and lets the effects and promise continuations that follow settle. */
async function elapse(milliseconds: number): Promise<void> {
  jest.advanceTimersByTime(milliseconds);
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
}

async function ask(props: Record<string, unknown> = {}) {
  const submitted: unknown[] = [];
  const holds: boolean[] = [];
  const view = render(ChatQuestion, {
    props: {
      schema: ENVIRONMENT,
      id: 'q',
      undoMilliseconds: 5000,
      onSubmit: (value: unknown) => {
        submitted.push(value);
      },
      onHoldChange: (held: boolean) => holds.push(held),
      ...props,
    },
  });
  await elapse(0);
  return { ...view, submitted, holds };
}

function status(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.chat-question-status');
}

function choice(name: string): HTMLElement {
  return screen.getByRole('radio', { name: new RegExp(`^${name}\\b`) });
}

describe('a one-click answer is held for a short Undo window', () => {
  test('picking shows the choice selected and one inline line, and sends nothing yet', async () => {
    const { container, submitted, holds } = await ask();
    await fireEvent.click(choice('Staging'));
    await elapse(0);

    expect(submitted).toEqual([]);
    expect(holds).toEqual([true]);
    expect(choice('Staging').getAttribute('aria-checked')).toBe('true');
    expect(choice('Production').getAttribute('aria-checked')).toBe('false');
    expect(choice('Production').getAttribute('aria-disabled')).toBe('true');
    expect(status(container)?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Answered Staging Undo (5 s)',
    );
    // What was answered and the Undo are separate elements, never joined by a separator glyph.
    expect(status(container)?.querySelector('.chat-question-status-text')?.textContent).toBe(
      'Answered Staging',
    );
    // One line, and one Undo: the line is the only place the answer can be taken back.
    expect(screen.getAllByRole('button', { name: /Undo/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Undo/ }).getAttribute('data-cinder-variant')).toBe(
      'ghost-accent',
    );
  });

  test('the count runs down and, at the end, the answer is sent once and reads "You answered: Staging"', async () => {
    const { container, submitted, holds } = await ask();
    await fireEvent.click(choice('Staging'));
    await elapse(1000);
    expect(screen.getByRole('button', { name: /Undo/ }).textContent?.trim()).toBe('Undo (4 s)');
    await elapse(3900);
    expect(submitted).toEqual([]);
    await elapse(100);

    expect(submitted).toEqual(['staging']);
    expect(holds).toEqual([true, false]);
    expect(status(container)?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'You answered: Staging',
    );
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
    // Nothing more is sent however long the question stays.
    await elapse(20000);
    expect(submitted).toEqual(['staging']);
  });

  test('Undo opens the question again, sends nothing, and puts focus back on the choice', async () => {
    const { container, submitted, holds } = await ask();
    await fireEvent.click(choice('Production'));
    await elapse(2000);
    await fireEvent.click(screen.getByRole('button', { name: /Undo/ }));
    await elapse(0);

    expect(status(container)).toBeNull();
    expect(holds).toEqual([true, false]);
    expect(choice('Production').getAttribute('aria-checked')).toBe('false');
    expect(document.activeElement).toBe(choice('Production'));
    await elapse(10000);
    expect(submitted).toEqual([]);

    // It can be answered again, with a fresh count once focus is out of the question.
    await fireEvent.click(choice('Production'));
    await fireEvent.focusOut(document.activeElement ?? document.body, {
      relatedTarget: document.body,
    });
    await elapse(5000);
    expect(submitted).toEqual(['production']);
  });

  test('the count waits while focus is inside the question and goes on when it leaves', async () => {
    const { container, submitted } = await ask();
    const staging = choice('Staging');
    await fireEvent.click(staging);
    await fireEvent.focusIn(staging);
    await elapse(30000);
    expect(submitted).toEqual([]);
    expect(screen.getByRole('button', { name: /Undo/ }).textContent?.trim()).toBe('Undo (5 s)');

    await fireEvent.focusOut(staging, { relatedTarget: document.body });
    await elapse(5000);
    expect(submitted).toEqual(['staging']);
    expect(status(container)?.textContent).toContain('You answered: Staging');
  });

  test('a native focusout with no related target resumes when the question remains connected', async () => {
    const { submitted } = await ask();
    const staging = choice('Staging');
    await fireEvent.click(staging);
    await fireEvent.focusIn(staging);
    await elapse(30000);
    expect(submitted).toEqual([]);

    await fireEvent.focusOut(staging);
    await elapse(5000);
    expect(submitted).toEqual(['staging']);
  });

  test('moving focus from a choice to Undo keeps the count paused', async () => {
    const { submitted } = await ask();
    const staging = choice('Staging');
    await fireEvent.click(staging);
    await fireEvent.focusIn(staging);
    const undo = screen.getByRole('button', { name: /Undo/ });
    await fireEvent.focusOut(staging, { relatedTarget: undo });
    await fireEvent.focusIn(undo);
    await elapse(30000);
    expect(submitted).toEqual([]);
  });

  test('the count waits while the pointer is inside the question', async () => {
    const { container, submitted } = await ask();
    await fireEvent.click(choice('Staging'));
    const question = container.querySelector('.chat-question');
    if (question === null) throw new Error('The question did not render.');
    await fireEvent.pointerEnter(question);
    await elapse(30000);
    expect(submitted).toEqual([]);
    await fireEvent.pointerLeave(question);
    await elapse(5000);
    expect(submitted).toEqual(['staging']);
  });

  test('a polite live region says the answer once, not on every tick', async () => {
    const { container } = await ask();
    const region = container.querySelector('[aria-live="polite"]');
    expect(region?.textContent).toBe('');
    await fireEvent.click(choice('Staging'));
    await elapse(1);
    expect(region?.textContent).toBe('Answered Staging. Undo available for 5 seconds.');
    // The visible line is not itself a live region, so its count never re-announces.
    const line = status(container);
    expect(line?.closest('[aria-live]')).toBeNull();
    expect(line?.hasAttribute('aria-live')).toBe(false);
    expect(line?.getAttribute('role')).toBeNull();
  });

  test('a question that goes away with the answer held sends it at once', async () => {
    const { unmount, submitted } = await ask();
    const production = choice('Production');
    await fireEvent.click(production);
    await fireEvent.focusIn(production);
    await elapse(1000);
    unmount();
    expect(submitted).toEqual(['production']);
    await elapse(10000);
    expect(submitted).toEqual(['production']);
  });

  test('a question that goes away after Undo sends nothing', async () => {
    const { unmount, submitted } = await ask();
    await fireEvent.click(choice('Production'));
    await fireEvent.click(screen.getByRole('button', { name: /Undo/ }));
    unmount();
    await elapse(10000);
    expect(submitted).toEqual([]);
  });

  test('a host that refuses the answer gets the question back open, with the reason', async () => {
    const { container } = await ask({ onSubmit: () => Promise.resolve(false) });
    await fireEvent.click(choice('Staging'));
    await elapse(5000);

    expect(status(container)).toBeNull();
    expect(screen.getByText('The answer could not be sent. Try again.')).toBeTruthy();
    expect(choice('Staging').getAttribute('aria-checked')).toBe('false');
  });

  test('a host that rejects the answer gets the question back open too', async () => {
    await ask({ onSubmit: () => Promise.reject(new Error('offline')) });
    await fireEvent.click(choice('Staging'));
    await elapse(5000);
    expect(screen.getByText('The answer could not be sent. Try again.')).toBeTruthy();
  });

  test('a yes or no is held the same way', async () => {
    const { submitted, container } = await ask({ schema: { type: 'boolean' } });
    await fireEvent.click(screen.getByRole('radio', { name: /^Yes\b/ }));
    expect(status(container)?.textContent).toContain('Answered Yes');
    await elapse(5000);
    expect(submitted).toEqual([true]);
  });

  test('an answer typed in the own-answer field is sent as it is, not held', async () => {
    const { submitted, holds } = await ask({
      schema: {
        anyOf: [{ enum: ['staging', 'production'] }, { type: 'string', maxLength: 40 }],
        'x-allowOther': true,
      },
    });
    await fireEvent.input(
      screen.getByPlaceholderText('Choose an answer above, or type your own…'),
      {
        target: { value: 'canary' },
      },
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    await elapse(0);
    expect(submitted).toEqual(['canary']);
    expect(holds).toEqual([]);
  });

  test('a host can say it its own way, and add what happens next', async () => {
    const { container } = await ask({
      holdCopy: {
        held: (label: string) => `Answer sent: ${label}.`,
        undo: () => 'Undo',
        note: 'Request human input continues once a provider is connected.',
      },
    });
    await fireEvent.click(choice('Production'));
    expect(status(container)?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Answer sent: Production. Request human input continues once a provider is connected. Undo',
    );
    // The sentence comes first and Undo ends the line, as an accent text action (ChatPage k).
    expect(status(container)?.lastElementChild).toBe(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByRole('button', { name: 'Undo' }).getAttribute('data-cinder-variant')).toBe(
      'ghost-accent',
    );
  });

  test('without an undo window a pick is sent as it is made, as it always was', async () => {
    const { submitted, holds, container } = await ask({ undoMilliseconds: 0 });
    await fireEvent.click(choice('Staging'));
    expect(submitted).toEqual(['staging']);
    expect(holds).toEqual([]);
    expect(status(container)).toBeNull();
  });

  test('a host that sends the answer itself and reports a failure gets the question back open', async () => {
    const view = await ask({ busy: false });
    await fireEvent.click(choice('Production'));
    await elapse(5000);
    // The host starts sending, then fails.
    await view.rerender({ busy: true });
    await elapse(0);
    expect(status(view.container)?.textContent).toContain('You answered: Production');
    await view.rerender({ busy: false, failed: true });
    await elapse(0);

    expect(status(view.container)).toBeNull();
    expect(screen.getByText('The answer could not be sent. Try again.')).toBeTruthy();
    expect(choice('Production').getAttribute('aria-checked')).toBe('false');
  });

  test('a host that sends the answer itself and succeeds leaves it answered', async () => {
    const view = await ask({ busy: false });
    await fireEvent.click(choice('Production'));
    await elapse(5000);
    await view.rerender({ busy: true });
    await view.rerender({ busy: false });
    await elapse(0);
    expect(status(view.container)?.textContent).toContain('You answered: Production');
  });

  test('a host can mark the chosen choice "Selected" in place of its description', async () => {
    const { container } = await ask({ holdCopy: { selected: 'Selected' } });
    await fireEvent.click(choice('Production'));

    const chosen = choice('Production');
    const other = choice('Staging');
    expect(chosen.textContent?.replace(/\s+/g, ' ').trim()).toBe('Production Selected');
    expect(other.textContent?.trim()).toBe('Staging');
    expect(container.textContent).not.toContain('Deploys to the live site');
  });
});
