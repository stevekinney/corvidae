/**
 * The theme envelope and draft shapes shared by the draft, history, library and storage
 * modules (COR-490). The envelope is the lossless interchange form: authored DTCG source
 * nodes, never flattened values. Nothing here touches the network.
 */

import type { ThemePreviewContext } from './theme-preview-message.ts';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const THEME_FORMAT = 'com.lostgradient.cinder.theme';
export const THEME_VERSION = 1;

export const OVERRIDE_SCOPES = ['shared', 'light', 'dark', 'reduced', 'forcedReduced'] as const;
export type OverrideScope = (typeof OVERRIDE_SCOPES)[number];

/** A concrete context id, as used by the authoring catalogue (for example `dark/reduced`). */
export type ThemeContextId =
  | 'light/default'
  | 'light/reduced'
  | 'light/forced-reduced-motion'
  | 'dark/default'
  | 'dark/reduced'
  | 'dark/forced-reduced-motion';

export const THEME_CONTEXT_IDS: readonly ThemeContextId[] = [
  'light/default',
  'light/reduced',
  'light/forced-reduced-motion',
  'dark/default',
  'dark/reduced',
  'dark/forced-reduced-motion',
];

export function contextId(context: ThemePreviewContext): ThemeContextId {
  return `${context.colorMode}/${context.motion}`;
}

/** The immutable Cinder base a theme embeds. Matches the token runtime's base corpus. */
export type ThemeBase = {
  packageVersion: string;
  sourceDigest: string;
  resolver: JsonValue;
  documents: Record<string, JsonValue>;
};

/** DTCG source nodes by scope, keyed in the tree by the dotted public token path. */
export type ThemeOverrides = Record<OverrideScope, JsonObject>;

/** CSS-only edits: public token path, then concrete context, then the CSS value. */
export type CssOverrides = Record<string, Partial<Record<ThemeContextId, string>>>;

export type ThemeEnvelope = {
  format: typeof THEME_FORMAT;
  version: typeof THEME_VERSION;
  id: string;
  name: string;
  base: ThemeBase;
  overrides: ThemeOverrides;
  cssOverrides: CssOverrides;
  /**
   * Token paths the author locked (COR-489): scale presets and the foundation editors leave
   * them alone. Sorted, and absent while nothing is locked.
   */
  locked?: readonly string[];
};

/** What an edit changes and history restores; the base and identity never move. */
export type EditableState = {
  overrides: ThemeOverrides;
  cssOverrides: CssOverrides;
  locked?: readonly string[];
};

/** Partial input kept apart from the last-valid source revision. */
export type InputBufferEntry = { text: string; error: string | null };

export type ThemeDraft = {
  envelope: ThemeEnvelope;
  /** The last-valid source revision; it only ever grows. */
  revision: number;
  /** The revision last known to be persisted, or `null` when never saved. */
  savedRevision: number | null;
  /** Invalid or partial field text by `inputKey`, never read by preview or validation. */
  inputBuffer: Record<string, InputBufferEntry>;
  /** True when the input buffer changed since the last successful save. */
  unsavedInput: boolean;
};

export function emptyOverrides(): ThemeOverrides {
  return { shared: {}, light: {}, dark: {}, reduced: {}, forcedReduced: {} };
}

export function editableState(envelope: ThemeEnvelope): EditableState {
  return {
    overrides: envelope.overrides,
    cssOverrides: envelope.cssOverrides,
    ...(envelope.locked === undefined ? {} : { locked: envelope.locked }),
  };
}

export function isDirty(draft: ThemeDraft): boolean {
  return draft.savedRevision !== draft.revision || draft.unsavedInput;
}

/** True when the buffer diverges from the last-valid revision, so preview reads are stale. */
export function previewIsStale(draft: ThemeDraft): boolean {
  return Object.keys(draft.inputBuffer).length > 0;
}

export function inputKey(path: string, context: ThemeContextId | 'source'): string {
  return `${path}@${context}`;
}
