/**
 * Internal context a Card publishes to its descendants: the content already sits in a frame, so a
 * Table inside it draws none of its own by default (a box inside a box). The value carries no data;
 * its presence is the signal.
 */

import { createContext } from 'svelte';

import { optionalContext } from './optional-context.ts';

const [getFramedSurfaceContextStrict, setFramedSurfaceContextRaw] = createContext<true>();

/** Mark every descendant Table as sitting in a framed surface. */
export function setFramedSurfaceContext(): void {
  setFramedSurfaceContextRaw(true);
}

/** Whether a framed surface (a Card) is an ancestor. */
export const getFramedSurfaceContext: () => true | undefined = optionalContext(
  getFramedSurfaceContextStrict,
);
