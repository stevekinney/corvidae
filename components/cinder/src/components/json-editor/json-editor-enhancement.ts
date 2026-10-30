/**
 * The CodeMirror 6 runtime behind JsonEditor.
 *
 * Only `json-editor.svelte` reaches this module, and only through a dynamic `import()` when an
 * editor mounts, so the code-editor runtime is a separate chunk that pages without a JsonEditor
 * never download. Do not import it statically from anywhere on the component's public entry
 * path; `json-editor.bundle-boundary.test.ts` fails the build if one does.
 */
import { autocompletion } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  keymap,
  lineNumbers,
  placeholder as placeholderExtension,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { formatJson, isBlankJson } from './json-editor-format.ts';
import { createSchemaCompletionSource } from './json-editor-schema-completion.ts';
import type { JsonEditorSchema } from './json-editor.types.ts';

/** The settings that can change while an editor stays mounted. */
export interface JsonEditorDynamicOptions {
  /** Whether the editor refuses edits and keyboard focus. */
  disabled: boolean;
  /** Whether the editor refuses edits but stays focusable and selectable. */
  readonly: boolean;
  /** Whether long lines wrap instead of scrolling sideways. */
  wrap: boolean;
  /** The schema that drives completion, if any. */
  schema: JsonEditorSchema | undefined;
  /** Text shown while the document is empty. */
  placeholder: string | undefined;
  /** ARIA attributes for the editable element, which has no native label or description. */
  attributes: Readonly<Record<string, string>>;
}

/** Everything needed to create an editor. */
export interface JsonEditorOptions extends JsonEditorDynamicOptions {
  /** The element the editor is appended to. */
  parent: HTMLElement;
  /** The initial JSON source. */
  document: string;
  /** Called with the new source after each edit the user makes, never after a programmatic update. */
  onChange: (value: string) => void;
}

/** A mounted editor and the operations the component needs from it. */
export interface JsonEditorHandle {
  /** The underlying CodeMirror view. */
  readonly view: EditorView;
  /** Replace the document without reporting a user edit. */
  setDocument: (text: string) => void;
  /** Apply settings that may change while the editor stays mounted. */
  update: (options: JsonEditorDynamicOptions) => void;
  /** Pretty-print the document. Returns `false` when it is empty, invalid, or read-only and nothing changed. */
  format: () => boolean;
  /** Move keyboard focus into the editor. */
  focus: () => void;
  /** Remove the editor and release its listeners and timers. */
  destroy: () => void;
}

const programmaticChange = Annotation.define<boolean>();

const highlightStyle = HighlightStyle.define([
  { tag: tags.propertyName, color: 'var(--cinder-accent-text)' },
  { tag: tags.string, color: 'var(--cinder-status-success-text)' },
  { tag: tags.number, color: 'var(--cinder-status-warning-text)' },
  { tag: [tags.bool, tags.null], color: 'var(--cinder-status-info-text)' },
  {
    tag: [tags.punctuation, tags.separator, tags.brace, tags.squareBracket],
    color: 'var(--cinder-text-muted)',
  },
]);

// CodeMirror injects its own rules without a cascade layer, and an unlayered rule beats anything
// inside `@layer cinder.components`, so the editor is themed here and not in `json-editor.css`.
const theme = EditorView.theme({
  '&': {
    fontFamily: 'var(--cinder-font-mono)',
    fontSize: 'var(--cinder-text-sm)',
    color: 'var(--cinder-text-default)',
    backgroundColor: 'var(--cinder-control-background)',
    border: '1px solid var(--cinder-control-border)',
    borderRadius: 'var(--cinder-control-radius)',
    maxHeight: 'calc(var(--_cinder-json-editor-rows, 8) * 1.5em + 2 * var(--cinder-space-2) + 2px)',
  },
  '&.cm-focused': {
    outline: 'var(--cinder-ring-width) solid transparent',
    borderColor: 'transparent',
    boxShadow: 'var(--_cinder-focus-ring-shadow)',
  },
  '@media (forced-colors: active)': {
    '&.cm-focused': { outline: 'var(--cinder-ring-width) solid ButtonText', boxShadow: 'none' },
  },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.5', overflow: 'auto' },
  '.cm-content': {
    padding: 'var(--cinder-space-2) 0',
    caretColor: 'var(--cinder-text-default)',
  },
  '.cm-line': { padding: '0 var(--cinder-space-2)' },
  '.cm-gutters': {
    backgroundColor: 'var(--cinder-surface-raised)',
    color: 'var(--cinder-text-muted)',
    border: 'none',
    borderRight: '1px solid var(--cinder-control-border)',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--cinder-text-default)' },
  '.cm-foldGutter .cm-gutterElement': { cursor: 'pointer' },
  '.cm-placeholder': { color: 'var(--cinder-text-muted)' },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'transparent',
    outline: '1px solid var(--cinder-text-muted)',
  },
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--cinder-status-danger-solid)',
    textDecorationThickness: '1px',
    textUnderlineOffset: '2px',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--cinder-surface-raised)',
    color: 'var(--cinder-text-default)',
    border: '1px solid var(--cinder-control-border)',
    borderRadius: 'var(--cinder-control-radius)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--cinder-accent-solid)',
    color: 'var(--cinder-accent-contrast)',
  },
});

