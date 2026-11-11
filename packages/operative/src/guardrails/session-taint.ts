import type { JSONValue } from 'armorer/protocol';

import type {
  GuardrailProvenance,
  InputDetector,
  OutputValidator,
  PersistedSessionTaint,
  SessionTaintedEvent,
  SessionTaintOptions,
  SessionTaintTracker,
  ToolCallValidator,
} from './types';

/**
 * The `AgentSession.metadata` key a tainted session stores its {@link PersistedSessionTaint}
 * under (COR-2105). A session stored without it is untainted.
 */
export const SESSION_TAINT_METADATA_KEY = 'guardrailTaint';

// A `Record` over the union, so a provenance armorer adds is a compile error here until it is
// listed, rather than a stored taint that reads as untainted.
const PROVENANCE_SET: Readonly<Record<GuardrailProvenance, true>> = {
  'user-input': true,
  'recalled-memory': true,
  'ingested-document': true,
  'skill-resource': true,
  'tool-result': true,
};

function isProvenance(value: unknown): value is GuardrailProvenance {
  return typeof value === 'string' && Object.hasOwn(PROVENANCE_SET, value);
}

/**
 * Reads the taint a session's metadata carries. Absent, `null`, and anything that is not a
 * well-formed {@link PersistedSessionTaint} read as untainted, which is how a session stored before
 * the key existed reads.
 */
export function readSessionTaint(
  metadata: Readonly<Record<string, JSONValue>> | undefined,
): PersistedSessionTaint | undefined {
  const raw = metadata === undefined ? undefined : metadata[SESSION_TAINT_METADATA_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const { category, detector, provenance, confidence, at, runId } = raw as Record<
    string,
    JSONValue | undefined
  >;
  if (
    typeof category !== 'string' ||
    typeof detector !== 'string' ||
    !isProvenance(provenance) ||
    typeof confidence !== 'number' ||
    typeof at !== 'number' ||
    typeof runId !== 'string'
  ) {
    return undefined;
  }
  return { category, detector, provenance, confidence, at, runId };
}

/**
 * Builds the value a session persists for a taint: the event's facts and no free text. `runId` is
 * the event's, else `fallbackRunId`; `at` is the caller's clock.
 */
export function persistedSessionTaintOf(
  event: SessionTaintedEvent,
  at: number,
  fallbackRunId: string,
): PersistedSessionTaint {
  return {
    category: event.category,
    detector: event.detector,
    provenance: event.provenance ?? 'user-input',
    confidence: event.confidence,
    at,
    runId: event.runId ?? fallbackRunId,
  };
}

/**
 * Creates a session taint tracker that manages escalation state.
 *
 * When a high-confidence detection occurs (>= `taintThreshold`, default 0.9), the
 * caller marks the session as tainted. Once tainted, the tracker adds `escalatedDetectors`
 * `escalatedValidators` and `escalatedToolValidators` to the active set, enabling stricter inspection for the
 * remainder of the session.
 *
 * Taint is sticky: once set, it cannot be unset. The `onTainted` callback fires only
 * on the first taint event, and never for a tracker that starts tainted through `initial`.
 */
export function createSessionTaintTracker(options: SessionTaintOptions = {}): SessionTaintTracker {
  const {
    escalatedDetectors = [],
    escalatedValidators = [],
    escalatedToolValidators = [],
    onTainted,
    initial,
    runId: trackerRunId,
  } = options;

  let tainted = initial !== undefined;
  let pending: Promise<void> = Promise.resolve();

  return {
    isTainted(): boolean {
      return tainted;
    },

    taint(event: SessionTaintedEvent): void {
      if (tainted) return;
      tainted = true;
      const stamped =
        event.runId === undefined && trackerRunId !== undefined
          ? { ...event, runId: trackerRunId }
          : event;
      if (onTainted === undefined) return;
      // An async wrapper turns a synchronous throw or a non-Promise thenable into a promise that
      // `settled()` awaits, so the callback cannot be outrun and cannot escape.
      const settledCall = (async () => onTainted(stamped))().then(
        () => undefined,
        () => undefined,
      );
      pending = pending.then(() => settledCall);
    },

    settled(): Promise<void> {
      return pending;
    },

    /** Returns escalated detectors when tainted, empty array otherwise. */
    getDetectors(): InputDetector[] {
      if (!tainted) return [];
      return [...escalatedDetectors];
    },

    /** Returns escalated validators when tainted, empty array otherwise. */
    getValidators(): OutputValidator[] {
      if (!tainted) return [];
      return [...escalatedValidators];
    },

    /** Returns escalated tool-call validators when tainted, empty array otherwise. */
    getToolValidators(): ToolCallValidator[] {
      if (!tainted) return [];
      return [...escalatedToolValidators];
    },
  };
}
