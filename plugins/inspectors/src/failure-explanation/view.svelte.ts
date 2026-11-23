import type { ExplanationModel } from '@lostgradient/interborough-plugin/failure-explanation';

import type { Refusal } from './model.ts';

/**
 * What the page is showing, and no more: no run named yet, the read in flight, the Bureau's
 * explanation, the Bureau's refusal to give one (a run that did not fail is one), or a read that got
 * no answer from the host.
 */
export type ExplanationState =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'reading'; readonly runId: string }
  | { readonly kind: 'explained'; readonly model: ExplanationModel }
  | { readonly kind: 'refused'; readonly refusal: Refusal }
  | { readonly kind: 'unreadable'; readonly reason: 'no-answer' | 'no-server-tools' };

/** What the failure explanation page shows, and what it has just said to the live region. */
export type ExplanationView = {
  state: ExplanationState;
  /** What the polite live region says now. It outlives every change of the state. */
  announcement: string;
};

/** A view the page updates and the component reads: a change to either field redraws the page. */
export function createExplanationView(): ExplanationView {
  const view: ExplanationView = $state({ state: { kind: 'waiting' }, announcement: '' });
  return view;
}
