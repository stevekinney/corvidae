/**
 * What the run comparison panel shows (COR-2544), as plain data: `bureau.runs.compare`'s answer read
 * into rows, and one step's differences read into what the page draws. The engine aligned the two
 * runs already; this only says what each aligned step is, with the one classification the run page
 * uses (`@lostgradient/interborough-plugin/run-comparison`), and has no DOM, so it is tested alone.
 */
import {
  classifyComparedStep,
  differingFields,
  parseSummary,
  type ComparedField,
  type ComparedSide,
  type ComparedStep,
  type ComparedStepKind,
} from '@lostgradient/interborough-plugin/run-comparison';

/** One page of `bureau.runs.compare`, or the pages joined. */
export type Comparison = {
  readonly runId: string;
  readonly sourceRunId: string;
  readonly forkPoint: number;
  readonly steps: readonly ComparedStep[];
  readonly nextCursor?: string | undefined;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSide(value: unknown): value is ComparedSide {
  return (
    isRecord(value) &&
    typeof value['operationType'] === 'string' &&
    typeof value['label'] === 'string' &&
    typeof value['status'] === 'string' &&
    typeof value['input'] === 'string' &&
    (value['output'] === undefined || typeof value['output'] === 'string')
  );
}

function isComparedStep(value: unknown): value is ComparedStep {
  return (
    isRecord(value) &&
    typeof value['index'] === 'number' &&
    typeof value['shared'] === 'boolean' &&
    (value['source'] === undefined || isSide(value['source'])) &&
    (value['fork'] === undefined || isSide(value['fork']))
  );
}

/** Whether `value` is what `bureau.runs.compare` answers: the host's call is the authority, this checks its shape. */
export function isComparison(value: unknown): value is Comparison {
  return (
    isRecord(value) &&
    typeof value['runId'] === 'string' &&
    typeof value['sourceRunId'] === 'string' &&
    typeof value['forkPoint'] === 'number' &&
    Array.isArray(value['steps']) &&
    value['steps'].every(isComparedStep) &&
    (value['nextCursor'] === undefined || typeof value['nextCursor'] === 'string')
  );
}

/**
 * The server's message for an error result. A Bureau tool fault is structured content with a
 * `message` (the MCP adapter writes the same fault as JSON text beside it), so that is the message;
 * a result that carries none is read as the text of its text blocks.
 */
export function resultMessage(result: {
  content?: unknown;
  structuredContent?: unknown;
}): string | undefined {
  const fault = result.structuredContent;
  if (isRecord(fault) && typeof fault['message'] === 'string' && fault['message'] !== '') {
    return fault['message'];
  }
  if (!Array.isArray(result.content)) return undefined;
  const text = result.content
    .map((block: unknown) =>
      isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string'
        ? block['text']
        : '',
    )
    .filter((part) => part !== '')
    .join('\n');
  return text === '' ? undefined : text;
}

/** The fields' words, as a row says what differs. */
const FIELD_WORDS: Record<ComparedField, string> = {
  operation: 'operation',
  label: 'name',
  status: 'status',
  input: 'input',
  output: 'output',
};

/** The words for each kind of step. */
export const KIND_WORDS: Record<ComparedStepKind, string> = {
  shared: 'Shared',
  changed: 'Changed',
  unchanged: 'Same',
  'source-only': 'Only in the source',
  'fork-only': 'Only in the fork',
};

/** One step as a list row draws it. */
export type StepRow = {
  readonly index: number;
  /** `Step 2, issueTicket`: the step's place among the run's steps, from 1, and its name. */
  readonly title: string;
  readonly kind: ComparedStepKind;
  /** What differs, for a step both runs ran and the entries differ in. */
  readonly differs: string | undefined;
  readonly step: ComparedStep;
};

export type ComparisonModel = {
  readonly title: string;
  readonly intro: string;
  /** The steps before the fork point, which the fork kept. */
  readonly shared: readonly StepRow[];
  /** The steps the fork ran again, or the source ran and the fork has not reached. */
  readonly ranAgain: readonly StepRow[];
};

function rowOf(step: ComparedStep): StepRow {
  const side = step.fork ?? step.source;
  const kind = classifyComparedStep(step);
  const fields =
    step.source !== undefined && step.fork !== undefined && !step.shared
      ? differingFields(step.source, step.fork)
      : [];
  return {
    index: step.index,
    title: `Step ${String(step.index + 1)}, ${side?.label ?? ''}`,
    kind,
    differs:
      fields.length === 0
        ? undefined
        : `Differs in ${fields.map((f) => FIELD_WORDS[f]).join(', ')}`,
    step,
  };
}

/** The comparison as the page draws it: the shared steps apart from the steps the fork ran again. */
export function buildComparisonModel(comparison: Comparison): ComparisonModel {
  const rows = comparison.steps.map(rowOf);
  return {
    title: `Run ${comparison.runId} compared with ${comparison.sourceRunId}`,
    intro: `Forked from checkpoint step ${String(comparison.forkPoint)}. The steps before it keep the source’s results; the rest ran again.`,
    shared: rows.filter((row) => row.step.shared),
    ranAgain: rows.filter((row) => !row.step.shared),
  };
}

/** One of a step's two payloads, ready to draw. */
export type PayloadDifference =
  | { readonly heading: string; readonly kind: 'note'; readonly note: string }
  | {
      readonly heading: string;
      readonly kind: 'diff';
      /** The source's summary read as JSON. */
      readonly before: unknown;
      /** The fork's summary read as JSON. */
      readonly after: unknown;
    };

/** What a selected step shows: a note when the step has no pair to compare, else its payloads' differences. */
export type StepDetail = {
  readonly index: number;
  readonly heading: string;
  readonly notes: readonly string[];
  readonly payloads: readonly PayloadDifference[];
};

function payloadOf(
  heading: string,
  source: string | undefined,
  fork: string | undefined,
): PayloadDifference {
  const word = heading.toLowerCase();
  if (source === undefined && fork === undefined) {
    return { heading, kind: 'note', note: `The ${word} is the same in both runs.` };
  }
  if (source === undefined) {
    return { heading, kind: 'note', note: `The source has not recorded an ${word} for this step.` };
  }
  if (fork === undefined) {
    return { heading, kind: 'note', note: `The fork has not recorded an ${word} for this step.` };
  }
  if (source === fork) {
    return { heading, kind: 'note', note: `The ${word} is the same in both runs.` };
  }
  return { heading, kind: 'diff', before: parseSummary(source), after: parseSummary(fork) };
}

/** Read one ran-again step into what the page shows beside the list. */
export function stepDetail(step: ComparedStep): StepDetail {
  const heading = `Step ${String(step.index + 1)} differences`;
  if (step.source === undefined || step.fork === undefined) {
    return {
      index: step.index,
      heading,
      notes: [
        step.source === undefined
          ? 'The source never reached this step.'
          : 'The fork has not reached this step.',
      ],
      payloads: [],
    };
  }
  const notes: string[] = [];
  if (step.source.operationType !== step.fork.operationType) {
    notes.push(
      `${step.source.operationType} in the source, ${step.fork.operationType} in the fork`,
    );
  }
  if (step.source.status !== step.fork.status) {
    notes.push(`${step.source.status} in the source, ${step.fork.status} in the fork`);
  }
  return {
    index: step.index,
    heading,
    notes,
    payloads: [
      payloadOf('Input', step.source.input, step.fork.input),
      payloadOf('Output', step.source.output, step.fork.output),
    ],
  };
}
