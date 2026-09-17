<script lang="ts">
  import {
    ReviewEditor,
    createReviewEditorState,
    toPersistedThreads,
    toRuntimeThreads,
    type PersistedThread,
    type ReviewState,
    type Thread,
  } from '@repo/editor';
  import {
    EDITED_DOCUMENT,
    ORIGINAL_DOCUMENT,
    keysOf,
    seededThread,
  } from './state-session-utilities';

  let original = $state(ORIGINAL_DOCUMENT);
  let value = $state(EDITED_DOCUMENT);
  let threads = $state<Thread[]>([seededThread()]);

  let editor: ReturnType<typeof ReviewEditor> | undefined;

  let events = $state<string[]>([]);
  const record = (entry: string) => {
    events = [...events, entry];
  };

  const IMPERATIVE_METHODS = [
    'clearAllThreads',
    'createBlockThread',
    'createComment',
    'createDocumentThread',
    'createThread',
    'deleteComment',
    'deleteThread',
    'exportMarkdownSummary',
    'exportUnifiedDiff',
    'focus',
    'getAst',
    'getEditor',
    'getFormData',
    'getMarkdown',
    'getSelection',
    'getState',
    'getView',
    'reset',
    'scrollToThread',
    'setMarkdown',
    'setState',
    'updateComment',
  ] as const;

  let instanceOwnKeys = $state('(not probed)');
  let instanceCallableMethods = $state('(not probed)');
  let instanceCallableCount = $state('(not probed)');

  function probeInstance(): void {
    const instance = editor as unknown as Record<string, unknown> | undefined;
    if (!instance) {
      instanceOwnKeys = '(no instance)';
      instanceCallableMethods = '(no instance)';
      instanceCallableCount = '(no instance)';
      return;
    }
    instanceOwnKeys = Object.keys(instance).toSorted().join(',');
    const callable = IMPERATIVE_METHODS.filter((name) => typeof instance[name] === 'function');
    instanceCallableMethods = callable.join(',');
    instanceCallableCount = `${callable.length}/${IMPERATIVE_METHODS.length}`;
  }

  let capturedJson = $state('');
  let stateSchemaVersion = $state('(not captured)');
  let stateKeys = $state('(not captured)');
  let stateJsonKeys = $state('(not captured)');
  let stateAnchorKeys = $state('(not captured)');
  let stateJsonAnchorKeys = $state('(not captured)');
  let stateReviewSession = $state('(not captured)');
  let stateFrontMatter = $state('(not captured)');
  let stateOriginalLength = $state('(not captured)');

  function captureState(): void {
    const state = editor?.getState();
    if (!state) return;
    const json = JSON.stringify(state);
    const parsed = JSON.parse(json) as ReviewState;

    capturedJson = json;
    stateSchemaVersion = String(state.schemaVersion);
    stateKeys = keysOf(state);
    stateJsonKeys = keysOf(parsed);
    stateAnchorKeys = state.threads[0] ? keysOf(state.threads[0].anchor) : '(no threads)';
    stateJsonAnchorKeys = parsed.threads[0] ? keysOf(parsed.threads[0].anchor) : '(no threads)';
    stateReviewSession = `in-memory-key=${'reviewSession' in state} value=${String(
      state.reviewSession,
    )} after-json-key=${'reviewSession' in parsed}`;
    stateFrontMatter = `frontMatter=${JSON.stringify(state.frontMatter ?? null)} frontMatterRaw=${JSON.stringify(state.frontMatterRaw ?? null)}`;
    stateOriginalLength = String(state.original?.length ?? 0);
  }

  function parseCaptured(): ReviewState | null {
    if (!capturedJson) return null;
    return JSON.parse(capturedJson) as ReviewState;
  }

  /** Round-trip the captured state verbatim. */
  function restoreCaptured(): void {
    const state = parseCaptured();
    if (state) editor?.setState(state);
  }

  /**
   * Restore the same threads against a document that has grown a preface.
   * The persisted anchor carries no `from`/`to`, so the only way the thread
   * can land correctly is for setState to re-anchor by quote.
   */
  function restoreIntoShiftedDocument(): void {
    const state = parseCaptured();
    if (!state) return;
    editor?.setState({
      ...state,
      content: `# Preface\n\nA section inserted ahead of the reviewed heading.\n\n${state.content}`,
    });
  }

  /** Restore into a document where the anchored quote no longer exists. */
  function restoreWithQuoteRemoved(): void {
    const state = parseCaptured();
    if (!state) return;
    editor?.setState({
      ...state,
      content: '# Retitled\n\nThe quoted heading text is gone from this revision.',
    });
  }

  /** setState is the only reachable writer for the bindable `original`. */
  function restoreWithDifferentOriginal(): void {
    const state = parseCaptured();
    if (!state) return;
    editor?.setState({
      ...state,
      original: `${state.original ?? ''}\n\nAn extra baseline paragraph.`,
    });
  }

  /** Feed a v1 state back in and see what version comes out. */
  let schemaVersionAfterRestore = $state('(not restored)');
  function restoreAsSchemaVersionOne(): void {
    const state = parseCaptured();
    if (!state) return;
    editor?.setState({ ...state, schemaVersion: 1 });
    schemaVersionAfterRestore = String(editor?.getState().schemaVersion ?? '(no instance)');
  }

  /**
   * `toPersistedThreads` is the same lossy projection getState() applies, but
   * exported for callers doing their own persistence.
   */
  let toPersistedAnchorKeys = $state('(not probed)');
  function probeToPersistedThreads(): void {
    const persisted = toPersistedThreads(threads);
    toPersistedAnchorKeys = persisted[0] ? keysOf(persisted[0].anchor) : '(no threads)';
  }

  const moduleState = createReviewEditorState({
    getOriginal: () => original,
    getValue: () => value,
    getThreads: () => threads,
  });

  function persistedFixture(): PersistedThread[] {
    return [
      {
        id: 'thread-persisted-heading',
        createdAt: '2026-08-11T09:00:00.000Z',
        anchor: {
          quote: 'Release Plan',
          prefix: '# ',
          suffix: '\n\nThe first release',
          status: 'anchored',
        },
        comments: [
          {
            id: 'comment-persisted-heading',
            threadId: 'thread-persisted-heading',
            authorId: 'maya',
            body: 'Restored from storage with no runtime positions.',
            createdAt: '2026-08-11T09:00:00.000Z',
          },
        ],
      },
      {
        id: 'thread-persisted-inline',
        createdAt: '2026-08-11T09:00:00.000Z',
        anchor: {
          quote: 'export actions',
          prefix: 'a dashboard, ',
          suffix: ', and inline review.',
          status: 'anchored',
        },
        comments: [
          {
            id: 'comment-persisted-inline',
            threadId: 'thread-persisted-inline',
            authorId: 'maya',
            body: 'Same restore path, but the quote sits mid-paragraph.',
            createdAt: '2026-08-11T09:00:00.000Z',
          },
        ],
      },
    ];
  }

  let persistedSeededThreads = $state<Thread[]>(toRuntimeThreads(persistedFixture()));
  const persistedSeededAnchor = $derived(persistedSeededThreads[0]?.anchor);
  const persistedAnchorWidths = $derived(
    persistedSeededThreads
      .map(
        (thread) =>
          `${thread.anchor.quote}:width=${thread.anchor.to - thread.anchor.from}/quote=${thread.anchor.quote.length}`,
      )
      .join(' '),
  );
