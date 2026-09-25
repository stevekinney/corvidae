/**
 * MarkdownEditor's placeholder state: the live editor configuration, the
 * status message, and the diagnostics reported to the caller.
 *
 * Created once during component initialization. Values are only classified
 * here; they never reach the editor or a diagnostic.
 */

import type {
  PlaceholderCompletionConfiguration,
  PlaceholderDecorationConfiguration,
  PlaceholderDefinitions,
  PlaceholderDiagnostic,
} from '@lostgradient/markdown';
import { untrack } from 'svelte';

import {
  classifyPlaceholderValues,
  resolvePlaceholderConfiguration,
  type PlaceholderEditorConfiguration,
} from '../../editor/template-placeholder-configuration.ts';
import { samePlaceholderDiagnostics } from '../../editor/template-placeholder-diagnostic-comparison.ts';
import { computePlaceholderDiagnostics } from '../../editor/template-placeholder-diagnostics.ts';

/** Default instructions for placeholder completion. */
export const PLACEHOLDER_INSTRUCTIONS =
  'Type two opening braces to insert a placeholder. Use arrow keys and Enter to choose; Escape or Tab dismisses.';

/** Reactive reads of the component props this module needs. */
export interface MarkdownEditorPlaceholderProps {
  id: () => string;
  value: () => string;
  readonly: () => boolean;
  /** Completion exists only in WYSIWYG mode until source-mode completion lands. */
  wysiwyg: () => boolean;
  definitions: () => PlaceholderDefinitions | undefined;
  values: () => unknown;
  completion: () => PlaceholderCompletionConfiguration | undefined;
  decoration: () => PlaceholderDecorationConfiguration | undefined;
  onDiagnosticsChange: () => ((diagnostics: readonly PlaceholderDiagnostic[]) => void) | undefined;
}

const NO_DIAGNOSTICS: readonly PlaceholderDiagnostic[] = Object.freeze([]);

/** Join ID reference lists, keeping the caller's tokens first and dropping duplicates. */
export function mergeIdReferences(...lists: (string | null | undefined)[]): string | undefined {
  const tokens = lists.flatMap((list) => list?.split(/\s+/).filter(Boolean) ?? []);
  const unique = [...new Set(tokens)];
  return unique.length > 0 ? unique.join(' ') : undefined;
}

export function createMarkdownEditorPlaceholders(props: MarkdownEditorPlaceholderProps) {
  const valuesStatus = $derived(classifyPlaceholderValues(props.values()));
  const configuration: PlaceholderEditorConfiguration = $derived({
    definitions: props.definitions(),
    completion: props.completion(),
    decoration: props.decoration(),
    valuesStatus,
  });
  const resolved = $derived(resolvePlaceholderConfiguration(configuration));
  const instructionsVisible = $derived(
    resolved.completion !== undefined && !props.readonly() && props.wysiwyg(),
  );
  let statusMessage = $state('');
  let diagnostics = $state.raw<readonly PlaceholderDiagnostic[]>(NO_DIAGNOSTICS);

  // Report only when the ordered list changes. The initial empty list is
  // never reported, so `[]` goes out only to clear earlier diagnostics.
  $effect(() => {
    const next = computePlaceholderDiagnostics(resolved, props.value());
    untrack(() => {
      if (samePlaceholderDiagnostics(next, diagnostics)) return;
      diagnostics = next;
      props.onDiagnosticsChange()?.(next);
    });
  });

  return {
    /** The configuration object handed to the editor; replaced when a prop changes. */
    get configuration() {
      return configuration;
    },
    get statusMessage() {
      return statusMessage;
    },
    get diagnostics() {
      return diagnostics;
    },
    get instructionsVisible() {
      return instructionsVisible;
    },
    get listboxId() {
      return `${props.id()}-placeholder-listbox-wysiwyg`;
    },
    setStatusMessage(message: string) {
      statusMessage = message;
    },
    /** The editing element's `aria-describedby`: the caller's IDs, then instructions and diagnostics. */
    describedBy(callerDescribedBy: string | null | undefined): string | undefined {
      const id = props.id();
      return mergeIdReferences(
        callerDescribedBy,
        instructionsVisible ? `${id}-placeholder-instructions` : undefined,
        diagnostics.length > 0 ? `${id}-placeholder-diagnostics` : undefined,
      );
    },
  };
}
