import { getMarkdown, replaceAll } from '@milkdown/kit/utils';
import { preloadCommandRuntime } from './commands.ts';
import { notifySelection } from './editor-selection.ts';
import { createEditorKeymap } from './keymap-plugin.ts';
import { preloadLazyPluginRuntime } from './milkdown-plugin-runtime.js';
import { createTemplateCompletionPlugin } from './template-completion-plugin.ts';
import { createTemplateInvalidDecorationPlugin } from './template-invalid-decoration-plugin.ts';

import { applyReadonlyAria } from './editor-lifecycle.ts';
import type { EditorConfig, EditorState } from './types.js';
import { DEFAULT_DEBOUNCE_MS } from './types.js';

type EditorBuilder = ReturnType<typeof import('@milkdown/kit/core').Editor.make>;
type MilkdownPluginList =
  import('@milkdown/ctx').MilkdownPlugin | import('@milkdown/ctx').MilkdownPlugin[];

function configureEditor(
  builder: EditorBuilder,
  container: HTMLElement,
  initialContent: string,
  resolvedAriaLabel: string | undefined,
  rootCtx: typeof import('@milkdown/kit/core').rootCtx,
  defaultValueCtx: typeof import('@milkdown/kit/core').defaultValueCtx,
  editorViewOptionsCtx: typeof import('@milkdown/kit/core').editorViewOptionsCtx,
  listItemKeymap: typeof import('@milkdown/kit/preset/commonmark').listItemKeymap,
  tableKeymap: typeof import('@milkdown/kit/preset/gfm').tableKeymap,
  listenerCtx: typeof import('@milkdown/kit/plugin/listener').listenerCtx,
  editorViewCtx: typeof import('@milkdown/kit/core').editorViewCtx,
  listener: typeof import('@milkdown/kit/plugin/listener').listener,
  commonmark: typeof import('@milkdown/kit/preset/commonmark').commonmark,
  gfm: typeof import('@milkdown/kit/preset/gfm').gfm,
  linkInputRulePlugin: import('@milkdown/ctx').MilkdownPlugin,
  clipboardPlugin: import('@milkdown/ctx').MilkdownPlugin,
  history: MilkdownPluginList,
  placeholderPlugin: import('@milkdown/ctx').MilkdownPlugin,
  keymap: import('@milkdown/ctx').MilkdownPlugin,
  isDestroyed: () => boolean,
  onmarkdownupdated: (markdown: string, previousMarkdown: string) => void,
  onselectionchange?: EditorConfig['onselectionchange'],
): EditorBuilder {
  return builder
    .config((ctx) => {
      ctx.set(rootCtx, container);
      ctx.set(defaultValueCtx, initialContent);
      if (!resolvedAriaLabel) return;
      ctx.update(editorViewOptionsCtx, (previous) => ({
        ...previous,
        attributes: withAriaLabel(previous.attributes ?? {}, resolvedAriaLabel),
      }));
    })
    .config((ctx) => {
      const listenerManager = ctx.get(listenerCtx);
      listenerManager.markdownUpdated((_ctx, markdown, previousMarkdown) =>
        onmarkdownupdated(markdown, previousMarkdown),
      );
      if (!onselectionchange) return;
      listenerManager.selectionUpdated((context, selection) =>
        notifySelection(context, editorViewCtx, isDestroyed, onselectionchange, selection),
      );
      listenerManager.updated((context) =>
        notifySelection(context, editorViewCtx, isDestroyed, onselectionchange),
      );
    })
    .config((ctx) => {
      ctx.update(listItemKeymap.key, (current) => ({
        ...current,
        SinkListItem: { ...current.SinkListItem, shortcuts: 'Mod-]' },
        LiftListItem: { ...current.LiftListItem, shortcuts: 'Mod-[' },
      }));
      ctx.update(tableKeymap.key, (current) => ({
        ...current,
        NextCell: { ...current.NextCell, shortcuts: 'Mod-]' },
        PrevCell: { ...current.PrevCell, shortcuts: 'Mod-[' },
      }));
    })
    .use(commonmark)
    .use(gfm)
    .use(linkInputRulePlugin)
    .use(clipboardPlugin)
    .use(history)
    .use(keymap)
    .use(listener)
    .use(placeholderPlugin);
}

function withAriaLabel(
  attributes:
    | Record<string, string>
    | ((state: import('@milkdown/prose/state').EditorState) => Record<string, string>),
  ariaLabel: string,
): typeof attributes {
  if (typeof attributes === 'function') {
    return (state) => ({ ...attributes(state), 'aria-label': ariaLabel });
  }
  return { ...attributes, 'aria-label': ariaLabel };
}

function addOptionalPlugins(
  builder: EditorBuilder,
  placeholderCompletion: EditorConfig['placeholderCompletion'],
  placeholderDecoration: EditorConfig['placeholderDecoration'],
  plugins: NonNullable<EditorConfig['plugins']>,
): EditorBuilder {
  if (placeholderCompletion) {
    builder = builder.use(createTemplateCompletionPlugin(() => placeholderCompletion));
  }
  if (placeholderDecoration) {
    builder = builder.use(
      createTemplateInvalidDecorationPlugin(
        () => placeholderDecoration.candidates,
        placeholderDecoration.invalidClassName
          ? () => placeholderDecoration.invalidClassName!
          : undefined,
      ),
    );
  }
  for (const plugin of plugins) builder = builder.use(plugin);
  return builder;
}

