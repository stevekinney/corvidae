/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

// happy-dom does not implement HTMLDialogElement.showModal / close; stub them so Modal can open.
if (typeof HTMLDialogElement !== 'undefined') {
  if (!HTMLDialogElement.prototype.showModal) {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      value: function () {
        this.setAttribute('open', '');
      },
      configurable: true,
      writable: true,
    });
  }
  if (!HTMLDialogElement.prototype.close) {
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      value: function () {
        this.removeAttribute('open');
      },
      configurable: true,
      writable: true,
    });
  }
}

const { render, fireEvent, cleanup } = await import('@testing-library/svelte');
const { createRawSnippet, tick } = await import('svelte');
const { default: RestartState } = await import('./restart-state.svelte');
const { waitUntil } = await import('@lostgradient/testing/wait-until');

const cssText = await Bun.file(new URL('./restart-state.css', import.meta.url)).text();

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function card(container: HTMLElement): HTMLElement {
  return requiredInstance(container.querySelector('.cinder-restart-state__card'), HTMLElement);
}

function text(element: Element | null): string {
  return (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('RestartState restarting', () => {
  test('names the phase and lists the steps as a status with progress', () => {
    const { container } = render(RestartState, {
      props: {
        open: true,
        phase: 'restarting',
        description:
          'Unloading Web search. Running work picks up where it stopped; reviews stay waiting.',
        currentStep: 2,
      },
    });
    expect(text(card(container).querySelector('h2'))).toBe('Restarting Interborough');
    const dialog = requiredInstance(container.querySelector('dialog'), HTMLDialogElement);
    expect(dialog.getAttribute('aria-label')).toBe('Restarting Interborough');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(card(container).querySelector(`#${describedBy}`)?.className).toContain(
      'cinder-restart-state__description',
    );
    const status = requiredInstance(
      card(container).querySelector('.cinder-steps[role="status"]'),
      HTMLElement,
    );
    const rows = Array.from(status.querySelectorAll('li'));
    expect(rows.map((row) => row.getAttribute('data-cinder-state'))).toEqual([
      'complete',
      'complete',
      'current',
      'upcoming',
    ]);
    expect(text(rows[0] ?? null)).toContain('Saved your choice');
    expect(text(rows[3] ?? null)).toContain('Checking plugins');
  });

  test('takes its own step labels', () => {
    const { container } = render(RestartState, {
      props: { open: true, phase: 'restarting', steps: ['One', 'Two'], currentStep: 1 },
    });
    const rows = Array.from(card(container).querySelectorAll('li'));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.getAttribute('data-cinder-state'))).toEqual([
      'complete',
      'current',
    ]);
  });

  test('has no buttons and cannot be dismissed', async () => {
    const { container } = render(RestartState, { props: { open: true, phase: 'restarting' } });
    expect(card(container).querySelector('button')).toBeNull();
    expect(container.querySelector('.cinder-modal__close')).toBeNull();
    const dialog = requiredInstance(container.querySelector('dialog'), HTMLDialogElement);
    await fireEvent(dialog, new Event('cancel', { cancelable: true }));
    await fireEvent.click(dialog);
    await tick();
    expect(container.querySelector('.cinder-restart-state__card')).not.toBeNull();
  });
});

