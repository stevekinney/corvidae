import type { DetectionResult, DetectorContext, InputDetector } from './types';

/** The highest-confidence detector that triggered, or `undefined` if none did. */
export interface DetectorPipelineResult {
  result: DetectionResult;
  detectorName: string;
  /** Set when a detector threw and the pipeline ran fail-closed: `result` stands for the failure. */
  failed?: true;
}

/** The `category` of the finding a failing detector yields when the pipeline fails closed. */
const DETECTOR_FAILURE_CATEGORY = 'detector-failure';

function failureOf(detector: InputDetector, error: unknown): DetectorPipelineResult {
  return {
    detectorName: detector.name,
    failed: true,
    result: {
      triggered: true,
      confidence: 1,
      category: DETECTOR_FAILURE_CATEGORY,
      detail: `Detector "${detector.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
    },
  };
}

/**
 * Runs a set of detectors against a piece of content and returns the
 * highest-confidence trigger.
 *
 * In `'parallel'` mode (the default) every detector runs concurrently and the
 * result with the highest `confidence` among triggered detectors wins. In
 * `'sequential'` mode detectors run in order and the pipeline stops at the
 * first trigger.
 *
 * Detector errors are caught (via `Promise.allSettled` in parallel mode, a
 * `try`/`catch` in sequential mode) so a broken detector never crashes the
 * caller — this is the shared "detector pipeline" reused by the input
 * guardrail hook (operative) and by content scanning at retrieval surfaces
 * (memory recall, ingested documents, skill resources).
 *
 * With `failClosed`, a detector that throws or rejects is a finding instead
 * (`failed`, category `detector-failure`, confidence 1), and it
 * outranks every real detection, so a guardrail that cannot judge never passes
 * the content (COR-2300). The plugin secret gate's needs-setup refusal reaches
 * the pipeline as such an error.
 */
export async function runDetectorPipeline(
  input: string,
  detectors: readonly InputDetector[],
  context: DetectorContext,
  mode: 'parallel' | 'sequential' = 'parallel',
  failClosed = false,
): Promise<DetectorPipelineResult | undefined> {
  let topResult: DetectorPipelineResult | undefined;

  if (mode === 'sequential') {
    for (const detector of detectors) {
      try {
        const result = await detector.detect(input, context);
        if (result.triggered) {
          topResult = { result, detectorName: detector.name };
          break;
        }
      } catch (error) {
        // Detector errors must not crash the caller.
        if (failClosed) return failureOf(detector, error);
      }
    }
    return topResult;
  }

  const settled = await Promise.allSettled(
    detectors.map(async (detector) => ({
      result: await detector.detect(input, context),
      detectorName: detector.name,
    })),
  );

  for (const [index, outcome] of settled.entries()) {
    if (outcome.status === 'rejected') {
      if (failClosed && topResult?.failed !== true) {
        topResult = failureOf(detectors[index]!, outcome.reason);
      }
    } else if (outcome.value.result.triggered && topResult?.failed !== true) {
      if (!topResult || outcome.value.result.confidence > topResult.result.confidence) {
        topResult = outcome.value;
      }
    }
  }

  return topResult;
}
