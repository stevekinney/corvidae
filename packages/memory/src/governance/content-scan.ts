import type { DetectionResult, DetectorContext, GuardrailProvenance, InputDetector } from 'armorer';

import { raceAbort } from './abort-race';
import type { MemoryClass, MemorySourceKind, MemoryTrust } from './policy';

/**
 * What a scan found. A flagged scan says whether a detector tripped or failed: `failed` is true only
 * when the detector threw, and is how a caller tells the two apart. The category is not: a detector
 * may report `detector-failure` as the category of a detection of its own (COR-2194).
 */
export type GovernedContentScan =
  | { readonly flagged: false }
  | {
      readonly flagged: true;
      /** True only when the detector threw; false when it tripped, whatever category it named. */
      readonly failed: boolean;
      readonly detector: string;
      readonly category: string;
      readonly confidence: number;
    };

/** The record a scan is of, which detectors read as `DetectorContext.memory` (COR-2196). */
export interface GovernedScanRecord {
  /** Where the content came from. */
  readonly source: MemorySourceKind;
  /** What kind of memory it is. */
  readonly memoryClass: MemoryClass;
  /** How far it is trusted. */
  readonly trust: MemoryTrust;
}

/** What a scan is told besides the content: the operation's cancellation, and a way to count its work. */
export interface GovernedContentScanOptions {
  /**
   * Cancels the scan: a signal that has already aborted runs no detector, and one that aborts
   * mid-scan ends the wait on the running detector, which may never settle. Either way the scan
   * rejects with the signal's reason. The detectors receive it as `DetectorContext.signal`.
   */
  readonly signal?: AbortSignal;
  /** Called as each detector starts, so a caller that budgets detector runs can charge for it. */
  readonly onDetectorRun?: () => void;
  /**
   * Whether the session the content is read in is tainted, which detectors read as
   * `DetectorContext.sessionTainted`. Defaults to `false`: only a recall knows its session.
   */
  readonly sessionTainted?: boolean;
}

/**
 * Runs governance detectors in order and stops at the first trip. Unlike the
 * shared guardrail pipeline, which swallows a detector's exception so it never
 * crashes a conversation, governance fails closed: a detector that throws is a
 * detection (`failed`), because admitting content nobody could scan is exactly the gap a
 * poisoning attempt would aim for. What a caller does with a failure is its own: admission and
 * promotion treat it as any detection, and recall withholds the record without quarantining it. The
 * result never carries the content itself, nor the error.
 *
 * A cancelled scan is the exception: it rejects with the signal's reason rather than flag, and a
 * detector that throws because the operation was cancelled is that cancellation, not a failure.
 */
export async function scanGovernedContent(
  content: string,
  detectors: readonly InputDetector[],
  provenance: GuardrailProvenance,
  memory: GovernedScanRecord,
  options: GovernedContentScanOptions = {},
): Promise<GovernedContentScan> {
  const { signal, onDetectorRun, sessionTainted = false } = options;
  const context: DetectorContext = {
    step: 0,
    conversationLength: 0,
    sessionTainted,
    provenance,
    memory,
    ...(signal === undefined ? {} : { signal }),
  };
  for (const detector of detectors) {
    signal?.throwIfAborted();
    onDetectorRun?.();
    let result: DetectionResult;
    try {
      // `detect` is called here, inside the `try`, so a detector that throws before it returns a
      // promise fails closed as one that rejects does.
      result = await raceAbort(Promise.resolve(detector.detect(content, context)), signal);
    } catch {
      if (signal?.aborted === true) throw signal.reason;
      return {
        flagged: true,
        failed: true,
        detector: detector.name,
        category: 'detector-failure',
        confidence: 1,
      };
    }
    if (result.triggered) {
      return {
        flagged: true,
        failed: false,
        detector: detector.name,
        category: result.category,
        confidence: result.confidence,
      };
    }
  }
  return { flagged: false };
}