describe('RestartState reconnecting', () => {
  test('builds the sentence from the retry and attempt facts', () => {
    const { container } = render(RestartState, {
      props: { open: true, phase: 'reconnecting', attempt: 3, retryInSeconds: 4 },
    });
    expect(text(card(container).querySelector('h2'))).toBe('Waiting for Interborough');
    expect(text(card(container).querySelector('.cinder-restart-state__description'))).toBe(
      'The server stopped and hasn’t answered yet. Trying again in 4 s. Attempt 3 of 8.',
    );
  });

  test('draws one segment per attempt with the reached ones filled, hidden from assistive technology', () => {
    const { container } = render(RestartState, {
      props: { open: true, phase: 'reconnecting', attempt: 3 },
    });
    const meter = requiredInstance(
      card(container).querySelector('.cinder-restart-state__attempts'),
      HTMLElement,
    );
    expect(meter.getAttribute('aria-hidden')).toBe('true');
    const segments = Array.from(meter.children);
    expect(segments).toHaveLength(8);
    expect(segments.filter((segment) => segment.hasAttribute('data-cinder-filled'))).toHaveLength(
      3,
    );
    expect(text(card(container).querySelector('[role="status"]'))).toBe('Attempt 3 of 8.');
  });

  test('clamps the attempt to the meter and honours maxAttempts', () => {
    const { container } = render(RestartState, {
      props: { open: true, phase: 'reconnecting', attempt: 99, maxAttempts: 5 },
    });
    const segments = Array.from(
      card(container).querySelector('.cinder-restart-state__attempts')?.children ?? [],
    );
    expect(segments).toHaveLength(5);
    expect(segments.every((segment) => segment.hasAttribute('data-cinder-filled'))).toBe(true);
    expect(text(card(container).querySelector('.cinder-restart-state__description'))).toContain(
      'Attempt 5 of 5.',
    );
  });

  test('Retry now shows only with a handler and fires it', async () => {
    const withoutHandler = render(RestartState, {
      props: { open: true, phase: 'reconnecting', attempt: 1 },
    });
    expect(card(withoutHandler.container).querySelector('button')).toBeNull();
    cleanup();
    const onRetry = mock(() => {});
    const { container } = render(RestartState, {
      props: { open: true, phase: 'reconnecting', attempt: 1, onRetry },
    });
    const button = requiredInstance(card(container).querySelector('button'), HTMLButtonElement);
    expect(text(button)).toBe('Retry now');
    await fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('RestartState failed', () => {
  const failed = {
    open: true,
    phase: 'failed',
    description:
      'It didn’t answer after 8 tries. Your choice to disable Web search was saved before it stopped, so it applies once Interborough starts.',
    check:
      'That Interborough is still running on this machine, and that its address is reachable from this browser.',
    command: 'bun run start',
  } as const;

  test('says it failed with the saved choice, what to check and the command', () => {
    const { container } = render(RestartState, { props: failed });
    expect(text(card(container).querySelector('h2'))).toBe('Interborough didn’t come back');
    expect(card(container).getAttribute('data-cinder-phase')).toBe('failed');
    expect(text(card(container).querySelector('.cinder-restart-state__check-title'))).toBe(
      'What to check',
    );
    expect(text(card(container).querySelector('.cinder-restart-state__check-text'))).toContain(
      'still running on this machine',
    );
    expect(text(card(container).querySelector('.cinder-restart-state__command'))).toContain(
      'Start it again from the terminal: bun run start',
    );
  });

  test('has Keep waiting and no way to restart again', async () => {
    const onKeepWaiting = mock(() => {});
    const { container } = render(RestartState, { props: { ...failed, onKeepWaiting } });
    const labels = Array.from(card(container).querySelectorAll('button')).map(
      (button) => button.getAttribute('aria-label') ?? text(button),
    );
    expect(labels).toEqual(['Copy the command', 'Keep waiting']);
    expect(labels.join(' ')).not.toMatch(/restart/i);
    const keep = requiredInstance(
      Array.from(card(container).querySelectorAll('button')).at(-1) ?? null,
      HTMLButtonElement,
    );
    await fireEvent.click(keep);
    expect(onKeepWaiting).toHaveBeenCalledTimes(1);
  });

  test('error details sit behind a disclosure', () => {
    const { container } = render(RestartState, {
      props: {
        ...failed,
        details: createRawSnippet(() => ({
          render: () => '<pre>ECONNREFUSED 127.0.0.1:3000</pre>',
        })),
      },
    });
    const details = requiredInstance(
      card(container).querySelector('details.cinder-restart-state__details'),
      HTMLDetailsElement,
    );
    expect(details.open).toBe(false);
    expect(text(details.querySelector('summary'))).toBe('Show the error details');
    expect(details.textContent).toContain('ECONNREFUSED');
  });

  test('leaves out the check, the details and the command when it has none', () => {
    const { container } = render(RestartState, {
      props: { open: true, phase: 'failed', onKeepWaiting: () => {} },
    });
    expect(text(card(container).querySelector('.cinder-restart-state__description'))).toBe(
      'It didn’t answer after 8 tries.',
    );
    expect(card(container).querySelector('.cinder-restart-state__check')).toBeNull();
    expect(card(container).querySelector('details')).toBeNull();
    expect(card(container).querySelector('.cinder-restart-state__command')).toBeNull();
  });

  test('Copy is the copy icon at the end of the command row, and says what it copied', async () => {
    const writeText = mock(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const { container } = render(RestartState, { props: failed });
    const row = requiredInstance(
      card(container).querySelector('.cinder-restart-state__command-row'),
      HTMLElement,
    );
    const copy = requiredInstance(
      row.querySelector('button.cinder-copy-button'),
      HTMLButtonElement,
    );
    // The command comes first in the row and the copy after it, so the copy sits at the end.
    const code = requiredInstance(row.querySelector('code'), HTMLElement);
    expect(code.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(copy.getAttribute('aria-label')).toBe('Copy the command');
    expect(copy.querySelector('svg.lucide-copy')).not.toBeNull();
    expect(text(row.querySelector('code'))).toBe('bun run start');
    await fireEvent.click(copy);
    await waitUntil(() => writeText.mock.calls.length > 0);
    expect(writeText).toHaveBeenCalledWith('bun run start');
    await waitUntil(() =>
      text(card(container).querySelector('.cinder-restart-state__command')).includes(
        'Copied the command.',
      ),
    );
  });

  test('what to check is flat on the card, not an inset box', () => {
    const check = cssText.slice(cssText.indexOf('.cinder-restart-state__check {'));
    const body = check.slice(0, check.indexOf('}'));
    expect(body).not.toMatch(/background|border|padding/);
    const command = cssText.slice(cssText.indexOf('.cinder-restart-state__command-text {'));
    expect(command.slice(0, command.indexOf('}'))).not.toMatch(/background|border/);
  });
});

describe('RestartState title and stylesheet', () => {
  test('a given title replaces the phase default', () => {
    const { container } = render(RestartState, {
      props: { open: true, phase: 'restarting', title: 'Restarting the host' },
    });
    expect(text(card(container).querySelector('h2'))).toBe('Restarting the host');
  });

  test('renders nothing while closed', () => {
    const { container } = render(RestartState, { props: { open: false, phase: 'restarting' } });
    expect(container.querySelector('.cinder-restart-state__card')).toBeNull();
  });

  test('the spinning glyph stops under reduced motion', () => {
    expect(cssText).toContain('prefers-reduced-motion: reduce');
    expect(cssText).toMatch(/animation:\s*none/);
  });

  test('the failed card repaints its border and heading in the danger tokens', () => {
    expect(cssText).toContain("[data-cinder-phase='failed']");
    expect(cssText).toContain('--cinder-status-danger-border');
    expect(cssText).toContain('--cinder-status-danger-text');
  });
});
