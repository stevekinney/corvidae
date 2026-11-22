/**
 * Why a run failed, in words, from what Bureau stored about it (COR-2532): the one answer
 * `bureau.tasks.explain` serves on every surface.
 *
 * Nothing here calls a model or reads a clock. The same facts give the same explanation, and the
 * text is built only from identifiers: the failure category, the error's code and kind, the step's
 * label. A tool's arguments, an error's message and a stack are never facts here, so they cannot
 * reach a sentence.
 *
 * @module run-failure-explanation
 */

import type { FailureCategory } from '@lostgradient/weft';
import type { AgentRunErrorKind } from '@lostgradient/operative';

/** The five categories the engine sorts a failure into, in a fixed order. */
export const RUN_FAILURE_CATEGORIES = [
  'application',
  'timeout',
  'cancellation',
  'resource',
  'system',
] as const satisfies readonly FailureCategory[];

/** How a run's guardrail verdict came out: a tripwire halts the run; the rest let it go on. */
export const RUN_VERDICT_OUTCOMES = ['tripwire', 'block', 'warn', 'sanitize', 'redact'] as const;

/** One guardrail that fired in a run. */
export interface RunVerdict {
  /** The guardrail's name. */
  readonly name: string;
  /** `tripwire` for a guardrail that halted the run, `guardrail` for one that let it go on. */
  readonly kind: 'guardrail' | 'tripwire';
  /** What it did: `tripwire` for a halt, else what a validate-mode guardrail did to the step. */
  readonly outcome: (typeof RUN_VERDICT_OUTCOMES)[number];
  /** The step it fired at, or `null` when the record names none. */
  readonly step: number | null;
}

/** The step a failed run stopped at. */
export interface RunFailureStep {
  /** The step's index in the run, from zero. */
  readonly index: number;
  /** The step's label: a tool's name, `model`, or for a workflow the engine's label. */
  readonly label: string;
}

/** What Bureau stored about a failed run, and nothing else. */
export interface RunFailureFacts {
  /** `agent` for a task's run, `workflow` for an instance of a workflow file. */
  readonly kind: 'agent' | 'workflow';
  /** The run's identifier, for the commands that read it. */
  readonly runId: string;
  /** The failure's category, or `null` when nothing classifies it. */
  readonly category: FailureCategory | null;
  /** The error's code, or `null`. */
  readonly code: string | null;
  /** The error's kind, or `null`. */
  readonly errorKind: string | null;
  /** The step it failed at, or `null` when none was recorded. */
  readonly step: RunFailureStep | null;
  /** How many times the engine tried the step the run failed at, or `null` when it recorded none. */
  readonly tries: number | null;
  /** The guardrails that fired, in the order they were read. */
  readonly verdicts: readonly RunVerdict[];
  /**
   * Whether `bureau.workflows.runs.retry` would run this instance again for the caller: a failed
   * instance of a workflow file that failed at a step that can run again (COR-2533).
   */
  readonly retryable: boolean;
}

/** What `bureau.tasks.explain` answers. */
export interface RunFailureExplanation {
  readonly summary: string;
  readonly cause: {
    readonly category: FailureCategory | null;
    readonly code: string | null;
    readonly kind: string | null;
  };
  readonly step: RunFailureStep | null;
  readonly tries: number | null;
  readonly verdicts: readonly RunVerdict[];
  readonly remediation: string;
  readonly nextCommands: readonly string[];
}

/**
 * The category of an agent run that failed, from what its task stored: the run's finish reason and
 * its error's kind. The engine sorts a workflow's failure into a category, but an agent run ends as
 * a completed engine run that carries a failed result, so the engine holds none for it.
 *
 * A run Bureau itself settled as `timed-out` or `deadline-exceeded` is a `timeout`; one it settled
 * as `owner-lost` lost the process that ran it, a `system` fault; a spent budget or the step limit
 * is a `resource` limit; an error of kind `abort` is a `cancellation`; and an error, a tripwire or a
 * denied elicitation is an `application` failure. Any other finish reason is `null`: a failure
 * nothing classifies is said so rather than guessed.
 */
export function classifyAgentRunFailure(stored: {
  readonly finishReason: string | null;
  readonly errorKind: string | null;
}): FailureCategory | null {
  switch (stored.finishReason) {
    case 'timed-out':
    case 'deadline-exceeded':
      return 'timeout';
    case 'owner-lost':
      return 'system';
    case 'budget-exceeded':
    case 'maximum-steps':
      return 'resource';
    case 'error':
    case 'tripwire':
    case 'elicitation-denied':
      return stored.errorKind === 'abort' ? 'cancellation' : 'application';
    default:
      return null;
  }
}

