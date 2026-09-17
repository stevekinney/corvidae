<script lang="ts">
  import { MarkdownEditor } from '@repo/editor';
  import type { EditorMode, ToolbarContext } from '@repo/editor';
  import type { MilkdownPlugin } from '@milkdown/ctx';
  import { TextSelection } from 'prosemirror-state';
  import { tick } from 'svelte';

  import {
    INITIAL,
    MAIN_ID,
    MARKER,
    PROBE_A,
    PROBE_B,
    QUOTE_FROM,
    QUOTE_TO,
    READONLY_ID,
    READONLY_INITIAL,
    REPLACEMENT,
    HEADING_FROM,
    HEADING_TO,
    probeDecorationPlugin,
  } from './markdown-editor-fixtures.ts';

  // `$state.raw`, not `$state`. A deep `$state` array hands Milkdown a Proxy of
  // itself, and this array is only ever REPLACED, never mutated — so the deep
  // proxy would buy nothing while putting a reactivity wrapper between the
  // plugin objects and the library that consumes them.
  let activePlugins = $state.raw<MilkdownPlugin[]>([probeDecorationPlugin(PROBE_A)]);

  // Bumping this re-keys the editor, which is the ONLY thing that makes a new
  // `plugins` array take effect through this page's controls. (A wysiwyg → source
  // → wysiwyg round trip is a second remount path, since the `{#if mode ===
  // 'wysiwyg'}` branch tears the host element down and the attachment re-reads its
  // getters on the way back — so `{#key}` is the explicit path, not the only one.)
  let remountToken = $state(0);

  // How many times the editor has reported itself ready. It stays at 1 through a
  // plugin swap and goes to 2 on a remount, which is the second, independent
  // observable for "was this editor re-created" — the first being whether the old
  // decoration is still in the DOM.
  let readyCount = $state(0);

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let value = $state(INITIAL);
  let mode = $state<EditorMode>('wysiwyg');
  let readonlyValue = $state(READONLY_INITIAL);

  let handle = $state<ReturnType<typeof MarkdownEditor>>();

  let lastCall = $state('(none)');

  // Every `onselectionchange` notification, in order. This is a DIFFERENT surface
  // from `getSelection()` and the difference is the point — see the readouts
  // section below.
  let selectionEvents = $state<string[]>([]);
  let modeEvents = $state<string[]>([]);
  let changeEvents = $state(0);

  // ---------------------------------------------------------------------------
  // Announcements
  // ---------------------------------------------------------------------------

  // Every control on this page reports a value that is otherwise only visible as
  // text somewhere further down the page, so an action taken without sight needs
  // an outcome. Two rules carried over from `review-imperative`, both of which
  // were learned there the hard way:
  //
  //  1. Nothing is INFERRED. Each summary is derived from something observed
  //     after the call — the actual `document.activeElement`, the actual markdown,
  //     the actual thrown error — never from "the method returned, so it worked".
  //  2. Identical text still re-announces. `aria-live` fires on CHANGE, so
  //     pressing the same button twice would otherwise be silent from the second
  //     press onward, on a page where re-pressing to check is the obvious move.
  let announcement = $state('');
  let announceMutations = $state(0);
  let regionNode = $state<HTMLElement | null>(null);

  $effect(() => {
    if (!regionNode) return;
    const observer = new MutationObserver((records) => {
      announceMutations += records.length;
    });
    observer.observe(regionNode, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  });

  function announce(text: string) {
    announcement = '';
    // Next microtask, so the region genuinely transitions rather than being
    // assigned the string it already holds. Counting real DOM mutations
    // (`announceMutations`) is what makes deleting this observable — a log of
    // what we asked to say would record an entry either way.
    queueMicrotask(() => {
      announcement = text;
    });
  }

  function record(name: string, summary: string) {
    lastCall = name;
    announce(`${name}: ${summary}`);
  }

  /** Announcements are read aloud, so a count that says "1 characters" is a defect. */
  function plural(count: number, word: string): string {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
  }

  // ---------------------------------------------------------------------------
  // Readouts
  // ---------------------------------------------------------------------------

  let markdownJson = $state('null');
  let astJson = $state('null');
  let astError = $state('');
  let selectionJson = $state('null');
  let viewJson = $state('null');
  let editorJson = $state('null');
  let focusJson = $state('null');
  let readonlyToolbarContextText = $state('(not reported)');

  // Derived rather than inlined into the markup, so each readout fits on one
  // line and its `<p>` holds nothing but the payload. A wrapped expression puts
  // indentation whitespace inside the element, which `JSON.parse` tolerates and
  // a `.split('|')` on the raw text does not.
  const valueJson = $derived(JSON.stringify(value));
  const selectionEventsText = $derived(selectionEvents.join('|'));

  type MdastLike = { type: string; depth?: number; value?: string; children?: MdastLike[] };

  function flattenText(node: MdastLike): string {
    if (typeof node.value === 'string') return node.value;
    return (node.children ?? []).map(flattenText).join('');
  }

  function describeToolbarContext(context: ToolbarContext): string {
    return [
      `ctx=${context.editorContext === null ? 'no' : 'yes'}`,
      `undo=${context.canUndo}`,
      `redo=${context.canRedo}`,
      `ro=${context.readonly}`,
    ].join(' ');
  }

  // ---------------------------------------------------------------------------
  // The seven methods
  // ---------------------------------------------------------------------------

  function readMarkdown() {
    const markdown = handle?.getMarkdown() ?? '';
    markdownJson = JSON.stringify(markdown);
    record('getMarkdown', plural(markdown.length, 'character'));
  }

  function applySetMarkdown(content: string) {
    handle?.setMarkdown(content);
    // Observed, not assumed. `setMarkdown` has two branches — it drives the live
    // editor when one exists and falls back to assigning `value` when it does not
    // — and neither returns anything, so reading the document back is the only
    // honest way to say what happened.
    const after = handle?.getMarkdown() ?? '';
    markdownJson = JSON.stringify(after);
    record(
      'setMarkdown',
      after.trim() === content.trim()
        ? 'the document now matches what was set'
        : 'the document does not match what was set',
    );
  }

  function readAst() {
    try {
      const root = handle?.getAst();
      const children = ((root?.children ?? []) as unknown as MdastLike[]).map((child) => ({
        type: child.type,
        depth: child.depth ?? null,
        text: flattenText(child),
      }));
      astError = '';
      astJson = JSON.stringify({ type: root?.type ?? null, children });
      record('getAst', plural(children.length, 'top-level node'));
    } catch (error) {
      // The readiness trap. `getAst()` calls into the markdown pipeline, which
      // arrives on its own dynamic import with no readiness signal of its own —
      // `onready` and `data-ready` come from the Milkdown attachment and say
      // nothing about it. Surfacing the error rather than swallowing it is what
      // lets a test poll for the second path to land.
      astJson = 'null';
      astError = error instanceof Error ? error.message : String(error);
      record('getAst', `threw: ${astError}`);
    }
  }

  function readSelection() {
    const selection = handle?.getSelection() ?? null;
    const view = handle?.getView() ?? null;
    if (!selection || !view) {
      selectionJson = JSON.stringify({ selection: null, derived: null });
      record('getSelection', 'there is no selection to report');
      return;
    }

    // THE SECOND COORDINATE SPACE, derived here because `getSelection()` does not
    // return one. `from`/`to` are ProseMirror positions; `offset` and `length`
    // are `doc.textBetween()` offsets, which count characters and ignore node
    // boundaries. For the same selection they are different numbers, and mixing
    // them up is the trap `CLAUDE.md` documents for anchors.
    const offset = view.state.doc.textBetween(0, selection.from, '\n').length;
    const quote = view.state.doc.textBetween(selection.from, selection.to, '\n');

    selectionJson = JSON.stringify({
      selection: { from: selection.from, to: selection.to, isCollapsed: selection.isCollapsed },
      // Declared on `EditorSelection` as "mapped to mdast position via bridge
      // (when available)" and never populated by this component — the bridge
      // that computes it is not on any path MarkdownEditor takes. Rendered so a
      // test can pin that rather than leaving a consumer to discover it.
      sourcePosition: selection.sourcePosition ?? null,
      derived: { offset, length: quote.length, quote },
    });
    record(
      'getSelection',
      selection.isCollapsed
        ? `a collapsed caret at ProseMirror position ${selection.from}`
        : `ProseMirror ${selection.from} to ${selection.to}, text offset ${offset}`,
    );
  }

  type EditorViewHandle = ReturnType<NonNullable<typeof handle>['getView']>;
  const editorDocSize = (view: EditorViewHandle | null) => view?.state.doc.content.size ?? null;
  const editorDomIsProseMirror = (view: EditorViewHandle | null) =>
    view?.dom.classList.contains('ProseMirror') ?? null;
  function editorDomIsHost(view: EditorViewHandle | null, host: HTMLElement | null) {
    return view !== null && host !== null && view.dom === host;
  }
  function editorDomInsideHost(view: EditorViewHandle | null, host: HTMLElement | null) {
    return view !== null && host !== null && host.contains(view.dom);
  }
  function editorViewJson(view: EditorViewHandle | null): string {
    const host = document.getElementById(MAIN_ID);
    return JSON.stringify({
      present: view !== null,
      docSize: editorDocSize(view),
      domIsProseMirror: editorDomIsProseMirror(view),
      domIsHost: editorDomIsHost(view, host),
      domInsideHost: editorDomInsideHost(view, host),
      editable: view?.editable ?? null,
    });
  }
  function readView() {
    const view = handle?.getView() ?? null;
    viewJson = editorViewJson(view);
    record(
      'getView',
      view === null ? 'no view is mounted' : `document size ${view.state.doc.content.size}`,
    );
  }

  function readEditor() {
    const editor = handle?.getEditor() ?? null;
    // Proving the handle is a live Milkdown Editor rather than a stub, without
    // importing anything from `@milkdown/kit/core`: `action` runs a callback
    // against the editor's own Ctx synchronously and returns its result, so a
    // working editor is one where the ctx handed to the callback IS `editor.ctx`.
    const probe = editor ? editor.action((ctx) => ({ ctx, result: 'ran' })) : null;
    editorJson = JSON.stringify({
      present: editor !== null,
      actionResult: probe?.result ?? null,
      actionCtxIsEditorCtx: probe !== null && editor !== null && probe.ctx === editor.ctx,
    });
    record('getEditor', editor === null ? 'no editor is mounted' : 'the editor handle answered');
  }

  function readFocus() {
    const active = document.activeElement;
    const host = document.getElementById(MAIN_ID);
    focusJson = JSON.stringify({
      tag: active?.tagName ?? null,
      isProseMirror: active instanceof HTMLElement && active.classList.contains('ProseMirror'),
      isHost: active !== null && active === host,
      insideMainEditor: host !== null && active !== null && host.contains(active),
    });
  }

  function focusEditor() {
    handle?.focus();
    readFocus();
    const landed = JSON.parse(focusJson).insideMainEditor === true;
    // This is the ONE control on the page that moves focus deliberately —
    // it is the method under test. Every other control that touches the editor
    // leaves focus alone (see `select` below), because a button that silently
    // relocates focus into a rich-text surface is the defect `review-imperative`
    // found the hard way. Announcing the move is what keeps this one honest.
    record(
      'focus',
      landed ? 'focus moved into the editing surface' : 'focus did not reach the editor',
    );
  }

  // ---------------------------------------------------------------------------
  // Driving a selection
  // ---------------------------------------------------------------------------

  /**
   * Put an exact selection in the view through the public `getView()`.
   *
   * Deliberately does NOT call `view.focus()`. ProseMirror applies a transaction
   * to an unfocused view perfectly well, `getSelection()` reads `view.state`
   * whatever the focus is, and Milkdown's listener fires from `state.apply` — so
   * focusing would buy nothing and would cost a keyboard user twenty-odd tab
   * stops per press.
   *
   * ONE selection-changing dispatch, which is the thing that used to be
   * insufficient: before `@repo/editor@0.9.1` the selection listener
   * re-read `view.state` from inside `EditorState.apply`, where it is still the
   * PREVIOUS state, so every notification lagged by exactly one transaction. The
   * fix hands the listener Milkdown's live `tr.selection` instead.
   */
  async function select(from: number, to: number) {
    const view = handle?.getView();
    if (!view) return;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
    await tick();
    readSelection();
  }

  async function swapPlugins() {
    activePlugins = [probeDecorationPlugin(PROBE_B)];
    await tick();
    // Observed rather than asserted from the contract: count what is actually in
    // the DOM after the reassignment settles.
    const host = document.getElementById(MAIN_ID);
    const stale = host?.querySelectorAll(`.${PROBE_A}`).length ?? 0;
    const fresh = host?.querySelectorAll(`.${PROBE_B}`).length ?? 0;
    record(
      'plugins reassigned',
      `the mounted editor still shows ${plural(stale, 'decoration')} from the original plugin and ${plural(fresh, 'decoration')} from the new one`,
    );
  }

  function remountEditor() {
    remountToken += 1;
    // Phrased as a request rather than a result on purpose. The new editor boots
    // asynchronously, so anything this function could measure now would describe
    // the OLD one; `ready-count` is where the outcome shows up when it lands.
    record('remount', `remount ${remountToken} requested; a new editor re-reads the plugins prop`);
  }
</script>

<div style="max-width: 60rem; margin: 0 auto; padding: 2rem 1rem; display: grid; gap: 1.5rem;">
  <header>
    <h1>Markdown Editor</h1>
    <p>
      Drives all seven imperative methods on the standalone <code>MarkdownEditor</code> through
      <code>bind:this</code>, alongside the <code>plugins</code> seam ReviewEditor is built on.
    </p>
  </header>

  <section aria-labelledby="controls-heading">
    <h2 id="controls-heading">Imperative surface</h2>
    <div style="display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.75rem;">
      <button data-testid="focus-editor" onclick={focusEditor}>focus</button>
      <button data-testid="read-markdown" onclick={readMarkdown}>getMarkdown</button>
      <button data-testid="set-markdown" onclick={() => applySetMarkdown(REPLACEMENT)}>
        setMarkdown
      </button>
      <button data-testid="read-ast" onclick={readAst}>getAst</button>
      <button data-testid="read-selection" onclick={readSelection}>getSelection</button>
      <button data-testid="read-view" onclick={readView}>getView</button>
      <button data-testid="read-editor" onclick={readEditor}>getEditor</button>
      <button data-testid="select-quote" onclick={() => select(QUOTE_FROM, QUOTE_TO)}>
        select "{MARKER}"
      </button>
      <button data-testid="select-heading" onclick={() => select(HEADING_FROM, HEADING_TO)}>
        select the heading
      </button>
      <button data-testid="collapse-caret" onclick={() => select(QUOTE_FROM, QUOTE_FROM)}>
        collapse the caret
      </button>
      <button data-testid="clear-selection-events" onclick={() => (selectionEvents = [])}>
        clear selection events
      </button>
    </div>
  </section>

  <section aria-labelledby="plugins-heading">
    <h2 id="plugins-heading">Plugin seam</h2>
    <div style="display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.75rem;">
      <button data-testid="swap-plugins" onclick={swapPlugins}>reassign plugins</button>
      <button data-testid="remount-editor" onclick={remountEditor}>remount the editor</button>
    </div>
  </section>

  <section aria-labelledby="mode-heading">
    <h2 id="mode-heading">Mode</h2>
    <div style="display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.75rem;">
      <button data-testid="mode-source" onclick={() => (mode = 'source')}>bind mode: source</button>
      <button data-testid="mode-wysiwyg" onclick={() => (mode = 'wysiwyg')}>
        bind mode: wysiwyg
      </button>
    </div>
  </section>

  <section aria-labelledby="editor-heading">
    <h2 id="editor-heading">Editable</h2>
    {#key remountToken}
      <MarkdownEditor
        bind:this={handle}
        data-testid="main-editor"
        id={MAIN_ID}
        label="Release plan draft"
        bind:value
        bind:mode
        showModeToggle
        plugins={activePlugins}
        onready={() => {
          readyCount += 1;
        }}
        onchange={() => {
          changeEvents += 1;
        }}
        onmodechange={(next) => {
          modeEvents = [...modeEvents, next];
        }}
        onselectionchange={(selection) => {
          // The notification surface, kept separate from `getSelection()` on
          // purpose: `getSelection()` reads `view.state` at CALL time and was
          // always correct, while this callback fires from inside
          // `EditorState.apply` and was one transaction behind until
          // `@repo/editor@0.9.1`. Recording every notification is what
          // makes that difference measurable rather than folklore.
          selectionEvents = [
            ...selectionEvents,
            selection ? `${selection.from}:${selection.to}:${selection.isCollapsed}` : 'null',
          ];
        }}
      >
        {#snippet toolbarActions(context)}
          <span data-testid="toolbar-context" style="font-size: 0.7rem; white-space: nowrap;">
            {describeToolbarContext(context)}
          </span>
        {/snippet}
      </MarkdownEditor>
    {/key}
  </section>

  <section aria-labelledby="readonly-heading">
    <h2 id="readonly-heading">Readonly</h2>
    <MarkdownEditor
      data-testid="readonly-editor"
      id={READONLY_ID}
      label="Published release plan"
      readonly
      bind:value={readonlyValue}
      ontoolbarcontextchange={(context) => {
        // `readonly` suppresses the toolbar entirely, so this callback is the
        // only way a consumer hosting its own formatting controls can learn the
        // editor's state. Recording it pins that the context still flows.
        readonlyToolbarContextText = describeToolbarContext(context);
      }}
    />
  </section>

  <p
    aria-live="polite"
    aria-atomic="true"
    bind:this={regionNode}
    data-testid="announcement"
    style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;"
  >
    {announcement}
  </p>

  <section
    aria-labelledby="readouts-heading"
    style="font-family: ui-monospace, monospace; font-size: 0.8rem; display: grid; gap: 0.25rem;"
  >
    <h2 id="readouts-heading" style="font-family: inherit;">Readouts</h2>
    <p data-testid="last-call" style="margin: 0;">last call: {lastCall}</p>
    <p data-testid="ready-count" style="margin: 0;">{readyCount}</p>
    <p data-testid="mode-readout" style="margin: 0;">{mode}</p>
    <p data-testid="markdown-json" style="margin: 0; word-break: break-all;">{markdownJson}</p>
    <p data-testid="value-json" style="margin: 0; word-break: break-all;">{valueJson}</p>
    <p data-testid="ast-json" style="margin: 0; word-break: break-all;">{astJson}</p>
    <p data-testid="ast-error" style="margin: 0; word-break: break-all;">{astError}</p>
    <p data-testid="selection-json" style="margin: 0; word-break: break-all;">{selectionJson}</p>
    <p data-testid="view-json" style="margin: 0; word-break: break-all;">{viewJson}</p>
    <p data-testid="editor-json" style="margin: 0; word-break: break-all;">{editorJson}</p>
    <p data-testid="focus-json" style="margin: 0; word-break: break-all;">{focusJson}</p>
    <p data-testid="selection-events" style="margin: 0;">{selectionEventsText}</p>
    <p data-testid="mode-events" style="margin: 0;">{modeEvents.join('|')}</p>
    <p data-testid="change-count" style="margin: 0;">{changeEvents}</p>
    <p data-testid="ro-toolbar-context" style="margin: 0;">{readonlyToolbarContextText}</p>
    <p data-testid="announce-mutations" style="margin: 0;">{announceMutations}</p>
  </section>
</div>
