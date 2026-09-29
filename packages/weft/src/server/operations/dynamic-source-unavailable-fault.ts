/**
 * Shared typed-fault mapping for {@link DynamicWorkflowSourceUnavailableError},
 * used by the schedule and catalog fault mappers so the wire-message leak
 * boundary lives in exactly one place.
 *
 * @module server/operations/dynamic-source-unavailable-fault
 */

import { DynamicWorkflowSourceUnavailableError } from '../../core/engine/dynamic-source-errors.ts';
import type { OperationFault } from '../operation-fault.ts';

/**
 * Map a dynamic-source failure to a `Conflict`. A `load-failed` error's own
 * message embeds the raw loader exception, so the wire message is bounded;
 * `ambiguous-revision` never interpolates a cause, so it is forwarded verbatim.
 * `undefined` when `error` is not this error class.
 */
export function mapDynamicSourceUnavailableToFault(error: unknown): OperationFault | undefined {
  if (!(error instanceof DynamicWorkflowSourceUnavailableError)) return undefined;
  const revisionSuffix = error.revision === undefined ? '' : ` revision "${error.revision}"`;
  return {
    code: 'Conflict',
    message:
      error.reason === 'load-failed'
        ? `Dynamic workflow source "${error.workflowType}"${revisionSuffix} failed to load.`
        : error.message,
    data: { reason: error.reason, weftCode: error.code },
  };
}
