import type { ComparisonModel } from './model.ts';

/** What the run comparison panel shows. */
export type ComparisonView = {
  /**
   * `loading` until the comparison is read; `ready` once it is; `message` when the server refused to
   * compare the run and said why; `failed` when the page could not ask at all.
   */
  phase: 'loading' | 'ready' | 'message' | 'failed';
  /** The comparison, while `phase` is `ready`. */
  model: ComparisonModel | undefined;
  /** The server's own words, while `phase` is `message`: a run that is not a fork says what to do. */
  message: string | undefined;
  /** The step the reader opened, by its index, or `undefined` before one is. */
  selectedIndex: number | undefined;
};

/** A view the page updates and the component reads: a change to any field redraws the page. */
export function createComparisonView(): ComparisonView {
  const view: ComparisonView = $state({
    phase: 'loading',
    model: undefined,
    message: undefined,
    selectedIndex: undefined,
  });
  return view;
}
