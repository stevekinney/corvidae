/**
 * What every rendered A2UI node shares with its surface: the component map,
 * the data model, the host's callbacks, and a diagnostic sink that reports
 * each distinct problem once.
 */
import { getContext, setContext } from 'svelte';

import type { A2uiDataModel } from './data-model.svelte.ts';
import type {
  A2uiAction,
  A2uiAssetUrlResolver,
  A2uiComponent,
  A2uiDiagnosticCode,
} from './types.ts';

/** The surface-wide state a node renders with. */
export type A2uiRenderContext = {
  readonly surfaceId: string;
  /** The surface's components by id. */
  readonly component: (id: string) => A2uiComponent | undefined;
  readonly model: A2uiDataModel;
  readonly locale: string | undefined;
  /** A prefix that makes generated element ids unique to this surface. */
  readonly idPrefix: string;
  readonly dispatch: (action: A2uiAction) => void;
  readonly resolveAssetUrl: A2uiAssetUrlResolver | undefined;
  readonly releaseAssetUrl: (resolvedUrl: string) => void;
  /** Reports a problem once per code, component, and message. */
  readonly report: (
    code: A2uiDiagnosticCode,
    componentId: string | undefined,
    message: string,
  ) => void;
};

const KEY = Symbol('a2ui-render-context');

/** Provides the render context to a surface's nodes. */
export function setA2uiRenderContext(context: A2uiRenderContext): void {
  setContext(KEY, context);
}

/** The render context of the surface this node belongs to. */
export function getA2uiRenderContext(): A2uiRenderContext {
  const context = getContext<A2uiRenderContext | undefined>(KEY);
  if (context === undefined) throw new Error('An A2UI node must render inside A2uiSurface.');
  return context;
}