/** The clause a category gives a summary; `null` is a failure the engine could not classify. */
const CATEGORY_CAUSE: Readonly<Record<FailureCategory | 'unclassified', string>> = {
  application: 'because the code it ran raised an error',
  timeout: 'because it ran past its deadline',
  cancellation: 'because it was cancelled',
  resource: 'because a quota or capacity limit was exceeded',
  system: 'because of a fault in the server, its storage or a worker',
  unclassified: 'for a reason that could not be classified',
};

/** The clause an error kind adds to a summary, for the kinds Operative names. */
const KIND_CLAUSE: Readonly<Record<AgentRunErrorKind, string>> = {
  load: ' while loading the agent',
  contract: ' while checking the agent’s contract',
  generate: ' while asking the model for a reply',
  tool: ' while running a tool',
  abort: ' after the run was aborted',
  output: ' while checking the answer against its output schema',
  policy: ' when a policy halted it',
};

/** What to do next, one line a category, written without naming a command that may not exist. */
const CATEGORY_REMEDIATION: Readonly<Record<FailureCategory | 'unclassified', string>> = {
  application:
    'Read the run’s failure message, fix the input or the code the step ran, and start the run again.',
  timeout:
    'Check whether the step is slow or its deadline is too short; fix the cause or lengthen the deadline, then start the run again.',
  cancellation:
    'Find out who cancelled the run and why; start it again if the cancellation was not intended.',
  resource:
    'Free or raise the quota, memory or capacity the step ran out of, then start the run again.',
  system:
    'Check the Bureau’s storage and workers for the fault; start the run again once they are healthy.',
  unclassified:
    'Read the run’s failure message to find the cause, fix it, and start the run again.',
};

const TRIPWIRE_REMEDIATION =
  ' A guardrail halted this run: review the guardrail named in `verdicts` before starting it again.';

/** A label as one line of text: control characters and runs of whitespace become one space. */
function oneLine(label: string): string {
  return label.replace(/[\p{Cc}\s]+/gu, ' ').trim();
}

/** Whether `kind` is one Operative names, so a stored value that is not cannot pick a clause. */
function isKnownKind(kind: string | null): kind is AgentRunErrorKind {
  return kind !== null && Object.hasOwn(KIND_CLAUSE, kind);
}

/**
 * One sentence that names the step and the cause: a template for the category, then a template for
 * the error kind, over the step's label.
 */
function summarizeRunFailure(facts: {
  readonly category: FailureCategory | null;
  readonly errorKind: string | null;
  readonly step: RunFailureStep | null;
}): string {
  const label = facts.step === null ? '' : oneLine(facts.step.label);
  const subject = label === '' ? 'The run' : `The step "${label}"`;
  const cause = CATEGORY_CAUSE[facts.category ?? 'unclassified'];
  const kind = isKnownKind(facts.errorKind) ? KIND_CLAUSE[facts.errorKind] : '';
  return `${subject} failed ${cause}${kind}.`;
}

/** A token the shell reads as one word, quoted only when it has to be. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9._:@%+=,/-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The `interborough` command lines for a run. Every entry is a command the CLI has: `runs get`
 * reads either kind of run, named by `--kind`, and `runs retry` runs an instance again from the step
 * it failed at, which is offered only for an instance a retry accepts (COR-2533).
 */
function nextCommandsFor(
  kind: 'agent' | 'workflow',
  runId: string,
  retryable: boolean,
): readonly string[] {
  const id = shellWord(runId);
  return [
    `interborough runs get --kind ${kind === 'agent' ? 'task' : 'workflow'} ${id}`,
    ...(kind === 'workflow' && retryable ? [`interborough runs retry ${id}`] : []),
  ];
}

/** The explanation of a failed run: the same facts always give the same answer. */
export function explainRunFailure(facts: RunFailureFacts): RunFailureExplanation {
  const halted = facts.verdicts.some((verdict) => verdict.kind === 'tripwire');
  return {
    summary: summarizeRunFailure(facts),
    cause: { category: facts.category, code: facts.code, kind: facts.errorKind },
    step: facts.step,
    tries: facts.tries,
    verdicts: facts.verdicts,
    remediation: `${CATEGORY_REMEDIATION[facts.category ?? 'unclassified']}${halted ? TRIPWIRE_REMEDIATION : ''}`,
    nextCommands: nextCommandsFor(facts.kind, facts.runId, facts.retryable),
  };
}
