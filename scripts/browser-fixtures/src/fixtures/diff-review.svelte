<script lang="ts">
  /**
   * COR-509 / DR-6 browser fixture: real, executable examples for a single
   * Markdown pair, a multi-file source patch, and a mixed-target session,
   * plus standalone DiffViewer/SourceDiffViewer examples paired with
   * DiffReviewComments. Every mount imports the real state/exporters and
   * components -- no copied controller.
   */
  import {
    DiffReview,
    DiffReviewComments,
    DiffViewer,
    createDiffReviewState,
    reduceDiffReviewState,
  } from '@lostgradient/editor';
  import type {
    DiffReviewComment,
    DiffReviewState,
    DiffReviewTargetInput,
  } from '@lostgradient/editor';
  import { SourceDiffViewer } from '@lostgradient/cinder';

  // COR-511 / DR-8 review-states coverage (empty, binary, truncated,
  // invalid-target, current/outdated/removed navigation, and mid-session
  // staleness) is gated behind `?states=1` so the baseline fixture-scenario
  // tests above don't pay for an extra ~100KB padded document and several
  // extra mounts on every page load.
  const statesScenarioEnabled =
    new URLSearchParams(globalThis.location.search).get('states') === '1';

  // `DiffViewer`'s and `SourceDiffViewer`'s own `*Ref` types aren't part of
  // either package's public export surface (only the components themselves
  // are) -- these structural shapes cover exactly the two methods this
  // fixture calls, matching each real ref's public shape by structure
  // rather than reaching into either package's internal module path.
  type FocusResult = { status: 'focused' | 'unavailable' };
  type StandaloneDiffViewerRef = {
    focusAnchor: (anchor: { side: 'old' | 'new'; startLine: number }) => FocusResult;
  };
  type StandaloneSourceDiffViewerRef = {
    focusFile: (fileOccurrence: number) => FocusResult;
    focusAnchor: (anchor: {
      fileOccurrence: number;
      hunkOccurrence: number;
      side: 'old' | 'new';
      startLine: number;
    }) => FocusResult;
  };

  function initialState(targets: DiffReviewTargetInput[]): DiffReviewState {
    const created = createDiffReviewState(targets);
    if (!created.ok) throw new Error('Fixture setup failed: invalid target list.');
    return created.value;
  }

  // -- Scenario 1: a single Markdown pair --------------------------------
  const readmeOriginal = '# Project Plan\n\nShip login and a dashboard.';
  const readmeCurrent = '# Project Plan\n\nShip login, a dashboard, and CSV export.';
  const markdownTargets: DiffReviewTargetInput[] = [
    {
      targetId: 'readme',
      kind: 'markdown',
      label: 'README.md',
      original: readmeOriginal,
      current: readmeCurrent,
      normalizeInputs: true,
    },
  ];
  let markdownPairState = $state(initialState(markdownTargets));

  // -- Scenario 2: a multi-file source patch -------------------------------
  const sourcePatch = `diff --git a/src/one.ts b/src/one.ts
--- a/src/one.ts
+++ b/src/one.ts
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 2;
 keep();
diff --git a/src/two.ts b/src/two.ts
--- a/src/two.ts
+++ b/src/two.ts
@@ -1,2 +1,2 @@
-const b = 1;
+const b = 2;
 keep();
`;
  const sourceTargets: DiffReviewTargetInput[] = [
    { targetId: 'patch', kind: 'source', label: 'Refactor constants', patch: sourcePatch },
  ];
  let sourcePatchState = $state(initialState(sourceTargets));

  // -- Scenario 3: a mixed Markdown + source session -----------------------
  const mixedTargets: DiffReviewTargetInput[] = [
    {
      targetId: 'readme-mixed',
      kind: 'markdown',
      label: 'README.md',
      original: 'Install with npm.',
      current: 'Install with npm or bun.',
      normalizeInputs: true,
    },
    {
      targetId: 'patch-mixed',
      kind: 'source',
      label: 'Add bun support',
      patch:
        'diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-{"name":"demo"}\n+{"name":"demo","packageManager":"bun"}\n',
    },
  ];
  let mixedState = $state(initialState(mixedTargets));

  // -- Standalone viewers + DiffReviewComments (no aggregate shell) -------
  let standaloneDiffViewerState = $state(initialState(markdownTargets));
  let standaloneSourceViewerState = $state(initialState(sourceTargets));
  let standaloneDiffViewerRef = $state<StandaloneDiffViewerRef>();
  let standaloneSourceViewerRef = $state<StandaloneSourceDiffViewerRef>();

  /**
   * Comment-to-anchor navigation (COR-509 / DR-6) for a standalone
   * `DiffReviewComments` composed next to a bare `DiffViewer`: `onNavigate`
   * only ever receives a CURRENT comment, so this calls straight through to
   * the real viewer's own public `focusAnchor` -- no controller of any kind
   * is copied here.
   */
  function navigateStandaloneDiffViewer(comment: DiffReviewComment): void {
    if (comment.anchor.kind === 'file') return; // No per-file focus target on a Markdown pair.
    standaloneDiffViewerRef?.focusAnchor({
      side: comment.anchor.side,
      startLine: comment.anchor.startLine,
    });
  }

  function navigateStandaloneSourceDiffViewer(comment: DiffReviewComment): void {
    if (comment.anchor.kind === 'file') {
      standaloneSourceViewerRef?.focusFile(comment.anchor.fileOccurrence);
      return;
    }
    standaloneSourceViewerRef?.focusAnchor(comment.anchor);
  }

  // -- Scenario: empty session (no targets at all) --------------------------
  let emptyState = $state(initialState([]));

  // -- Scenario: a file with no changed lines --------------------------------
  const noChangeTargets: DiffReviewTargetInput[] = [
    {
      targetId: 'same',
      kind: 'markdown',
      label: 'same.md',
      original: 'identical',
      current: 'identical',
      normalizeInputs: false,
    },
  ];
  let noChangeState = $state(initialState(noChangeTargets));

  // -- Scenario: a binary file in a source patch -----------------------------
  const binaryPatch = `diff --git a/image.png b/image.png
index 1111111..2222222 100644
Binary files a/image.png and b/image.png differ
`;
  const binaryTargets: DiffReviewTargetInput[] = [
    { targetId: 'binary', kind: 'source', label: 'Binary update', patch: binaryPatch },
  ];
  let binaryState = $state(initialState(binaryTargets));

  // -- Scenario: a patch past SourceDiffViewer's default 1000-row render
  // limit, to exercise its own truncation notice from inside DiffReview -----
  function buildTruncatedPatch(): string {
    const lines: string[] = [
      'diff --git a/large.ts b/large.ts',
      '--- a/large.ts',
      '+++ b/large.ts',
    ];
    const hunkSize = 1200;
    lines.push(`@@ -1,${hunkSize} +1,${hunkSize} @@`);
    for (let i = 1; i <= hunkSize; i += 1) {
      lines.push(`-old line ${i}`);
      lines.push(`+new line ${i}`);
    }
    return `${lines.join('\n')}\n`;
  }
  const truncatedTargets: DiffReviewTargetInput[] = [
    { targetId: 'large', kind: 'source', label: 'Large refactor', patch: buildTruncatedPatch() },
  ];
  let truncatedState = $state(initialState(truncatedTargets));

  // -- Scenario: an invalid-target update, then a corrected one --------------
  const invalidToggleValidTargets: DiffReviewTargetInput[] = [
    {
      targetId: 'toggle',
      kind: 'markdown',
      label: 'toggle.md',
      original: 'before',
      current: 'after',
      normalizeInputs: false,
    },
  ];
  let invalidToggleTargets = $state<DiffReviewTargetInput[]>(invalidToggleValidTargets);
  let invalidToggleState = $state(initialState(invalidToggleValidTargets));
  function breakInvalidToggleTargets(): void {
    invalidToggleTargets = [
      { ...invalidToggleValidTargets[0], kind: 'nonsense' },
    ] as unknown as DiffReviewTargetInput[];
  }
  function fixInvalidToggleTargets(): void {
    invalidToggleTargets = invalidToggleValidTargets;
  }

  // -- Scenario: current -> outdated -> removed comment navigation ----------
  const navOriginal = 'Install with npm.';
  const navCurrentA = 'Install with npm or bun.';
  const navCurrentB = 'Install with yarn.';
  const navValidTarget: DiffReviewTargetInput = {
    targetId: 'nav',
    kind: 'markdown',
    label: 'nav.md',
    original: navOriginal,
    current: navCurrentA,
    normalizeInputs: true,
  };
  let navTargets = $state<DiffReviewTargetInput[]>([navValidTarget]);
  let navState = $state(initialState([navValidTarget]));
  /** Real host behavior: a live content/removal change dispatches `set-targets`
   * against the current state before the new `targets` prop is applied, so
   * `diff-review-state` latches existing comments outdated/removed exactly as
   * the contract specifies -- DiffReview itself never does this on the host's
   * behalf. */
  function changeNavContent(): void {
    const next = [{ ...navValidTarget, current: navCurrentB }];
    const result = reduceDiffReviewState(navState, { type: 'set-targets', targets: next });
    if (!result.ok) return;
    navTargets = next;
    navState = result.value;
  }
  function removeNavTarget(): void {
    const result = reduceDiffReviewState(navState, { type: 'set-targets', targets: [] });
    if (!result.ok) return;
    navTargets = [];
    navState = result.value;
  }

  // -- Scenario: mid-session staleness (manual-tier, >100KB) -----------------
  // Mirrors the `diff-viewer.svelte` fixture's own stale-annotation scenario:
  // start below every tier threshold with a saved comment visible, then grow
  // the document past the 100KB manual-tier boundary without ever calling
  // `set-targets` in a way that discards it (only the content grows).
  const staleOriginal = 'keep\nold middle\nkeep end';
  const staleCurrentBase = 'keep\nCHANGED\nkeep end';
  const stalePadding = 'Padding line.\n'.repeat(8000); // > 100,000 chars
  let staleLargeMode = $state(false);
  const staleCurrent = $derived(
    staleLargeMode ? `${staleCurrentBase}\n${stalePadding}` : staleCurrentBase,
  );
  const staleValidTarget = $derived<DiffReviewTargetInput>({
    targetId: 'stale',
    kind: 'markdown',
    label: 'stale.md',
    original: staleOriginal,
    current: staleCurrent,
    normalizeInputs: false,
  });
  const staleTargets = $derived([staleValidTarget]);
  let staleState = $state(
    initialState([
      {
        targetId: 'stale',
        kind: 'markdown',
        label: 'stale.md',
        original: staleOriginal,
        current: staleCurrentBase,
        normalizeInputs: false,
      },
    ]),
  );
  function growStaleDocument(): void {
    staleLargeMode = true;
  }

  // -- Scenario: toggling readonly on a session with an existing draft ------
  // (COR-511 / DR-8; contract: "If read-only mode has nonempty drafts,
  // export stays blocked and explains that the host must enable editing to
  // save/discard them.") A host-controlled toggle, matching the pattern the
  // `review-editor-diff-comments` fixture already uses for the same case.
  const readonlyToggleTarget: DiffReviewTargetInput = {
    targetId: 'readonly-toggle',
    kind: 'markdown',
    label: 'readonly-toggle.md',
    original: 'Ship login.',
    current: 'Ship login and dashboard.',
    normalizeInputs: true,
  };
  let readonlyToggleState = $state(initialState([readonlyToggleTarget]));
  let readonlyToggleReadonly = $state(false);
  function toggleReadonlyToggleMode(): void {
    readonlyToggleReadonly = !readonlyToggleReadonly;
  }
