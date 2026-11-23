/**
 * How a fork and its source are compared, step by step: which steps are shared, which differ, and
 * what a step's input and output summaries hold once read as JSON.
 *
 * The engine aligns the two runs (`weft.workflows.compare`, and `bureau.runs.compare` over it), so
 * nothing here aligns anything: it reads one aligned step and says what kind of step it is. It lives
 * in the package both the Interborough app and a plugin's panel depend on, so the run page and the
 * run comparison panel classify a step with one function
 * (`@lostgradient/interborough-plugin/run-comparison`). The module imports nothing, so a panel's
 * bundle takes none of this package's server code.
 *
 * @module run-comparison
 */

/** One side of a compared step, as `weft.workflows.compare` and `bureau.runs.compare` serve it. */
export interface ComparedSide {
  /** The operation kind, such as `activity`, `sleep` or `wait-signal`. */
  readonly operationType: string;
  /** The operation's label: an activity's name, a signal's name, and so on. */
  readonly label: string;
  /** `running`, `completed`, `failed`, `cancelled` or `timed-out`. */
  readonly status: string;
  /** The step's input as the engine summarizes it: JSON text, with payload fields redacted. */
  readonly input: string;
  /** The step's output or error in the same form; absent while the step runs. */
  readonly output?: string | undefined;
}

/** One durable step of a fork aligned with the same step of its source. */
export interface ComparedStep {
  /** The durable step index both sides share. */
  readonly index: number;
  /** Whether the step is before the fork point, so both sides are the source's entry. */
  readonly shared: boolean;
  /** The source run's entry for the step. */
  readonly source?: ComparedSide | undefined;
  /** The fork's entry for the step. */
  readonly fork?: ComparedSide | undefined;
}

/**
 * What a step is when the two runs are read side by side:
 *
 * - `shared`: before the fork point, so the fork kept the source's result.
 * - `changed`: both runs ran it and the two entries differ.
 * - `unchanged`: both runs ran it and the two entries are the same.
 * - `source-only`: only the source has an entry, because the fork has not reached the step.
 * - `fork-only`: only the fork has an entry, because the source never reached the step.
 */
export type ComparedStepKind = 'shared' | 'changed' | 'unchanged' | 'source-only' | 'fork-only';

/** The parts of a step's entry that can differ between the two runs. */
export type ComparedField = 'operation' | 'label' | 'status' | 'input' | 'output';

/** The fields of the two entries that differ, in the order a reader meets them. */
export function differingFields(source: ComparedSide, fork: ComparedSide): ComparedField[] {
  const fields: ComparedField[] = [];
  if (source.operationType !== fork.operationType) fields.push('operation');
  if (source.label !== fork.label) fields.push('label');
  if (source.status !== fork.status) fields.push('status');
  if (source.input !== fork.input) fields.push('input');
  if (source.output !== fork.output) fields.push('output');
  return fields;
}

/** Which kind of step `step` is. */
export function classifyComparedStep(step: ComparedStep): ComparedStepKind {
  if (step.shared) return 'shared';
  if (step.source === undefined) return 'fork-only';
  if (step.fork === undefined) return 'source-only';
  return differingFields(step.source, step.fork).length === 0 ? 'unchanged' : 'changed';
}

/**
 * A summary read as the JSON it holds, so two summaries compare by structure. The engine writes a
 * summary as JSON text, but a value it could not serialize is a plain string such as `undefined`,
 * so text that is not JSON is returned as it is, never refused.
 */
export function parseSummary(summary: string): unknown {
  try {
    return JSON.parse(summary) as unknown;
  } catch {
    return summary;
  }
}
