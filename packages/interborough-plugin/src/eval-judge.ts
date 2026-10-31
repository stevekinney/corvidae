import type { RunResult } from '@lostgradient/operative';

/** The result of scoring a single completed run against one judge/matcher. */
export interface EvalScore {
  /** Whether the run's output passed this judge's check. */
  pass: boolean;
  /** Score from 0-1 (1 = perfect). */
  score: number;
  /** Human-readable description of the score. */
  message: string;
}

/**
 * A single configured judge or matcher run against a fraction of live runs.
 * `evaluate` receives the completed run's {@link RunResult} — the same shape
 * `evaluation`'s `matchCustomAssertion`/`createLLMJudge` operate on, so an
 * existing offline matcher or LLM judge can be adapted into this shape
 * directly (wrap it, normalize its score to 0-1, return {@link EvalScore}).
 */
export interface OnlineEvalJudge {
  /** Name recorded on every audit record and alert payload produced by this judge. */
  name: string;
  /**
   * The judge's version (COR-1872), recorded beside its name on every audit record and alert
   * payload, so a score can be traced to the exact judge that gave it.
   */
  version: string;
  /** Scores a sampled run. May be async (e.g. an LLM-as-judge call). */
  evaluate: (runResult: RunResult) => EvalScore | Promise<EvalScore>;
  /**
   * Alert threshold: a score strictly below this fires a webhook. Omit to
   * alert whenever the judge reports `pass: false` instead of on a numeric
   * threshold.
   */
  alertThreshold?: number;
}
