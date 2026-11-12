/**
 * What is wrong with a new workflow's text before Create workflow can send it (board
 * PageWorkflowBuilder, "Validation"): the ID, what starts it, and each step, in the order the page
 * reads. Each problem names the field it belongs to, so the builder can say it at the field and
 * focus the first one, and carries its short words for the one line above the footer. Plain
 * functions over text, so the problems are tested without a page.
 *
 * A step name is never a problem: it is optional, and empty it falls back to the step's kind.
 */
import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
import { createDefinitionFromText } from '../../lib/workflow-files.ts';
import { readBuilder } from './workflow-builder-model.ts';

/** Where a problem is on the page, which says how the builder shows it. */
export type WorkflowProblemKind =
  | 'id'
  | 'id-taken'
  | 'schedule'
  | 'start-signal'
  | 'agent'
  | 'message'
  | 'signal'
  | 'duration'
  | 'steps';

/** One thing to fix. */
export interface WorkflowProblem {
  readonly kind: WorkflowProblemKind;
  /** The `id` of the control to focus: a field, or the first of the Add a step buttons. */
  readonly fieldId: string;
  /** The one-based position of the step it belongs to, or `undefined` for a problem outside the steps. */
  readonly position?: number;
  /** Said at the field. */
  readonly message: string;
  /** Said in the line above the footer, from two problems. */
  readonly summary: string;
}

/** What `workflowProblems` needs besides the text. */
export interface WorkflowProblemOptions {
  /**
   * A new workflow's ID is checked; an existing workflow's is fixed, so an edit has none to check.
   */
  readonly mode: 'create' | 'edit';
  /** An ID the Bureau answered is already a file, so a text that still names it is a problem. */
  readonly takenId?: string;
}

const copy = WORKFLOW_COPY.builder.problems;
const creator = WORKFLOW_COPY.creator;

/** The id of the builder's ID field, and of the control a problem with no steps focuses. */
export const ID_FIELD = 'workflow-builder-name';
export const FIRST_ADD_BUTTON = 'workflow-builder-add-agent';
const START_FIELD = 'workflow-builder-trigger-field';

/** The id of a step's field of one kind (`agent`, `message`, `signal`, `duration`). */
export function stepFieldId(position: number, field: string): string {
  return `workflow-builder-step-${String(position)}-${field}`;
}

const ID_REASONS = {
  'no-name': creator.noName,
  'invalid-name': creator.invalidName,
  'reserved-name': creator.reservedName,
} as const;

function idProblem(text: string, takenId: string | undefined): WorkflowProblem | undefined {
  const parsed = createDefinitionFromText(text);
  if (!parsed.ok) {
    if (parsed.reason === 'not-json' || parsed.reason === 'not-object') return undefined;
    return {
      kind: 'id',
      fieldId: ID_FIELD,
      message: ID_REASONS[parsed.reason],
      summary: copy.summary.id,
    };
  }
  if (takenId !== undefined && parsed.id === takenId) {
    return {
      kind: 'id-taken',
      fieldId: ID_FIELD,
      message: creator.taken(parsed.id),
      summary: copy.summary.idTaken,
    };
  }
  return undefined;
}

/**
 * The problems in a new workflow's text, in the order the page reads: the ID, what starts it, then
 * each step, or the missing steps. Text the builder cannot read (not a JSON object) has none: the
 * JSON tab says what is wrong with it.
 */
export function workflowProblems(text: string, options: WorkflowProblemOptions): WorkflowProblem[] {
  const view = readBuilder(text);
  if (view === undefined) return [];
  const problems: WorkflowProblem[] = [];

  if (options.mode === 'create') {
    const id = idProblem(text, options.takenId);
    if (id !== undefined) problems.push(id);
  }

  if (view.trigger?.kind === 'schedule' && view.trigger.spec.trim() === '') {
    problems.push({
      kind: 'schedule',
      fieldId: START_FIELD,
      message: copy.schedule,
      summary: copy.summary.schedule,
    });
  } else if (view.trigger?.kind === 'signal' && view.trigger.name.trim() === '') {
    problems.push({
      kind: 'start-signal',
      fieldId: START_FIELD,
      message: copy.startSignal,
      summary: copy.summary.startSignal,
    });
  }

  // A `steps` that is not a list is left to the JSON tab, which says so; there is no list to add to.
  if (!view.stepsEditable) return problems;
  if (view.steps.length === 0) {
    problems.push({
      kind: 'steps',
      fieldId: FIRST_ADD_BUTTON,
      message: WORKFLOW_COPY.builder.noSteps,
      summary: copy.summary.steps,
    });
    return problems;
  }

  view.steps.forEach((step, index) => {
    const position = index + 1;
    if (step.kind === 'agent') {
      if (step.agent.trim() === '') {
        problems.push({
          kind: 'agent',
          fieldId: stepFieldId(position, 'agent'),
          position,
          message: copy.agent,
          summary: copy.summary.agent(position),
        });
      }
      if (step.message.trim() === '') {
        problems.push({
          kind: 'message',
          fieldId: stepFieldId(position, 'message'),
          position,
          message: copy.message,
          summary: copy.summary.message(position),
        });
      }
    } else if (step.kind === 'signal' && step.signal.trim() === '') {
      problems.push({
        kind: 'signal',
        fieldId: stepFieldId(position, 'signal'),
        position,
        message: copy.signal,
        summary: copy.summary.signal(position),
      });
    } else if (step.kind === 'wait' && step.parts !== null && step.parts.amount === '') {
      problems.push({
        kind: 'duration',
        fieldId: stepFieldId(position, 'duration'),
        position,
        message: copy.duration,
        summary: copy.summary.duration(position),
      });
    }
  });
  return problems;
}

/**
 * The line above the footer, or `undefined` for fewer than two problems: one problem is said at its
 * field and by the focus Create gives it, and needs no summary. "2 things to fix: Step 2: name the
 * signal. Step 3: write what to ask the agent."
 */
export function problemSummary(problems: readonly WorkflowProblem[]): string | undefined {
  if (problems.length < 2) return undefined;
  const items = problems.map((problem) => problem.summary).join(' ');
  return `${copy.summaryLead(problems.length)} ${items}`;
}
