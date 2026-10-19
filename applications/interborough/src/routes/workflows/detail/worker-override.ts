/**
 * The worker start override's contract with the console (COR-164): the typed
 * clients the restart dialog needs and the plain-language reading of the typed
 * faults the preview and the spending start can answer with.
 *
 * Faults are branched on their code and `data.reason`, never on message text.
 * `reason` rides only on the JSON-RPC fault envelope (REST has never disclosed
 * it), so the preview and the override start both go through
 * `client.operations`, which speaks JSON-RPC.
 *
 * @module
 */
import {
  HttpClientError,
  UPGRADE_REFUSAL_REASON_PREFIX,
  WORKER_CONFLICT_REASONS,
  type WorkerStartOverridePreview,
} from '@lostgradient/weft';

import { faultTreatment } from '../../../lib/faults.ts';

/** The two operations the override flow calls, optional so a client without them still type-checks. */
export interface WorkerOverrideClient {
  readonly operations: {
    readonly 'weft.worker.startoverrides.preview'?: (input: {
      workflowId: string;
    }) => Promise<{ readonly preview: WorkerStartOverridePreview }>;
    readonly 'weft.workflows.startorsignal'?: (input: {
      type: string;
      input: unknown;
      id: string;
      tags?: string[];
      onTerminalConflict: 'start-new';
      signalName: string;
      signalId: string;
      signalPayload?: unknown;
      workerStartOverridePreview: WorkerStartOverridePreview;
    }) => Promise<{ readonly id: string; readonly outcome: 'started' | 'signalled' }>;
  };
}

function conflictReason(error: unknown): string | undefined {
  if (!(error instanceof HttpClientError) || error.status !== 409) return undefined;
  const reason = error.data?.['reason'];
  return typeof reason === 'string' ? reason : undefined;
}

/** Whether a start was refused because its override preview cannot authorize it. */
export function isOverrideTokenRejected(error: unknown): boolean {
  return conflictReason(error) === WORKER_CONFLICT_REASONS.overrideTokenRejected;
}

const PREVIEW_REASONS: Readonly<Record<string, string>> = {
  [WORKER_CONFLICT_REASONS.workflowNotTerminal]:
    'This run is not terminal, so it cannot be restarted with a worker override.',
  [WORKER_CONFLICT_REASONS.noWorkerBinding]: 'This run has no durable worker binding to override.',
  [WORKER_CONFLICT_REASONS.policyNotAutoUpgrade]:
    'This run is pinned to its build, so its worker binding cannot be overridden.',
  [WORKER_CONFLICT_REASONS.noRoutedDeployment]:
    'No ready, routed deployment build provides this run’s revision, so there is no build to move it to.',
  [WORKER_CONFLICT_REASONS.overrideTokenRejected]:
    'The override preview was expired, already used, issued for another run, or no longer matches this run’s binding. Request a new preview.',
};

/** Plain-language reading of a fault from the preview or from the start that spends it. */
export function describeOverrideFault(error: unknown): string {
  const reason = conflictReason(error);
  if (reason !== undefined) {
    const known = PREVIEW_REASONS[reason];
    if (known !== undefined) return known;
    if (reason.startsWith(UPGRADE_REFUSAL_REASON_PREFIX)) {
      return `The build routing selects now cannot take this run (${reason.slice(UPGRADE_REFUSAL_REASON_PREFIX.length)}), so no preview was issued.`;
    }
  }
  if (error instanceof HttpClientError && error.faultCode === 'NotFound') {
    return 'This run no longer exists, so no preview can be issued for it.';
  }
  if (error instanceof HttpClientError && error.faultCode === 'UnsupportedCapability') {
    return 'This server has no worker-start-override signing key configured, so previews are unavailable.';
  }
  return faultTreatment(error).message;
}
