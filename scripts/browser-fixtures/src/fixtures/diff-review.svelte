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
  } from '@lostgradient/editor';
  import type {
    DiffReviewComment,
    DiffReviewState,
    DiffReviewTargetInput,
  } from '@lostgradient/editor';
  import { SourceDiffViewer } from '@lostgradient/cinder';

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