</script>

<section style="display: grid; gap: 0.5rem;">
  <h2 style="margin: 0;">Live editor (imperative state round-trip)</h2>
  <div style="min-height: 30rem;">
    <ReviewEditor
      bind:this={editor}
      id="state-editor"
      bind:original
      bind:value
      bind:threads
      currentUserId="steve"
      onthreaddelete={(event) => record(`threaddelete:${event.threadId}`)}
      onchange={(next) => record(`change:${next.length}`)}
    />
  </div>

  <div style="display: flex; flex-wrap: wrap; gap: 0.5rem;">
    <button type="button" data-testid="probe-instance" onclick={probeInstance}>
      probe bind:this
    </button>
    <button type="button" data-testid="capture-state" onclick={captureState}>getState()</button>
    <button type="button" data-testid="restore-state" onclick={restoreCaptured}>
      setState(captured)
    </button>
    <button type="button" data-testid="restore-shifted" onclick={restoreIntoShiftedDocument}>
      setState(captured + preface)
    </button>
    <button type="button" data-testid="restore-quote-gone" onclick={restoreWithQuoteRemoved}>
      setState(quote removed)
    </button>
    <button type="button" data-testid="restore-new-original" onclick={restoreWithDifferentOriginal}>
      setState(new original)
    </button>
    <button type="button" data-testid="restore-v1" onclick={restoreAsSchemaVersionOne}>
      setState(schemaVersion 1)
    </button>
    <button
      type="button"
      data-testid="probe-to-persisted-threads"
      onclick={probeToPersistedThreads}
    >
      toPersistedThreads(threads)
    </button>
  </div>

  <h3 style="margin: 0.5rem 0 0; font-size: 0.9rem;">Observed state</h3>
  <p data-testid="instance-own-keys" style="margin: 0;">instance own keys: {instanceOwnKeys}</p>
  <p data-testid="instance-callable-count" style="margin: 0;">
    callable methods: {instanceCallableCount}
  </p>
  <p data-testid="instance-callable-methods" style="margin: 0; overflow-wrap: anywhere;">
    {instanceCallableMethods}
  </p>
  <p data-testid="state-schema-version" style="margin: 0;">
    schemaVersion: {stateSchemaVersion}
  </p>
  <p data-testid="state-keys" style="margin: 0; overflow-wrap: anywhere;">
    state keys: {stateKeys}
  </p>
  <p data-testid="state-json-keys" style="margin: 0; overflow-wrap: anywhere;">
    state keys after JSON: {stateJsonKeys}
  </p>
  <p data-testid="state-anchor-keys" style="margin: 0; overflow-wrap: anywhere;">
    anchor keys: {stateAnchorKeys}
  </p>
  <p data-testid="state-json-anchor-keys" style="margin: 0; overflow-wrap: anywhere;">
    anchor keys after JSON: {stateJsonAnchorKeys}
  </p>
  <p data-testid="state-review-session" style="margin: 0;">reviewSession: {stateReviewSession}</p>
  <p data-testid="state-front-matter" style="margin: 0;">{stateFrontMatter}</p>
  <p data-testid="state-original-length" style="margin: 0;">
    state.original length: {stateOriginalLength}
  </p>
  <p data-testid="schema-version-after-restore" style="margin: 0;">
    schemaVersion after restoring a v1 state: {schemaVersionAfterRestore}
  </p>
  <p data-testid="to-persisted-anchor-keys" style="margin: 0; overflow-wrap: anywhere;">
    toPersistedThreads anchor keys: {toPersistedAnchorKeys}
  </p>

  <h3 style="margin: 0.5rem 0 0; font-size: 0.9rem;">Live bindable props</h3>
  <p data-testid="live-value-length" style="margin: 0;">value length: {value.length}</p>
  <!--
			`setState(getState())` is not a fixed point on `value`: the authored
			document has no trailing newline, and the content the editor
			re-serializes after a restore usually does. "Usually" is the problem —
			whether the editor re-serializes at all depends on how quickly the
			previous restore settled, so this readout flips between 0 and 1 across
			otherwise identical runs. It is rendered here to be seen, not pinned.
		-->
  <p data-testid="live-value-trailing-newlines" style="margin: 0;">
    trailing newlines: {value.length - value.replace(/\n+$/, '').length}
  </p>
  <p data-testid="live-value-has-preface" style="margin: 0;">
    contains "Preface": {value.includes('# Preface')}
  </p>
  <p data-testid="live-original-length" style="margin: 0;">original length: {original.length}</p>
  <p data-testid="live-thread-count" style="margin: 0;">threads: {threads.length}</p>
  <p data-testid="live-anchor-range" style="margin: 0;">
    anchor range: {threads[0] ? `${threads[0].anchor.from}-${threads[0].anchor.to}` : '(none)'}
  </p>
  <p data-testid="live-anchor-width" style="margin: 0;">
    anchor width: {threads[0]
      ? `${threads[0].anchor.to - threads[0].anchor.from}/quote=${threads[0].anchor.quote.length}`
      : '(none)'}
  </p>
  <p data-testid="live-anchor-quote" style="margin: 0;">
    anchor quote: {threads[0]?.anchor.quote ?? '(none)'}
  </p>
  <ul data-testid="event-log" style="margin: 0; padding-left: 1.25rem;">
    {#each events as entry, index (`${index}-${entry}`)}
      <li>{entry}</li>
    {/each}
  </ul>
</section>

<section style="display: grid; gap: 0.5rem;">
  <h2 style="margin: 0;">createReviewEditorState() — exported, consumed by nothing</h2>
  <div style="display: flex; flex-wrap: wrap; gap: 0.5rem;">
    <button
      type="button"
      data-testid="module-set-diff-view"
      onclick={() => moduleState.setActiveView('diff')}
    >
      setActiveView('diff')
    </button>
    <button
      type="button"
      data-testid="module-set-diff-mode"
      onclick={() => moduleState.setDiffViewMode('original')}
    >
      setDiffViewMode('original')
    </button>
  </div>
  <p data-testid="module-active-view" style="margin: 0;">activeView: {moduleState.activeView}</p>
  <p data-testid="module-diff-view-mode" style="margin: 0;">
    diffViewMode: {moduleState.diffViewMode}
  </p>
  <p data-testid="module-comment-count" style="margin: 0;">
    commentCount: {moduleState.commentCount}
  </p>
  <p data-testid="module-has-changes" style="margin: 0;">
    hasContentChanges: {moduleState.hasContentChanges}
  </p>
</section>

<section style="display: grid; gap: 0.5rem;">
  <h2 style="margin: 0;">Editor seeded with PersistedThread[] (no runtime positions)</h2>
  <div style="min-height: 26rem;">
    <ReviewEditor
      id="state-persisted"
      original={ORIGINAL_DOCUMENT}
      value={EDITED_DOCUMENT}
      bind:threads={persistedSeededThreads}
      currentUserId="steve"
    />
  </div>
  <p data-testid="persisted-anchor-keys" style="margin: 0; overflow-wrap: anywhere;">
    seeded anchor keys: {persistedSeededAnchor ? keysOf(persistedSeededAnchor) : '(no thread)'}
  </p>
  <p data-testid="persisted-anchor-range" style="margin: 0;">
    seeded anchor range: {persistedSeededAnchor
      ? `from=${persistedSeededAnchor.from} to=${persistedSeededAnchor.to}`
      : '(no thread)'}
  </p>
  <p data-testid="persisted-anchor-widths" style="margin: 0; overflow-wrap: anywhere;">
    {persistedAnchorWidths}
  </p>
  <p data-testid="persisted-thread-count" style="margin: 0;">
    threads: {persistedSeededThreads.length}
  </p>
</section>
