/**
 * Why a run failed, drawn once (COR-2533, COR-2543): the words of the answer `bureau.tasks.explain`
 * gives, which the Run page and the failure explanation panel both draw, with the one component
 * that draws them (`failure-explanation.svelte`). The Bureau's sentence leads, the facts follow
 * (the cause, the step, how often it was tried, the guardrails that fired), and what to do next
 * comes last, with the same labels and the same guardrail wording on both surfaces.
 *
 * Nothing here words a cause: the sentence and the remediation are the server's. This module only
 * names the facts and the badge that draws the category. It imports nothing, so a panel's bundle
 * takes none of this package's server code.
 *
 * @module failure-explanation
 */

/** One guardrail that fired in the run. */
export interface ExplanationVerdict {
  readonly name: string;
  readonly kind: 'guardrail' | 'tripwire';
  readonly outcome: 'tripwire' | 'block' | 'warn' | 'sanitize' | 'redact';
  /** The step it fired at, counted from zero, or `null`. */
  readonly step: number | null;
}

/** What `bureau.tasks.explain` answers for a failed run. */
export interface Explanation {
  readonly summary: string;
  readonly cause: {
    readonly category: string | null;
    readonly code: string | null;
    readonly kind: string | null;
  };
  /** The step the run failed at, counted from zero, or `null` when none was recorded. */
  readonly step: { readonly index: number; readonly label: string } | null;
  readonly tries: number | null;
  readonly verdicts: readonly ExplanationVerdict[];
  readonly remediation: string;
  readonly nextCommands: readonly string[];
}

/** A badge's tone, in the words Cinder's `Badge` uses. */
export type FailureCategoryTone = 'neutral' | 'warning' | 'danger';

/** The labels both surfaces draw the answer under. */
export const FAILURE_EXPLANATION_LABELS = {
  region: 'Why this run failed',
  cause: 'Cause',
  step: 'Step',
  tries: 'Tries',
  guardrails: 'Guardrails',
  next: 'What to do next',
} as const;

/** Sentence-case-safe badge label for a failure category; `uncategorized` for a failure nothing classifies. */
export function failureCategoryLabel(category: string | null | undefined): string {
  if (category === undefined) return '';
  return category === null ? 'uncategorized' : category;
}

/**
 * The badge's tone. A cancellation is a person's doing and reads quietly; a deadline or a spent
 * limit is a warning; a fault in the code or the server, and a failure nothing classifies, is
 * danger.
 */
export function failureCategoryTone(category: string | null | undefined): FailureCategoryTone {
  switch (category) {
    case 'cancellation':
      return 'neutral';
    case 'timeout':
    case 'resource':
      return 'warning';
    default:
      return 'danger';
  }
}

const OUTCOME_WORDS = {
  tripwire: 'stopped the run',
  block: 'blocked the step',
  warn: 'warned',
  sanitize: 'sanitized the step',
  redact: 'redacted the step',
} as const;

/** What the component draws of an explanation: each part as the words a person reads. */
export interface ExplanationModel {
  /** The Bureau's sentence, which leads. */
  readonly summary: string;
  /** The category, in the badge's words. */
  readonly category: string | null;
  /**
   * The error's code, only when it names something a person can act on. `UNKNOWN` is the engine
   * saying it has no code, and the kind of error is already in the sentence, so neither is shown.
   */
  readonly causeDetail: string;
  /** The step the run failed at, by its label alone: the index counts the engine's steps, not a page's. */
  readonly step: string | null;
  /** How many times the engine tried that step, or `null` when it kept no history. */
  readonly tries: string | null;
  /** One line for each guardrail that fired, in the order read. */
  readonly verdicts: readonly string[];
  /** The Bureau's next step. */
  readonly remediation: string;
}

/** The lines the component draws for `explanation`. */
export function buildExplanationModel(explanation: Explanation): ExplanationModel {
  const { cause, step } = explanation;
  return {
    summary: explanation.summary,
    category: cause.category,
    causeDetail: cause.code === null || cause.code === 'UNKNOWN' ? '' : `code ${cause.code}`,
    step: step === null ? null : step.label,
    tries: explanation.tries === null ? null : String(explanation.tries),
    verdicts: explanation.verdicts.map(
      (verdict) => `${verdict.name} ${OUTCOME_WORDS[verdict.outcome]}`,
    ),
    remediation: explanation.remediation,
  };
}
