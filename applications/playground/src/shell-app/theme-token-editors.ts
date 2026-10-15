/**
 * The seam between the editor slot and the editors that fill it. The generic `$value` field is
 * the fallback for every token; the typed editors (COR-489 foundations, COR-263 color roles,
 * COR-488 composites) register for the DTCG types they handle with `registerTokenEditor`, and
 * `editorForToken` hands the slot the right one.
 */

import type { Component } from 'svelte';

import type { CatalogueRow } from './theme-builder-catalogue.ts';
import type { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import ColorTokenEditor from './theme-color-editor.svelte';
import CompositeEditor from './theme-composite-editor.svelte';
import { COMPOSITE_TYPES } from './theme-composite-values.ts';
import FoundationEditor from './theme-foundation-editor.svelte';
import { FOUNDATION_EDITOR_TYPES } from './theme-foundation-values.ts';
import GenericTokenEditor from './theme-token-editor-generic.svelte';
import type { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

export type TokenEditorProps = {
  controller: ThemeBuilderController;
  workbench: ThemeWorkbenchState;
  row: CatalogueRow;
};

export type TokenEditor = Component<TokenEditorProps>;

const registered = new Map<string, TokenEditor>();

/** Register an editor for a DTCG type; it replaces the generic field for those tokens. */
export function registerTokenEditor(type: string, editor: TokenEditor): void {
  registered.set(type, editor);
}

/** True when a typed editor, not just the generic field, handles this DTCG type. */
export function hasTypedEditor(type: string): boolean {
  return registered.has(type);
}

export function editorForToken(row: CatalogueRow): TokenEditor {
  return registered.get(row.type) ?? GenericTokenEditor;
}

// COR-263: the color editor handles every color record.
registerTokenEditor('color', ColorTokenEditor);
// COR-489: the non-color scalar types share one foundation editor.
for (const type of FOUNDATION_EDITOR_TYPES) registerTokenEditor(type, FoundationEditor);
// COR-488: strokeStyle, border, transition, shadow, gradient and typography share one editor.
for (const type of COMPOSITE_TYPES) registerTokenEditor(type, CompositeEditor);
