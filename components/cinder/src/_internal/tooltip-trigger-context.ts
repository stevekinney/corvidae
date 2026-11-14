import { createContext } from 'svelte';

import { optionalContext } from './optional-context.ts';

/**
 * Context a wrapping `<Tooltip>` publishes for its trigger. A control that shows its own name in a
 * tooltip (CopyButton's icon face) reads it and leaves the tooltip to the page's when it is already
 * inside one, so a trigger never gets two bubbles at once.
 */
export type TooltipTriggerContext = {
  /** Always true: the trigger sits inside a Tooltip. */
  readonly insideTooltip: true;
};

const [getTooltipTriggerContextStrict, setTooltipTriggerContextRaw] =
  createContext<TooltipTriggerContext>();

/** Marks the children of a wrapping Tooltip as its trigger. */
export function setTooltipTriggerContext(): void {
  setTooltipTriggerContextRaw({ insideTooltip: true });
}

/** The context of the nearest wrapping Tooltip, or `undefined` outside one. */
export const getTooltipTriggerContext: () => TooltipTriggerContext | undefined = optionalContext(
  getTooltipTriggerContextStrict,
);
