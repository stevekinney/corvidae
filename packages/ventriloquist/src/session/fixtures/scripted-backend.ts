import type { CleanupOutcome } from '../../protocol/messages.ts';
import type { InputHold, ProcessBackend } from '../session-types.ts';

export type BackendCall =
  | { readonly call: 'start' }
  | { readonly call: 'write'; readonly bytes: Uint8Array }
  | { readonly call: 'resize'; readonly columns: number; readonly rows: number }
  | { readonly call: 'cleanup' };

export type ScriptedBackendOptions = {
  readonly mode?: 'pty' | 'pipe';
  /** Without it `start` resolves at once. Return a pending promise to hold the process in `starting`. */
  readonly start?: () => Promise<void>;
  readonly write?: (bytes: Uint8Array, hold: InputHold | undefined) => Promise<void>;
  readonly resize?: (columns: number, rows: number) => Promise<void>;
  readonly cleanup?: () => Promise<CleanupOutcome>;
};

export type ScriptedBackend = ProcessBackend & {
  /** Every call the session made, in order, so a test can prove what was and was not invoked. */
  readonly calls: readonly BackendCall[];
};

/**
 * A backend whose every step a test scripts. Each step defaults to succeeding immediately; a step
 * given a pending or rejecting promise holds the session in that state until the test moves it.
 * A pipe backend has no `resize`, matching the capabilities a pipe advertises.
 */
export function createScriptedBackend(options: ScriptedBackendOptions = {}): ScriptedBackend {
  const calls: BackendCall[] = [];
  const mode = options.mode ?? 'pty';
  const backend: ScriptedBackend = {
    mode,
    calls,
    start: () => {
      calls.push({ call: 'start' });
      return options.start?.() ?? Promise.resolve();
    },
    write: (bytes, hold) => {
      calls.push({ call: 'write', bytes });
      return options.write?.(bytes, hold) ?? Promise.resolve();
    },
    cleanup: () => {
      calls.push({ call: 'cleanup' });
      return options.cleanup?.() ?? Promise.resolve('complete');
    },
    ...(mode === 'pty'
      ? {
          resize: (columns: number, rows: number) => {
            calls.push({ call: 'resize', columns, rows });
            return options.resize?.(columns, rows) ?? Promise.resolve();
          },
        }
      : {}),
  };
  return backend;
}