</script>

<div id="example-mount-markdown-pair">
  <DiffReview
    targets={markdownTargets}
    state={markdownPairState}
    onStateChange={(next) => (markdownPairState = next)}
  />
</div>

<div id="example-mount-multi-file-source">
  <DiffReview
    targets={sourceTargets}
    state={sourcePatchState}
    onStateChange={(next) => (sourcePatchState = next)}
  />
</div>

<div id="example-mount-mixed-target">
  <DiffReview
    targets={mixedTargets}
    state={mixedState}
    onStateChange={(next) => (mixedState = next)}
  />
</div>

<div id="example-mount-standalone-diff-viewer">
  <DiffViewer
    original={readmeOriginal}
    current={readmeCurrent}
    readonly
    bind:ref={standaloneDiffViewerRef}
  />
  <DiffReviewComments
    state={standaloneDiffViewerState}
    onStateChange={(next) => (standaloneDiffViewerState = next)}
    onNavigate={navigateStandaloneDiffViewer}
  />
</div>

<div id="example-mount-standalone-source-diff-viewer">
  <SourceDiffViewer patch={sourcePatch} bind:ref={standaloneSourceViewerRef} />
  <DiffReviewComments
    state={standaloneSourceViewerState}
    onStateChange={(next) => (standaloneSourceViewerState = next)}
    onNavigate={navigateStandaloneSourceDiffViewer}
  />
