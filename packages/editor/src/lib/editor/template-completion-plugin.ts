/** Milkdown plugin for inline autocomplete of `{{…}}` template tokens. */

import type { PlaceholderCompletionConfiguration } from '@repo/markdown';
import { Plugin } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

import { createLazyProsePlugin, type LazyProsePlugin } from './milkdown-plugin-runtime.js';
import { handleCompletionKeyDown } from './template-completion-keyboard.js';
import {
  createPopupElement,
  positionPopup,
  renderSuggestions,
} from './template-completion-popup.js';
import {
  computeCompletionState,
  INACTIVE_STATE,
  templateCompletionPluginKey,
  type CompletionMeta,
  type CompletionState,
} from './template-completion-state.js';

const DEFAULT_LOOKUP_DEBOUNCE_MS = 150;

export function createTemplateCompletionPlugin(
  getConfiguration: () => PlaceholderCompletionConfiguration | undefined,
): LazyProsePlugin {
  return createLazyProsePlugin(() => {
    return new Plugin<CompletionState>({
      key: templateCompletionPluginKey,
      state: {
        init: () => INACTIVE_STATE,
        apply(transaction, previousState, _oldEditorState, newEditorState) {
          return computeCompletionState(
            previousState,
            transaction,
            newEditorState,
            getConfiguration(),
          );
        },
      },
      props: { handleKeyDown: handleCompletionKeyDown },
      view(editorView) {
        const popup = createPopupElement();
        const parentElement = editorView.dom.parentElement ?? document.body;
        parentElement.appendChild(popup);
        let currentAbortController: AbortController | null = null;
        let debounceTimeout: ReturnType<typeof setTimeout> | null = null;

        const cancelAsyncLookup = (): void => {
          currentAbortController?.abort();
          currentAbortController = null;
          if (debounceTimeout !== null) {
            clearTimeout(debounceTimeout);
            debounceTimeout = null;
          }
        };
        const updatePopup = (view: EditorView): void => {
          const pluginState = templateCompletionPluginKey.getState(view.state);
          if (!pluginState?.active || pluginState.suggestions.length === 0) {
            popup.style.display = 'none';
            return;
          }
          popup.style.display = '';
          renderSuggestions(popup, pluginState, view);
          positionPopup(popup, view, pluginState.cursorPos);
        };

        updatePopup(editorView);
        return {
          update(view, previousEditorState) {
            const pluginState = templateCompletionPluginKey.getState(view.state);
            const previousPluginState = templateCompletionPluginKey.getState(previousEditorState);
            if (!pluginState?.active) {
              cancelAsyncLookup();
              updatePopup(view);
              return;
            }
            if (pluginState.query !== previousPluginState?.query) {
              cancelAsyncLookup();
              scheduleLookup(
                view,
                pluginState.query,
                getConfiguration(),
                (controller) => {
                  currentAbortController = controller;
                },
                (timeout) => {
                  debounceTimeout = timeout;
                },
              );
            }
            updatePopup(view);
          },
          destroy() {
            cancelAsyncLookup();
            popup.parentElement?.removeChild(popup);
          },
        };
      },
    });
  });
}

function scheduleLookup(
  view: EditorView,
  query: string,
  configuration: PlaceholderCompletionConfiguration | undefined,
  setController: (controller: AbortController) => void,
  setTimeoutHandle: (timeout: ReturnType<typeof setTimeout>) => void,
): void {
  if (!configuration?.lookupCandidates) return;
  const controller = new AbortController();
  setController(controller);
  const delay = configuration.lookupDebounceMs ?? DEFAULT_LOOKUP_DEBOUNCE_MS;
  const timeout = setTimeout(async () => {
    try {
      const candidates = await configuration.lookupCandidates!(query, controller.signal);
      if (controller.signal.aborted) return;
      view.dispatch(
        view.state.tr.setMeta(templateCompletionPluginKey, {
          type: 'asyncResults',
          candidates,
        } satisfies CompletionMeta),
      );
    } catch {
      // Lookup failures leave static suggestions visible and do not escape the view lifecycle.
    }
  }, delay);
  setTimeoutHandle(timeout);
}
