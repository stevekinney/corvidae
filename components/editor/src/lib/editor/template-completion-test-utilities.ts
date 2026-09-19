/**
 * Tests for the template completion plugin internal logic.
 *
 * DEP-583: Validates filterAndSortCandidates, mergeCandidates, detectTokenQuery,
 * and computeCompletionState using ProseMirror's model and state layers in Node.
 * Async plugin view lifecycle coverage uses a minimal mocked document instead of
 * a real DOM runtime.
 */

import type { PlaceholderCandidate, PlaceholderCompletionConfiguration } from '@corvidae/markdown';
import { Schema } from '@milkdown/kit/prose/model';
import type { Plugin, Transaction } from '@milkdown/kit/prose/state';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
import { createTemplateCompletionPlugin } from './template-completion-plugin.js';
import { templateCompletionPluginKey } from './template-completion-state.js';

// ---------------------------------------------------------------------------
// Test schema
// ---------------------------------------------------------------------------

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM() {
        return ['p', 0];
      },
    },
    text: { group: 'inline' },
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function makeCandidate(path: string, description?: string): PlaceholderCandidate {
  return { path, description, valueKind: 'string' as const };
}

export function makeCandidates(...paths: string[]): PlaceholderCandidate[] {
  return paths.map((path) => makeCandidate(path));
}

/**
 * Create an EditorState with a single paragraph containing the given text
 * and the cursor positioned at the specified character offset within the
 * paragraph content.
 *
 * When `cursorOffset` is omitted the selection defaults to the end of the
 * document (ProseMirror's default).
 */
export function createStateWithText(text: string, cursorOffset?: number): EditorState {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, text ? [schema.text(text)] : []),
  ]);
  const state = EditorState.create({ doc, schema });

  if (cursorOffset !== undefined) {
    // Position = 1 (doc open) + cursorOffset (within paragraph content).
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1 + cursorOffset)));
  }

  return state;
}

/**
 * Create an EditorState with a non-collapsed (range) selection.
 */
export function createStateWithSelection(text: string, from: number, to: number): EditorState {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, text ? [schema.text(text)] : []),
  ]);
  const state = EditorState.create({ doc, schema });

  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1 + from, 1 + to)));
}

export function createStateWithTextAndPlugins(
  text: string,
  cursorOffset: number,
  plugins: readonly Plugin[],
): EditorState {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, text ? [schema.text(text)] : []),
  ]);
  const state = EditorState.create({ doc, schema, plugins: [...plugins] });

  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1 + cursorOffset)));
}

type MockElement = {
  className: string;
  style: Record<string, string>;
  textContent: string;
  parentElement: MockElement | null;
  classList: { add: (...tokens: string[]) => void };
  setAttribute: (name: string, value: string) => void;
  appendChild: (child: MockElement) => MockElement;
  removeChild: (child: MockElement) => MockElement;
  addEventListener: () => void;
  getBoundingClientRect: () => DOMRect;
};

export function createMockElement(): MockElement {
  const children: MockElement[] = [];
  const attributes = new Map<string, string>();

  const element: MockElement = {
    className: '',
    style: {},
    textContent: '',
    parentElement: null,
    classList: {
      add(...tokens: string[]) {
        if (tokens.length === 0) return;
        const existing = element.className ? element.className.split(/\s+/) : [];
        element.className = [...new Set([...existing, ...tokens])].join(' ');
      },
    },
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    appendChild(child: MockElement) {
      child.parentElement = element;
      children.push(child);
      return child;
    },
    removeChild(child: MockElement) {
      const index = children.indexOf(child);
      if (index >= 0) {
        children.splice(index, 1);
        child.parentElement = null;
      }
      return child;
    },
    addEventListener() {},
    getBoundingClientRect() {
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON() {
          return {};
        },
      };
    },
  };

  return element;
}

type CompletionHarness = {
  view: TestView;
  pluginView: {
    update?: (...args: unknown[]) => unknown;
    destroy?: () => void;
  };
  typeText: (text: string) => void;
  getPluginState: () => ReturnType<typeof templateCompletionPluginKey.getState>;
};

type TestView = {
  state: EditorState;
  dom: { parentElement: HTMLElement };
  dispatch: (transaction: Transaction) => void;
  coordsAtPos: () => { left: number; right: number; top: number; bottom: number };
};

export async function createCompletionHarness(
  configuration: PlaceholderCompletionConfiguration,
  text = '{{',
): Promise<CompletionHarness> {
  // cinder#1306: createLazyProsePlugin's outer function now ALSO calls
  // ctx.record/ctx.update(editorStateTimerCtx, ...) when
  // milkdown-plugin-runtime.ts's runtime cache happens to already be primed
  // (which it may be, from an earlier test in this shared process — the
  // cache is intentionally module-global, matching commands.ts's
  // preloadCommandRuntime pattern). This fake ctx has to tolerate both
  // calls: `record`/`done`/`clearTimer` as no-ops (this harness does not
  // model Milkdown's timer system), and `update` scoped to ONLY the prose
  // plugins slice — an unscoped fake would otherwise splice a raw Timer
  // object into `registeredPlugins`, corrupting ProseMirror's actual plugin
  // list for the rest of the test.
  const completionPlugin = createTemplateCompletionPlugin(() => configuration);

  const context = {
    wait: async () => {},
    record: () => {},
    done: () => {},
    clearTimer: () => {},
    update: (_slice: unknown, _updater: (value: unknown) => unknown) => {},
  };
  const initializePlugin = Reflect.apply(completionPlugin, null, [context]);
  await initializePlugin();

  const prosePlugin = completionPlugin.plugin();
  let state = createStateWithTextAndPlugins(text, text.length, [prosePlugin]);

  let pluginView: CompletionHarness['pluginView'] = {};
  const view = {
    get state() {
      return state;
    },
    set state(nextState: EditorState) {
      state = nextState;
    },
    dom: {
      parentElement: document.body,
    },
    dispatch(transaction: Transaction) {
      const previousState = state;
      state = state.apply(transaction);
      if (pluginView.update) Reflect.apply(pluginView.update, pluginView, [view, previousState]);
    },
    coordsAtPos() {
      return { left: 0, right: 0, top: 0, bottom: 0 };
    },
  };

  pluginView = prosePlugin.spec.view ? Reflect.apply(prosePlugin.spec.view, null, [view]) : {};

  return {
    view,
    pluginView,
    typeText(inputText: string) {
      for (const character of inputText) {
        const cursorPosition = state.selection.from;
        const transaction = state.tr.insertText(character, cursorPosition, cursorPosition);
        view.dispatch(transaction);
      }
    },
    getPluginState() {
      return templateCompletionPluginKey.getState(state);
    },
  };
}

export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

export async function flushTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushMicrotasks();
}

// ---------------------------------------------------------------------------
