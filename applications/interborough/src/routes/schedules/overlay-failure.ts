/**
 * What the schedules area says when the Bureau did not say what its schedules start
 * (`lib/schedule-kinds.ts`), as the fault banner shows it. Until the Bureau answers, a schedule is of
 * no known kind and nothing is written to it.
 */
import { SCHEDULE_COPY } from '../../app/copy.ts';
import type { FaultTreatment } from '../../lib/faults.ts';

export const OVERLAY_FAILURE: FaultTreatment = {
  kind: 'internal',
  message: `${SCHEDULE_COPY.overlayFailed.title}. ${SCHEDULE_COPY.overlayFailed.description}`,
  maskedByRest: false,
  tryViaJsonRpc: false,
};
