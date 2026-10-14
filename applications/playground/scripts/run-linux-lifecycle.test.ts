import { describe, expect, it } from 'bun:test';

import {
  type ContainerMode,
  pullExitStatus,
  recipeExitStatus,
  runContainerModes,
  runInterruptibly,
  type SignalWatch,
} from './run-linux-lifecycle.ts';

/** A signal source the test fires by hand, standing in for the process's SIGINT and SIGTERM. */
function manualSignals(
  initial?: NodeJS.Signals,
): SignalWatch & { fire(signal: NodeJS.Signals): void } {
  let received = initial;
  const listeners = new Set<(signal: NodeJS.Signals) => void>();
  return {
    received: () => received,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fire(signal) {
      received ??= signal;
      for (const listener of listeners) listener(signal);
    },
  };
}

describe('Linux lifecycle recipe', () => {
  it('runs every mode when nothing interrupts it', async () => {
    const ran: ContainerMode[] = [];
    const results = await runContainerModes(
      ['init', 'no-init'],
      async (mode) => {
        ran.push(mode);
        return 0;
      },
      () => undefined,
    );

    expect(ran).toEqual(['init', 'no-init']);
    expect(recipeExitStatus(results, undefined, 2)).toBe(0);
  });

  it('stops after a signal during the first mode and exits 128 + signal', async () => {
    let received: NodeJS.Signals | undefined;
    const ran: ContainerMode[] = [];
    const results = await runContainerModes(
      ['init', 'no-init'],
      async (mode) => {
        ran.push(mode);
        received = 'SIGINT';
        return 130;
      },
      () => received,
    );

    expect(ran).toEqual(['init']);
    expect(recipeExitStatus(results, received, 2)).toBe(130);
    expect(recipeExitStatus(results, 'SIGTERM', 2)).toBe(143);
  });

  it('fails when a mode failed or did not run', () => {
    expect(
      recipeExitStatus(
        [
          ['init', 0],
          ['no-init', 1],
        ],
        undefined,
        2,
      ),
    ).toBe(1);
    expect(recipeExitStatus([['init', 0]], undefined, 2)).toBe(1);
  });
});

describe('the preliminary image pull', () => {
  it('stops the pull when a signal arrives and exits 128 + signal', async () => {
    const signals = manualSignals();
    // A pull that would otherwise outlast the test's own timeout.
    const pull = runInterruptibly(['sleep', '60'], 120_000, signals);
    setTimeout(() => signals.fire('SIGINT'), 100);

    const status = await pull;

    expect(status).not.toBe(0);
    expect(pullExitStatus(status, signals.received())).toBe(130);
  });

  it('does not start the pull once a signal has already arrived', async () => {
    const signals = manualSignals('SIGTERM');

    const status = await runInterruptibly(['sleep', '60'], 120_000, signals);

    expect(pullExitStatus(status, signals.received())).toBe(143);
  });

  it('continues after a clean pull and fails a failed one', () => {
    expect(pullExitStatus(0, undefined)).toBeUndefined();
    expect(pullExitStatus(1, undefined)).toBe(1);
  });
});
