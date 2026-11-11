/**
 * Internal action-emphasis context, factored out of `page-header.svelte` so Button can read it
 * without importing a `.svelte` module path.
 *
 * A `<PageHeader error>` publishes that a full-page error is showing under it. A primary Button
 * under the header then draws as secondary, so "Try again" is the only primary on the page. A
 * Button outside any header, and every Button that is not primary, is untouched.
 */

import { createContext } from 'svelte';

import { optionalContext } from './optional-context.ts';

/**
 * Context published by `<PageHeader>` for the buttons under it. The field is a getter so reads
 * stay reactive inside a `$derived`; destructuring would freeze it.
 */
export type ActionEmphasisContextValue = {
  /** Whether a primary button under this context draws as secondary. */
  readonly demotePrimary: boolean;
};

const [getActionEmphasisContextStrict, setActionEmphasisContextRaw] =
  createContext<ActionEmphasisContextValue>();

/** Publish the action-emphasis context for descendant buttons. */
export function setActionEmphasisContext(context: ActionEmphasisContextValue): void {
  setActionEmphasisContextRaw(context);
}

/**
 * Read the nearest enclosing action-emphasis context. Returns `undefined` when there is none,
 * which is a supported state: a standalone button renders as asked.
 */
export const getActionEmphasisContext: () => ActionEmphasisContextValue | undefined =
  optionalContext(getActionEmphasisContextStrict);

/** The variant a button draws as: `primary` becomes `secondary` while the context demotes it. */
export function resolveActionVariant<Variant extends string>(
  context: ActionEmphasisContextValue | undefined,
  variant: Variant,
): Variant | 'secondary' {
  return context?.demotePrimary === true && variant === 'primary' ? 'secondary' : variant;
}
