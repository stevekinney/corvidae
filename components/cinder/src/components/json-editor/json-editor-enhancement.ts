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
import {
  Annotation,
  Compartment,
  EditorState,
  type Extension,
  RangeSet,
  StateEffect,
  StateField,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  gutterLineClass,
  GutterMarker,
  keymap,
  lineNumbers,
  placeholder as placeholderExtension,
  WidgetType,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { formatJson } from './json-editor-format.ts';
import { createSchemaCompletionSource } from './json-editor-schema-completion.ts';
import type { JsonEditorDiagnostic, JsonEditorSchema } from './json-editor.types.ts';

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
  /** Mark these lines as problems, each with the message shown under it. Replaces the earlier marks. */
  setProblems: (problems: readonly JsonEditorDiagnostic[]) => void;
  /** Move the caret to the start of a one-based line, scroll it into view, and focus the editor. */
  focusLine: (line: number) => void;
  /** Move keyboard focus into the editor. */
  focus: () => void;
  /** Remove the editor and release its listeners and timers. */
  destroy: () => void;
}

const programmaticChange = Annotation.define<boolean>();

const singleLineClass = 'cinder-json-editor__cm--single-line';
const problemLineClass = 'cinder-json-editor__line--problem';
const problemGutterClass = 'cinder-json-editor__gutter--problem';
const problemMessageClass = 'cinder-json-editor__problem';

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

/** The editor's content height for `rows` lines: each is 1.5em tall, plus the content's own padding. */
const contentHeight = (rows: string): string => `calc(${rows} * 1.5em + 2 * var(--cinder-space-2))`;

// CodeMirror injects its own rules without a cascade layer, and an unlayered rule beats anything
// inside `@layer cinder.components`, so the editor is themed here and not in `json-editor.css`.
// The frame (border, radius, focus ring, toolbar) is the component's own element around the
// editor, so this theme draws no border of its own: the frame clips the gutter to its radius.
const theme = EditorView.theme({
  '&': {
    fontFamily: 'var(--cinder-font-mono)',
    fontSize: 'var(--cinder-text-sm)',
    color: 'var(--cinder-text-default)',
    backgroundColor: 'transparent',
    minWidth: '0',
    maxHeight: contentHeight('var(--_cinder-json-editor-rows, 8)'),
  },
  // The quiet focus ring wraps the whole frame, so the editor draws none of its own.
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: '1.5',
    overflow: 'auto',
  },
  // An always-painted scrollbar, so a body that scrolls says so. Chrome and Safari draw a
  // persistent bar only from the `::-webkit-scrollbar` rules (setting `scrollbar-width` or
  // `scrollbar-color` there keeps the overlay bar that fades away), so the standard properties
  // are left to engines that have no such pseudo-element.
  '@supports not selector(::-webkit-scrollbar)': {
    '.cm-scroller': {
      scrollbarWidth: 'thin',
      scrollbarColor: 'var(--cinder-scrollbar-thumb) var(--cinder-scrollbar-track)',
    },
  },
  '.cm-scroller::-webkit-scrollbar': {
    inlineSize: 'var(--cinder-scrollbar-size)',
    blockSize: 'var(--cinder-scrollbar-size)',
  },
  '.cm-scroller::-webkit-scrollbar-track': { background: 'var(--cinder-scrollbar-track)' },
  '.cm-scroller::-webkit-scrollbar-thumb': {
    background: 'var(--cinder-scrollbar-thumb)',
    borderRadius: 'var(--cinder-radius-sm)',
  },
  '.cm-scroller::-webkit-scrollbar-thumb:hover': {
    background: 'var(--cinder-scrollbar-thumb-hover)',
  },
  '.cm-scroller::-webkit-scrollbar-corner': { background: 'var(--cinder-scrollbar-track)' },
  // Three rows is the least an editor shows, so an empty one still reads as an editor.
  '.cm-content, .cm-gutter': { minHeight: contentHeight('3') },
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
  '.cm-gutterElement': { padding: '0 var(--cinder-space-2) 0 var(--cinder-space-3)' },
  // A single line has nothing to number, so its gutter is not drawn.
  [`&.${singleLineClass} .cm-gutters`]: { display: 'none' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--cinder-text-default)' },
  // Fold markers appear while the pointer is over the gutter or the editor has focus.
  '.cm-foldGutter .cm-gutterElement': { cursor: 'pointer', padding: '0 var(--cinder-space-1)' },
  '.cm-foldGutter span': { opacity: '0' },
  '.cm-gutters:hover .cm-foldGutter span, &.cm-focused .cm-foldGutter span': { opacity: '1' },
  '.cm-placeholder': { color: 'var(--cinder-text-muted)' },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'transparent',
    outline: '1px solid var(--cinder-text-muted)',
  },
  // A marked line: the row is tinted, its number turns red, and the message sits under it.
  [`.${problemLineClass}`]: { backgroundColor: 'var(--cinder-status-danger-background)' },
  [`.cm-gutterElement.${problemGutterClass}`]: {
    backgroundColor: 'var(--cinder-status-danger-background)',
    color: 'var(--cinder-status-danger-text)',
    fontWeight: '600',
  },
  [`.${problemMessageClass}`]: {
    // Zero width with a full-width minimum, so a long message wraps inside the visible editor
    // instead of widening the scrolling content to fit it on one line.
    boxSizing: 'border-box',
    inlineSize: '0',
    minInlineSize: '100%',
    display: 'flex',
    alignItems: 'flex-start',
    gap: 'var(--cinder-space-1-5)',
    padding: '0 var(--cinder-space-2)',
    backgroundColor: 'var(--cinder-status-danger-background)',
    color: 'var(--cinder-status-danger-text)',
    fontFamily: 'var(--cinder-font-sans)',
    fontSize: 'var(--cinder-text-xs)',
    fontWeight: '500',
    whiteSpace: 'normal',
  },
  [`.${problemMessageClass} svg`]: { flex: 'none', marginBlockStart: '0.3em' },
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

