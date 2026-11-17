import type { InspectorModel } from './model.ts';

/** What the run inspector shows, and what it has just said to the live region. */
export type InspectorView = {
  /** The run as the page last read it, or `undefined` until the first read. */
  model: InspectorModel | undefined;
  /** What the polite live region says now. It outlives every change of the model. */
  announcement: string;
};

/** A view the page updates and the component reads: a change to either field redraws the page. */
export function createInspectorView(): InspectorView {
  const view: InspectorView = $state({ model: undefined, announcement: '' });
  return view;
}
