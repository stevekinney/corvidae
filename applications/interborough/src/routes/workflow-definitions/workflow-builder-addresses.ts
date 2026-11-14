/**
 * Where a step is on the builder's page, written so no two steps share it. A top-level step is its
 * one-based position (`3`), and a step inside it adds the list it is in and its position there:
 * `3-c1-2` is the second step of the first case of step 3, `3-o-1` the first of its otherwise path,
 * `3-b2-1` the first of its second list, and `3-s-1` the first of its repeated steps. The address
 * makes the ids of a step's fields (`workflow-builder-step-3-c1-2-agent`), and the top-level ones stay
 * what they always were. A case or list is counted by its place, never its name, so renaming one
 * changes no id and a typed name never moves the focus.
 *
 * The words that name a step to a person ("step 2 of the approved case of step 3") are built beside
 * the address, from the same walk, so a label and an id can never name different steps.
 */
import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';

const where = WORKFLOW_COPY.builder.where;

/** The address of the workflow's own list of steps, which a list address is added to. */
export const ROOT_ADDRESS = '';

/** The address of the step at the one-based `position` in the list at `list` (`''` is the workflow's own). */
export function stepAddress(list: string, position: number): string {
  return list === ROOT_ADDRESS ? String(position) : `${list}-${String(position)}`;
}

/** The address of the list a `branch` runs for its case at `index` (zero-based). */
export function caseListAddress(step: string, index: number): string {
  return `${step}-c${String(index + 1)}`;
}

/** The address of the list a `branch` runs when no case matches. */
export function otherwiseListAddress(step: string): string {
  return `${step}-o`;
}

/** The address of the list a `parallel` runs for its branch at `index` (zero-based). */
export function branchListAddress(step: string, index: number): string {
  return `${step}-b${String(index + 1)}`;
}

/** The address of the steps a `map` repeats. */
export function bodyListAddress(step: string): string {
  return `${step}-s`;
}

/** The id of a step's field of one kind (`agent`, `message`, `signal`, `duration`, ...). */
export function stepFieldId(address: string | number, field: string): string {
  return `workflow-builder-step-${String(address)}-${field}`;
}

/** The id of the control that adds a step to the list at `list`, which a problem with the list focuses. */
export function addControlId(list: string): string {
  return list === ROOT_ADDRESS ? 'workflow-builder-add' : `workflow-builder-add-${list}`;
}

/** What a step is called: "step 3", or "step 2 of the approved case of step 3" when it is inside one. */
export function stepWhere(listWhere: string | undefined, position: number): string {
  return listWhere === undefined ? where.step(position) : where.nested(position, listWhere);
}

/** What a case's list is called, given the words for its `branch` step. */
export function caseWhere(value: string, step: string): string {
  return where.caseOf(value, step);
}

/** What a `branch`'s otherwise list is called. */
export function otherwiseWhere(step: string): string {
  return where.otherwiseOf(step);
}

/** What a `parallel`'s list is called. */
export function branchWhere(name: string, step: string): string {
  return where.branchOf(name, step);
}

/** What a `map`'s repeated steps are called. */
export function bodyWhere(step: string): string {
  return where.bodyOf(step);
}
