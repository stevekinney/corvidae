/**
 * Runs the accessibility report for the committed revision (COR-259). The session evaluates
 * all six contexts through the same gate pattern the draft uses, so a response that a newer
 * edit overtook is dropped. The report it holds is stamped with the revision it describes;
 * whether that is still the draft's revision is the caller's question (`isReportCurrent`),
 * which is what keeps a stale report from ever reading as a Pass.
 */

import { buildAccessibilityReport, countReport, outstandingCount } from './theme-check-engine.ts';
import type { AccessibilityReport } from './theme-check-types.ts';
import {
  EvaluationGate,
  type ThemeEvaluation,
  type ThemeEvaluator,
} from './theme-draft-evaluation.ts';
import { THEME_CONTEXT_IDS, type ThemeContextId, type ThemeEnvelope } from './theme-draft-types.ts';

/** One sentence for a screen reader: the aggregate result, never a per-value readout. */
export function aggregateAnnouncement(report: AccessibilityReport): string {
  if (report.sourceValidity.status === 'invalid') {
    return `Checks for revision ${report.stamp.sourceRevision}: the theme source is invalid, so no contrast checks ran.`;
  }
  const counts = countReport(report);
  const parts = [
    `${counts['accessibility-error']} accessibility ${counts['accessibility-error'] === 1 ? 'error' : 'errors'}`,
    `${counts['needs-review']} to review`,
    `${counts.advisory} advisory`,
  ];
  return `Checks for revision ${report.stamp.sourceRevision}: ${parts.join(', ')} across six contexts.`;
}

export class ThemeChecksSession {
  report = $state.raw<AccessibilityReport | null>(null);
  running = $state(false);
  /** The text for the panel's polite live region. */
  announcement = $state('');

  readonly #evaluator: ThemeEvaluator;
  readonly #gate = new EvaluationGate();
  #requested: { themeId: string; revision: number } | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(evaluator: ThemeEvaluator) {
    this.#evaluator = evaluator;
  }

  /**
   * Ask for a report of a committed revision. Repeat asks for the same revision are ignored;
   * a new revision replaces any run in flight. The run happens after a short delay so a burst
   * of commits checks only the last one.
   */
  schedule(envelope: ThemeEnvelope, revision: number, delayMs = 150): void {
    const previous = this.#requested;
    if (previous?.themeId === envelope.id && previous.revision === revision) return;
    const announce = previous !== null && previous.themeId === envelope.id;
    this.#requested = { themeId: envelope.id, revision };
    this.running = true;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.run(envelope, revision, announce), delayMs);
  }

  /** Evaluate all six contexts, then build the report. Resolves `null` when overtaken. */
  async run(
    envelope: ThemeEnvelope,
    revision: number,
    announce = false,
  ): Promise<AccessibilityReport | null> {
    const evaluations: Partial<Record<ThemeContextId, ThemeEvaluation>> = {};
    for (const context of THEME_CONTEXT_IDS) {
      const response = await this.#gate.request(
        this.#evaluator,
        envelope.id,
        envelope,
        revision,
        context,
      );
      if (response === null) return null;
      evaluations[context] = response;
    }
    const report = buildAccessibilityReport({
      themeId: envelope.id,
      sourceRevision: revision,
      evaluations,
    });
    const latest = this.#requested;
    if (latest !== null && (latest.themeId !== envelope.id || latest.revision !== revision)) {
      return null;
    }
    this.report = report;
    this.running = false;
    if (announce) this.announcement = aggregateAnnouncement(report);
    return report;
  }

  /** A theme switch or unmount: drop everything in flight. */
  stop(): void {
    clearTimeout(this.#timer);
    this.#gate.invalidate();
    this.#requested = null;
    this.running = false;
  }
}

/** The numbers the toolbar shows. */
export function reportSummary(report: AccessibilityReport | null): { outstanding: number } {
  return { outstanding: report === null ? 0 : outstandingCount(countReport(report)) };
}
