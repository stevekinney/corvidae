import type { RevisionRow, RevisionState } from './model.ts';

/** What the workflow revision review shows. */
export type RevisionView = {
  /** `loading` until the proposal and the current definition are read, `failed` when they cannot be. */
  phase: 'loading' | 'ready' | 'failed';
  /** Where the review stands, while `phase` is `ready`. */
  state: RevisionState;
  /** Words that replace the state's own, such as the new hash after an apply. */
  message: string | undefined;
  /** The comparison, one row per part of the definition. */
  rows: RevisionRow[];
  /** How many rows differ. */
  changeCount: number;
};

/** A view the page updates and the component reads. */
export function createRevisionView(): RevisionView {
  const view: RevisionView = $state({
    phase: 'loading',
    state: 'loading',
    message: undefined,
    rows: [],
    changeCount: 0,
  });
  return view;
}
