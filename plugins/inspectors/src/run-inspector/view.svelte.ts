import type { InspectorModel } from './model.ts';

/** What the run inspector shows, and what it has just said to the live region. */
export type InspectorView = {
  /** The run as the page last read it, or `undefined` until the first read. */
  model: InspectorModel | undefined;
  /** What the polite live region says now. It outlives every change of the model. */
  announcement: string;
  /**
   * Why there is no run to show, when the page was opened on a run that is not an agent run: a
   * workflow instance has no task to inspect, and the page says so in words of its own.
   */
  notice: string | undefined;
};

/** A view the page updates and the component reads: a change to either field redraws the page. */
export function createInspectorView(): InspectorView {
  const view: InspectorView = $state({
    model: undefined,
    announcement: '',
    notice: undefined,
  });
  return view;
}