</div>

{#if statesScenarioEnabled}
  <div id="example-mount-empty">
    <DiffReview targets={[]} state={emptyState} onStateChange={(next) => (emptyState = next)} />
  </div>

  <div id="example-mount-no-change">
    <DiffReview
      targets={noChangeTargets}
      state={noChangeState}
      onStateChange={(next) => (noChangeState = next)}
    />
  </div>

  <div id="example-mount-binary">
    <DiffReview
      targets={binaryTargets}
      state={binaryState}
      onStateChange={(next) => (binaryState = next)}
    />
  </div>

  <div id="example-mount-truncated">
    <DiffReview
      targets={truncatedTargets}
      state={truncatedState}
      onStateChange={(next) => (truncatedState = next)}
    />
  </div>

  <div id="example-mount-invalid-toggle">
    <button type="button" onclick={breakInvalidToggleTargets}>Break targets</button>
    <button type="button" onclick={fixInvalidToggleTargets}>Fix targets</button>
    <DiffReview
      targets={invalidToggleTargets}
      state={invalidToggleState}
      onStateChange={(next) => (invalidToggleState = next)}
    />
  </div>

  <div id="example-mount-navigation">
    <button type="button" onclick={changeNavContent}>Change content</button>
    <button type="button" onclick={removeNavTarget}>Remove target</button>
    <DiffReview targets={navTargets} state={navState} onStateChange={(next) => (navState = next)} />
  </div>

  <div id="example-mount-stale">
    <button type="button" onclick={growStaleDocument}>Make document large</button>
    <DiffReview
      targets={staleTargets}
      state={staleState}
      onStateChange={(next) => (staleState = next)}
    />
  </div>

  <div id="example-mount-readonly-toggle">
    <button type="button" onclick={toggleReadonlyToggleMode}>
      {readonlyToggleReadonly ? 'Enable editing' : 'Make read-only'}
    </button>
    <DiffReview
      targets={[readonlyToggleTarget]}
      state={readonlyToggleState}
      onStateChange={(next) => (readonlyToggleState = next)}
      readonly={readonlyToggleReadonly}
    />
  </div>
{/if}