/** Where `JSON.parse` says the source stopped making sense, falling back to the end of the source. */
function errorPosition(source: string, error: unknown): number {
  const message = error instanceof SyntaxError ? error.message : '';
  const positionMatch = message.match(/position (\d+)/i);
  if (positionMatch) return Number(positionMatch[1]);
  const lineColumnMatch = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
  if (lineColumnMatch) {
    const line = Number(lineColumnMatch[1]);
    const column = Number(lineColumnMatch[2]);
    return (
      source
        .split('\n')
        .slice(0, line - 1)
        .reduce((offset, current) => offset + current.length + 1, 0) + Math.max(0, column - 1)
    );
  }
  return source.length;
}

/**
 * Report the first JSON syntax error as an inline diagnostic.
 *
 * An empty document yields no diagnostic: an optional field with no value is valid, so it earns
 * neither an underline nor a gutter glyph, and a required one reports "Enter valid JSON." in the
 * field's own feedback instead.
 */
export function lintJsonDocument(view: EditorView): Diagnostic[] {
  const source = view.state.doc.toString();
  if (isBlankJson(source)) return [];
  try {
    JSON.parse(source);
    return [];
  } catch (error) {
    const last = Math.max(0, source.length - 1);
    const from = Math.min(errorPosition(source, error), last);
    return [
      {
        from,
        to: Math.min(from + 1, source.length),
        severity: 'error',
        message: 'Enter valid JSON.',
      },
    ];
  }
}

/** Pretty-print the whole document. Returns `false` when it is empty, invalid, or read-only. */
export function formatJsonDocument(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  const formatted = formatJson(view.state.doc.toString());
  if (formatted === undefined) return false;
  if (formatted === view.state.doc.toString()) return true;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: formatted },
    selection: { anchor: Math.min(view.state.selection.main.head, formatted.length) },
    userEvent: 'input.format',
  });
  return true;
}

function dynamicExtensions(options: JsonEditorDynamicOptions): Extension[] {
  return [
    options.disabled ? EditorView.editable.of(false) : [],
    options.disabled || options.readonly ? EditorState.readOnly.of(true) : [],
    options.wrap ? EditorView.lineWrapping : [],
    options.schema === undefined
      ? []
      : autocompletion({
          override: [createSchemaCompletionSource(options.schema)],
          icons: false,
        }),
    options.placeholder === undefined ? [] : placeholderExtension(options.placeholder),
    EditorView.contentAttributes.of({
      // The editable area is the scroll region's only focusable content, but axe does not count a
      // bare `contenteditable` as focusable, so a scrolling editor would fail its keyboard-access
      // rule. An explicit zero keeps the one tab stop and names it; a disabled editor has none.
      ...(options.disabled ? {} : { tabindex: '0' }),
      spellcheck: 'false',
      autocorrect: 'off',
      autocapitalize: 'off',
      ...options.attributes,
    }),
  ];
}

/** Create a CodeMirror editor for JSON in `options.parent`. */
export function createJsonEditor(options: JsonEditorOptions): JsonEditorHandle {
  const dynamic = new Compartment();
  const view = new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc: options.document,
      extensions: [
        lineNumbers(),
        foldGutter(),
        lintGutter(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        json(),
        syntaxHighlighting(highlightStyle),
        linter(lintJsonDocument),
        // Tab is deliberately unbound so keyboard users can always leave the editor.
        keymap.of([
          // CodeMirror names a shifted letter two ways: the capital letter where the key event
          // carries it, and shift plus the base letter where Option rewrites the character.
          { key: 'Alt-F', run: formatJsonDocument },
          { key: 'Shift-Alt-f', run: formatJsonDocument },
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
        ]),
        theme,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          if (
            update.transactions.some((transaction) => transaction.annotation(programmaticChange))
          ) {
            return;
          }
          options.onChange(update.state.doc.toString());
        }),
        dynamic.of(dynamicExtensions(options)),
      ],
    }),
  });

  return {
    view,
    setDocument(text) {
      if (text === view.state.doc.toString()) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: Math.min(view.state.selection.main.head, text.length) },
        annotations: programmaticChange.of(true),
      });
    },
    update(next) {
      view.dispatch({ effects: dynamic.reconfigure(dynamicExtensions(next)) });
    },
    format: () => formatJsonDocument(view),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
