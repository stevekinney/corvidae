/**
 * Internal Collapsible context: a Collapsible publishes that its panel is open to descendants, so a
 * Collapsible rendered inside that panel knows it is nested and drops its frame by default (a box
 * inside a box). The value carries no data; its presence is the signal.
 */

import { createContext } from 'svelte';

import { optionalContext } from './optional-context.ts';

const [getCollapsibleNestingContextStrict, setCollapsibleNestingContextRaw] = createContext<true>();

/** Mark every descendant Collapsible as nested. */
export function setCollapsibleNestingContext(): void {
  setCollapsibleNestingContextRaw(true);
}

/** Whether a Collapsible ancestor exists. */
export const getCollapsibleNestingContext: () => true | undefined = optionalContext(
  getCollapsibleNestingContextStrict,
);
