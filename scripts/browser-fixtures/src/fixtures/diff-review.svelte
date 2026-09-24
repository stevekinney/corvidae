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
  import type { DiffReviewState, DiffReviewTargetInput } from '@lostgradient/editor';
  import { SourceDiffViewer } from '@lostgradient/cinder';

  function initialState(targets: DiffReviewTargetInput[]): DiffReviewState {
    const created = createDiffReviewState(targets);
    if (!created.ok) throw new Error('Fixture setup failed: invalid target list.');
    return created.value;
  }

  // -- Scenario 1: a single Markdown pair --------------------------------
  const markdownTargets: DiffReviewTargetInput[] = [
    {
      targetId: 'readme',
      kind: 'markdown',
      label: 'README.md',
      original: '# Project Plan\n\nShip login and a dashboard.',
      current: '# Project Plan\n\nShip login, a dashboard, and CSV export.',
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
    original={markdownTargets[0].original}
    current={markdownTargets[0].current}
    readonly
  />
  <DiffReviewComments
    state={standaloneDiffViewerState}
    onStateChange={(next) => (standaloneDiffViewerState = next)}
  />
</div>

<div id="example-mount-standalone-source-diff-viewer">
  <SourceDiffViewer patch={sourcePatch} />
  <DiffReviewComments
    state={standaloneSourceViewerState}
    onStateChange={(next) => (standaloneSourceViewerState = next)}
  />
</div>
