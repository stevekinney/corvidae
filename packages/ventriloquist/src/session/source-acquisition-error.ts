import type { CleanupOutcome } from '../protocol/messages.ts';

/**
 * A session could not open one of its sources. The sources opened before it are already being
 * released, and `cleanup` settles, without ever rejecting, with how that release ended. A caller
 * that owns the ownership slot must wait for it: an incomplete or unknown release leaves resources
 * held, which quarantines the slot exactly as an incomplete session cleanup does.
 */
export class SourceAcquisitionError extends Error {
  readonly cleanup: Promise<CleanupOutcome>;

  constructor(cause: unknown, cleanup: Promise<CleanupOutcome>) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'SourceAcquisitionError';
    this.cleanup = cleanup;
  }
}
