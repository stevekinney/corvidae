import { describe, expect, test } from 'bun:test';

import { installShutdownSignals, type ShutdownSignalTarget } from './shutdown-signals.ts';

function signalTarget(): {
  target: ShutdownSignalTarget;
  emit(signal: 'SIGINT' | 'SIGTERM'): void;
} {
  const listeners = new Map<'SIGINT' | 'SIGTERM', () => void>();
  return {
    target: {
      on(signal, listener) {
        listeners.set(signal, listener);
      },
    },
    emit(signal) {
      listeners.get(signal)?.();
    },
  };
}

describe('installShutdownSignals', () => {
  test.each([
    ['SIGINT', 'SIGTERM'],
    ['SIGTERM', 'SIGINT'],
  ] as const)('forwards %s then %s only once', (first, second) => {
    const signals = signalTarget();
    let calls = 0;
    installShutdownSignals(signals.target, () => {
      calls += 1;
    });

    signals.emit(first);
    signals.emit(second);
    signals.emit(first);

    expect(calls).toBe(1);
  });
});
