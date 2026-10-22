import { WeftError } from '../weft-error.ts';

/**
 * Thrown when a workflow's checkpoint cannot be encoded for storage, for
 * example because a workflow local or memoized result nests deeper than the
 * codec allows. Unlike a refused storage write, which the engine retries up to
 * four more times (750 ms in all) before it fails the workflow with a
 * `CheckpointCommitFailedError`, encoding is deterministic: the same state
 * fails the same way on every attempt and every resume, so it is never
 * retried, and the engine fails the workflow with this error at once rather
 * than leaving it running.
 */
export class CheckpointEncodingError extends WeftError<'CheckpointEncodingError'> {
  readonly workflowId: string;

  constructor(workflowId: string, cause: unknown) {
    super(
      'CheckpointEncodingError',
      `Workflow "${workflowId}" checkpoint cannot be encoded: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.workflowId = workflowId;
  }
}