function createMarkdownChangeHandler(
  isDestroyed: () => boolean,
  isExternalUpdate: () => boolean,
  timer: { value: ReturnType<typeof setTimeout> | null },
  setPendingInternalChange: (pending: boolean) => void,
  onchange: EditorConfig['onchange'],
  debounceMs: number,
): (markdown: string, previousMarkdown: string) => void {
  return (markdown, previousMarkdown) => {
    if (isDestroyed() || isExternalUpdate() || markdown === previousMarkdown) return;
    if (timer.value) clearTimeout(timer.value);
    timer.value = setTimeout(() => {
      if (isDestroyed()) return;
      setPendingInternalChange(false);
      onchange?.(markdown);
    }, debounceMs);
  };
}

function createEditorKeymapWithCallbacks(
  onlinkshortcut: EditorConfig['onlinkshortcut'],
  onCommentShortcut: EditorConfig['onCommentShortcut'],
) {
  return createEditorKeymap({
    ...(onlinkshortcut ? { onlinkshortcut } : {}),
    ...(onCommentShortcut ? { onCommentShortcut } : {}),
  });
}

function configureView(
  view: EditorState['view'],
  isDestroyed: () => boolean,
  isExternalUpdate: () => boolean,
  readonly: boolean,
  ariaLabel: string | undefined,
  setPendingInternalChange: (pending: boolean) => void,
): void {
  const dispatchTransaction = view.props.dispatchTransaction;
  view.setProps({
    dispatchTransaction: (transaction) => {
      if (dispatchTransaction) dispatchTransaction.call(view, transaction);
      else view.updateState(view.state.apply(transaction));
      if (transaction.docChanged && !isDestroyed() && !isExternalUpdate()) {
        setPendingInternalChange(true);
      }
    },
  });
  if (readonly) view.setProps({ editable: () => false });
  applyReadonlyAria(view, readonly);
  if (ariaLabel) view.dom.setAttribute('aria-label', ariaLabel);
}

export async function createEditor(
  container: HTMLElement,
  config: EditorConfig = {},
): Promise<EditorState> {
  if (typeof document === 'undefined') {
    throw new Error('createEditor() requires a browser document.');
  }

  const [
    { Editor, rootCtx, defaultValueCtx, editorViewCtx, editorViewOptionsCtx },
    { commonmark, listItemKeymap },
    { gfm, tableKeymap },
    { history },
    { listener, listenerCtx },
    { placeholderPlugin },
    { clipboardPlugin },
    { linkInputRulePlugin },
  ] = await Promise.all([
    import('@milkdown/kit/core'),
    import('@milkdown/kit/preset/commonmark'),
    import('@milkdown/kit/preset/gfm'),
    import('@milkdown/kit/plugin/history'),
    import('@milkdown/kit/plugin/listener'),
    import('./placeholder.js'),
    import('./clipboard.js'),
    import('./link-input-rule.js'),
  ]);
  await preloadCommandRuntime();
  await preloadLazyPluginRuntime();

  const {
    initialContent = '',
    readonly = false,
    ariaLabel,
    changeDebounceMs = DEFAULT_DEBOUNCE_MS,
    onchange,
    onselectionchange,
    onlinkshortcut,
    onCommentShortcut,
    plugins = [],
    placeholderCompletion,
    placeholderDecoration,
  } = config;
  const resolvedAriaLabel =
    typeof ariaLabel === 'string' && ariaLabel.trim().length > 0 ? ariaLabel.trim() : undefined;

  let isExternalUpdate = false;
  let isDestroyed = false;
  const debounceTimeout = { value: null as ReturnType<typeof setTimeout> | null };
  let hasPendingInternalChange = false;
  const onmarkdownupdated = createMarkdownChangeHandler(
    () => isDestroyed,
    () => isExternalUpdate,
    debounceTimeout,
    (pending) => {
      hasPendingInternalChange = pending;
    },
    onchange,
    changeDebounceMs,
  );

  const builder = configureEditor(
    Editor.make(),
    container,
    initialContent,
    resolvedAriaLabel,
    rootCtx,
    defaultValueCtx,
    editorViewOptionsCtx,
    listItemKeymap,
    tableKeymap,
    listenerCtx,
    editorViewCtx,
    listener,
    commonmark,
    gfm,
    linkInputRulePlugin,
    clipboardPlugin,
    history,
    placeholderPlugin,
    createEditorKeymapWithCallbacks(onlinkshortcut, onCommentShortcut),
    () => isDestroyed,
    onmarkdownupdated,
    onselectionchange,
  );
  const editor = await addOptionalPlugins(
    builder,
    placeholderCompletion,
    placeholderDecoration,
    plugins,
  ).create();

  const view = editor.ctx.get(editorViewCtx);

  configureView(
    view,
    () => isDestroyed,
    () => isExternalUpdate,
    readonly,
    resolvedAriaLabel,
    (pending) => {
      hasPendingInternalChange = pending;
    },
  );

  const state: EditorState = {
    editor,
    view,

    focus() {
      view?.focus();
    },

    getMarkdown() {
      return editor.action(getMarkdown());
    },

    hasPendingInternalChange() {
      return hasPendingInternalChange;
    },

    setMarkdown(content: string) {
      // Clear any pending debounce to prevent stale callbacks
      if (debounceTimeout.value) {
        clearTimeout(debounceTimeout.value);
        debounceTimeout.value = null;
      }

      hasPendingInternalChange = false;
      isExternalUpdate = true;
      try {
        editor.action(replaceAll(content));
      } finally {
        isExternalUpdate = false;
      }
    },

    clearPendingTimers() {
      if (debounceTimeout.value) {
        clearTimeout(debounceTimeout.value);
        debounceTimeout.value = null;
      }
    },

    markDestroyed() {
      isDestroyed = true;
    },
  };

  return state;
}

export { destroyEditor, setEditorReadonly } from './editor-lifecycle.ts';
