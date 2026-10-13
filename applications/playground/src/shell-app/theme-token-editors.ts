/**
 * The seam between the editor slot and the editors that fill it. The generic `$value` field is
 * the fallback for every token; the typed editors (COR-489 foundations, COR-263 color roles,
 * COR-488 composites) register for the DTCG types they handle with `registerTokenEditor`, and
 * `editorForToken` hands the slot the right one.
 */

import type { Component } from 'svelte';

import type { CatalogueRow } from './theme-builder-catalogue.ts';
import type { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
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

export function editorForToken(row: CatalogueRow): TokenEditor {
  return registered.get(row.type) ?? GenericTokenEditor;
}
