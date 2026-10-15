import type { FailureCode } from '../protocol/failure-codes.ts';

/** The two codes a process can fail to start with, as the contract's failure table names them. */
export type ProcessStartFailureCode = Extract<FailureCode, 'unsupported-runtime' | 'spawn-failed'>;

/**
 * Why a process did not start. `unsupported-runtime` means this host or Bun cannot run the mode at
 * all, and the helper never falls back to another mode; `spawn-failed` means the host tried and the
 * operating system refused. Neither is a process exit, and neither is a transport failure.
 */
export class ProcessStartFailure extends Error {
  readonly code: ProcessStartFailureCode;

  constructor(code: ProcessStartFailureCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProcessStartFailure';
    this.code = code;
  }
}