/** Replace the lines the editor marks as a problem. */
const setProblems = StateEffect.define<readonly JsonEditorDiagnostic[]>();

/** The problems the component last sent, as line numbers and messages. */
const problemField = StateField.define<readonly JsonEditorDiagnostic[]>({
  create: () => [],
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setProblems)) return effect.value;
    return value;
  },
});

/** The message block drawn under a marked line. */
class ProblemMessage extends WidgetType {
  constructor(private readonly message: string) {
    super();
  }

  override eq(other: ProblemMessage): boolean {
    return other.message === this.message;
  }

  override toDOM(): HTMLElement {
    const block = document.createElement('div');
    block.className = problemMessageClass;
    const svgNamespace = 'http://www.w3.org/2000/svg';
    const icon = document.createElementNS(svgNamespace, 'svg');
    for (const [name, value] of Object.entries({
      width: '14',
      height: '14',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
    })) {
      icon.setAttribute(name, value);
    }
    for (const data of [
      'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3',
      'M12 9v4',
      'M12 17h.01',
    ]) {
      const path = document.createElementNS(svgNamespace, 'path');
      path.setAttribute('d', data);
      icon.append(path);
    }
    const text = document.createElement('span');
    text.textContent = this.message;
    block.append(icon, text);
    return block;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class ProblemGutterMarker extends GutterMarker {
  override elementClass = problemGutterClass;
}

const problemGutterMarker = new ProblemGutterMarker();

function problemDecorations(state: EditorState): DecorationSet {
  const ranges = [];
  for (const problem of state.field(problemField)) {
    if (problem.line < 1 || problem.line > state.doc.lines) continue;
    const line = state.doc.line(problem.line);
    ranges.push(Decoration.line({ class: problemLineClass }).range(line.from));
    ranges.push(
      Decoration.widget({
        widget: new ProblemMessage(problem.message),
        block: true,
        side: 1,
      }).range(line.to),
    );
  }
  return Decoration.set(ranges, true);
}

function problemGutterMarkers(state: EditorState): RangeSet<GutterMarker> {
  const markers = [];
  for (const problem of state.field(problemField)) {
    if (problem.line < 1 || problem.line > state.doc.lines) continue;
    markers.push(problemGutterMarker.range(state.doc.line(problem.line).from));
  }
  return RangeSet.of(markers, true);
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
  // CodeMirror skips measuring an editor that is wholly outside the window, so one that mounts
  // below the fold draws its gutter from a 14px line estimate with no top padding, and the line
  // numbers drift further from their lines the further down they are, until the editor scrolls
  // into view. A capture beyond the viewport never scrolls it there. An initial scroll target is
  // the one thing that makes the first measure run anyway; this handler swallows that scroll, so
  // mounting never moves the page.
  let initialScrollPending = true;
  const swallowInitialScroll = EditorView.scrollHandler.of(() => {
    if (!initialScrollPending) return false;
    initialScrollPending = false;
    return true;
  });
  const view = new EditorView({
    parent: options.parent,
    scrollTo: EditorView.scrollIntoView(0),
    state: EditorState.create({
      doc: options.document,
      extensions: [
        lineNumbers(),
        foldGutter(),
        problemField,
        EditorView.decorations.compute([problemField], problemDecorations),
        gutterLineClass.compute([problemField], problemGutterMarkers),
        EditorView.editorAttributes.compute(['doc'], (state) =>
          state.doc.lines < 2 ? { class: singleLineClass } : {},
        ),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        json(),
        syntaxHighlighting(highlightStyle),
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
        swallowInitialScroll,
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
    setProblems(problems) {
      view.dispatch({ effects: setProblems.of(problems) });
    },
    focusLine(line) {
      const target = view.state.doc.line(
        Math.min(Math.max(1, Math.trunc(line)), view.state.doc.lines),
      );
      // A scroll asked for before the first measure replaces the initial one and must happen.
      initialScrollPending = false;
      view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
      view.focus();
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
