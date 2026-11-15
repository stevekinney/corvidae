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
import {
  addControlId,
  bodyListAddress,
  bodyWhere,
  branchListAddress,
  branchWhere,
  caseListAddress,
  caseWhere,
  otherwiseListAddress,
  otherwiseWhere,
  ROOT_ADDRESS,
  stepAddress,
  stepFieldId,
  stepWhere,
} from './workflow-builder-addresses.ts';
import { readBuilder, type BuilderStep } from './workflow-builder-model.ts';

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
  | 'workflow'
  | 'on'
  | 'over'
  | 'empty-list'
  | 'no-cases'
  | 'no-branches'
  | 'steps';

/** One thing to fix. */
export interface WorkflowProblem {
  readonly kind: WorkflowProblemKind;
  /** The `id` of the control to focus: a field, or the Add a step control of the list that needs one. */
  readonly fieldId: string;
  /**
   * The one-based position of the top-level step it belongs to (the step that holds it, for a step
   * inside one), or `undefined` for a problem outside the steps.
   */
  readonly position?: number;
  /** The address of the step it belongs to (`3`, or `3-c1-2` inside one), which outlines that step. */
  readonly address?: string;
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
export const FIRST_ADD_BUTTON = addControlId(ROOT_ADDRESS);
const START_FIELD = 'workflow-builder-trigger-field';

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

  problems.push(...stepProblems(view.steps, ROOT_ADDRESS, undefined, undefined));
  return problems;
}

/**
 * The problems of the steps in one list and, below them, of every step they hold, in the order the
 * page reads. `list` is the list's address, `listWhere` its words (`undefined` for the workflow's
 * own), and `topPosition` the top-level step the list is inside (`undefined` for the workflow's own).
 */
function stepProblems(
  steps: readonly BuilderStep[],
  list: string,
  listWhere: string | undefined,
  topPosition: number | undefined,
): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  steps.forEach((step, index) => {
    const position = index + 1;
    const address = stepAddress(list, position);
    const where = stepWhere(listWhere, position);
    const top = topPosition ?? position;
    const at = (
      kind: WorkflowProblemKind,
      field: string,
      message: string,
      summary: string,
    ): WorkflowProblem => ({
      kind,
      fieldId: field,
      position: top,
      address,
      message,
      summary,
    });
    const atField = (kind: WorkflowProblemKind, field: string, message: string, summary: string) =>
      at(kind, stepFieldId(address, field), message, summary);
    if (step.kind === 'agent') {
      if (step.agent.trim() === '') {
        problems.push(atField('agent', 'agent', copy.agent, copy.summary.agent(where)));
      }
      if (step.message.trim() === '') {
        problems.push(atField('message', 'message', copy.message, copy.summary.message(where)));
      }
    } else if (step.kind === 'signal' && step.signal.trim() === '') {
      problems.push(atField('signal', 'signal', copy.signal, copy.summary.signal(where)));
    } else if (step.kind === 'wait' && step.parts !== null && step.parts.amount === '') {
      problems.push(atField('duration', 'duration', copy.duration, copy.summary.duration(where)));
    } else if (step.kind === 'workflow' && step.workflow.trim() === '') {
      problems.push(atField('workflow', 'workflow', copy.workflow, copy.summary.workflow(where)));
    } else if (step.kind === 'branch') {
      if (step.on.trim() === '') {
        problems.push(atField('on', 'on', copy.on, copy.summary.on(where)));
      }
      if (step.cases.length === 0) {
        problems.push(
          at(
            'no-cases',
            stepFieldId(address, 'add-case'),
            copy.noCases,
            copy.summary.noCases(where),
          ),
        );
      }
      step.cases.forEach((entry, caseIndex) => {
        problems.push(
          ...stepProblems(
            entry.steps,
            caseListAddress(address, caseIndex),
            caseWhere(entry.value, where),
            top,
          ),
        );
      });
      if (step.otherwise !== null) {
        problems.push(
          ...stepProblems(
            step.otherwise,
            otherwiseListAddress(address),
            otherwiseWhere(where),
            top,
          ),
        );
      }
    } else if (step.kind === 'parallel') {
      if (step.branches.length === 0) {
        problems.push(
          at(
            'no-branches',
            stepFieldId(address, 'add-branch'),
            copy.noBranches,
            copy.summary.noBranches(where),
          ),
        );
      }
      step.branches.forEach((branch, branchIndex) => {
        const listAddress = branchListAddress(address, branchIndex);
        const named = branchWhere(branch.name, where);
        if (branch.steps.length === 0) {
          problems.push(
            at(
              'empty-list',
              addControlId(listAddress),
              copy.emptyList,
              copy.summary.emptyList(named),
            ),
          );
        }
        problems.push(...stepProblems(branch.steps, listAddress, named, top));
      });
    } else if (step.kind === 'map') {
      if (step.over.trim() === '') {
        problems.push(atField('over', 'over', copy.over, copy.summary.over(where)));
      }
      const listAddress = bodyListAddress(address);
      const named = bodyWhere(where);
      if (step.steps.length === 0) {
        problems.push(
          at(
            'empty-list',
            addControlId(listAddress),
            copy.emptyList,
            copy.summary.emptyList(named),
          ),
        );
      }
      problems.push(...stepProblems(step.steps, listAddress, named, top));
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
