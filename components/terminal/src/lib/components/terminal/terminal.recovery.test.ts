import { afterEach, describe, expect, test } from 'bun:test';

import {
  destroyAllHarnesses,
  mountHarness,
  type MountedHarness,
} from '../../../test/mount-harness.ts';
import { reactiveProps } from '../../../test/reactive-props.svelte.ts';
import { waitFor } from './terminal-test-support.ts';
import Terminal from './terminal.svelte';
import type { TerminalProps, TerminalState } from './terminal.types.ts';

afterEach(async () => {
  await destroyAllHarnesses();
});

function buttons(harness: MountedHarness): string[] {
  return [
    ...harness.target.querySelectorAll<HTMLButtonElement>('.cinder-terminal__recovery button'),
  ].map((button) => `${button.textContent?.trim()}${button.disabled ? ' (disabled)' : ''}`);
}

function button(harness: MountedHarness, label: string): HTMLButtonElement {
  const found = [...harness.target.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`Expected a ${label} button`);
  return found;
}

describe('recovery actions', () => {
  test('are rendered in a labelled group only for handlers the host provides', () => {
    const harness = mountHarness(Terminal, {
      title: 'Shell',
      state: 'denied',
      onTryAgain: () => {},
    } satisfies TerminalProps);
    expect(buttons(harness)).toEqual(['Try again']);
    const group = harness.target.querySelector('.cinder-terminal__recovery')!;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Terminal recovery');
  });

  test('a state with no handler renders no control at all', () => {
    for (const state of [
      'empty',
      'denied',
      'failed',
      'cleanup-incomplete',
      'writable',
      'read-only',
    ] as const) {
      const harness = mountHarness(Terminal, { title: 'Shell', state } satisfies TerminalProps);
      expect(buttons(harness), state).toEqual([]);
      expect(harness.target.querySelector('.cinder-terminal__recovery'), state).toBeNull();
    }
  });

  test('each action calls its own handler once', () => {
    const calls: string[] = [];
    const handlers = {
      onNewSession: () => {
        calls.push('new');
      },
      onTryAgain: () => {
        calls.push('again');
      },
      onRetry: () => {
        calls.push('retry');
      },
      onCheckCleanup: () => {
        calls.push('check');
      },
      onCancel: () => {
        calls.push('cancel');
      },
    };
    const clickIn = (state: TerminalState, label: string) => {
      const harness = mountHarness(Terminal, { title: 'Shell', state, ...handlers });
      button(harness, label).click();
      harness.flush();
    };
    clickIn('empty', 'New session');
    clickIn('denied', 'Try again');
    clickIn('denied', 'New session');
    clickIn('failed', 'Retry');
    clickIn('cleanup-incomplete', 'Check cleanup');
    clickIn('connecting', 'Cancel');
    expect(calls).toEqual(['new', 'again', 'new', 'retry', 'check', 'cancel']);
  });

  test('writable offers New session next to the capture controls, and read-only shows it disabled', () => {
    let calls = 0;
    const writable = mountHarness(Terminal, {
      title: 'Shell',
      state: 'writable',
      onNewSession: () => (calls += 1),
    } satisfies TerminalProps);
    expect(buttons(writable)).toEqual(['New session']);
    expect(button(writable, 'Capture terminal keys')).not.toBeNull();
    button(writable, 'New session').click();
    expect(calls).toBe(1);
    const readOnly = mountHarness(Terminal, {
      title: 'Shell',
      state: 'read-only',
      onNewSession: () => (calls += 1),
    } satisfies TerminalProps);
    expect(buttons(readOnly)).toEqual(['New session (disabled)']);
    button(readOnly, 'New session').click();
    expect(calls).toBe(1);
  });

  test('replacement waits for cleanup: the buttons show and cannot be used', () => {
    let calls = 0;
    const harness = mountHarness(Terminal, {
      title: 'Shell',
      state: 'denied',
      cleanupPending: true,
      onNewSession: () => (calls += 1),
      onTryAgain: () => (calls += 1),
    } satisfies TerminalProps);
    expect(buttons(harness)).toEqual(['Try again', 'New session (disabled)']);
    button(harness, 'New session').click();
    expect(calls).toBe(0);
  });

  test('cleanup-incomplete offers only the cleanup check, never a replacement', () => {
    const harness = mountHarness(Terminal, {
      title: 'Shell',
      state: 'cleanup-incomplete',
      cleanupPending: true,
      onNewSession: () => {},
      onRetry: () => {},
      onCheckCleanup: () => {},
    } satisfies TerminalProps);
    expect(buttons(harness)).toEqual(['Check cleanup']);
  });

  test('focus stays on the action that was used when it is still there', () => {
    const harness = mountHarness(Terminal, {
      title: 'Shell',
      state: 'cleanup-incomplete',
      onCheckCleanup: () => {},
    } satisfies TerminalProps);
    const check = button(harness, 'Check cleanup');
    check.click();
    harness.flush();
    expect(document.activeElement).toBe(check);
  });

  test('focus moves to the new state’s first action when the used one was removed', async () => {
    const props = reactiveProps<TerminalProps>({
      title: 'Shell',
      state: 'empty',
      onNewSession: () => {
        props.state = 'connecting';
      },
      onCancel: () => {
        props.state = 'empty';
      },
    });
    const harness = mountHarness(Terminal, props);
    button(harness, 'New session').click();
    harness.flush();
    await waitFor(() => document.activeElement === button(harness, 'Cancel'), 'focus on Cancel');
    button(harness, 'Cancel').click();
    harness.flush();
    await waitFor(
      () => document.activeElement === button(harness, 'New session'),
      'focus back on New session',
    );
  });

  test('backpressured offers no Cancel, even when the host handles it, and output stays readable', () => {
    const harness = mountHarness(Terminal, {
      title: 'Shell',
      state: 'backpressured',
      onCancel: () => {},
      onNewSession: () => {},
    } satisfies TerminalProps);
    expect(buttons(harness)).toEqual([]);
    expect(harness.target.querySelector('.cinder-terminal__viewport')).not.toBeNull();
  });

  test('focus falls to the frame when the new state has no action to take it', async () => {
    const props = reactiveProps<TerminalProps>({
      title: 'Shell',
      state: 'denied',
      onTryAgain: () => {
        props.state = 'writable';
      },
    });
    const harness = mountHarness(Terminal, props);
    button(harness, 'Try again').click();
    harness.flush();
    await waitFor(
      () => document.activeElement === harness.target.querySelector('.cinder-terminal__body'),
      'focus on the frame body',
    );
  });

  test('a later state change does not pull focus back after the reader moved elsewhere', async () => {
    const props = reactiveProps<TerminalProps>({
      title: 'Shell',
      state: 'denied',
      onTryAgain: () => {},
      onCancel: () => {},
    });
    const harness = mountHarness(Terminal, props);
    const elsewhere = document.createElement('button');
    elsewhere.textContent = 'Elsewhere';
    document.body.append(elsewhere);
    try {
      // The host refused the attempt, so the button stays; the reader goes on to something else.
      button(harness, 'Try again').click();
      harness.flush();
      elsewhere.focus();
      // The host changes the state later, which removes the button the reader used.
      props.state = 'connecting';
      harness.flush();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(document.activeElement?.textContent?.trim()).toBe('Elsewhere');
    } finally {
      elsewhere.remove();
    }
  });

  test('focus that fell to the page when the used button went still moves to the new action', async () => {
    const props = reactiveProps<TerminalProps>({
      title: 'Shell',
      state: 'empty',
      onNewSession: () => {},
      onCancel: () => {},
    });
    const harness = mountHarness(Terminal, props);
    button(harness, 'New session').click();
    harness.flush();
    // The host answers later, not inside the click.
    props.state = 'connecting';
    harness.flush();
    await waitFor(() => document.activeElement === button(harness, 'Cancel'), 'focus on Cancel');
  });

  test('a failure offers one recovery control: the frame reload gives way to Retry outside engine-load-failed', () => {
    const calls: string[] = [];
    const harness = mountHarness(Terminal, {
      title: 'Shell',
      state: 'failed',
      error: 'The process lost its session',
      onRecoveryRequest: () => {
        calls.push('reload');
      },
      onRetry: () => {
        calls.push('retry');
      },
    } satisfies TerminalProps);
    const names = [...harness.target.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(names.filter((name) => name === 'Reload' || name === 'Retry')).toEqual(['Retry']);
    button(harness, 'Retry').click();
    expect(calls).toEqual(['retry']);
  });

  test('engine-load-failed keeps the frame reload as its one control', () => {
    const harness = mountHarness(Terminal, {
      title: 'Shell',
      state: 'engine-load-failed',
      error: 'The engine could not load',
      onRecoveryRequest: () => {},
      onRetry: () => {},
    } satisfies TerminalProps);
    const names = [...harness.target.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(names.filter((name) => name === 'Reload' || name === 'Retry')).toEqual(['Reload']);
  });
});
