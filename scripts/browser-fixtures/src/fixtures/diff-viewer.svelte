<script lang="ts">
  import {
    DiffViewer,
    type DiffViewerAnnotationSelection,
    type DiffViewerMode,
    type DiffViewerRef,
  } from '@lostgradient/editor';
  import { Button } from '@lostgradient/cinder';

  type DiffViewerFixtureWindow = Window &
    typeof globalThis & {
      __diffViewerActionCount?: number;
      __diffViewerRevertAllCount?: number;
    };

  const editable = new URLSearchParams(globalThis.location.search).get('editable') === '1';

  function incrementWindowCounter(key: '__diffViewerActionCount' | '__diffViewerRevertAllCount') {
    const state = window as DiffViewerFixtureWindow;
    state[key] = (state[key] ?? 0) + 1;
  }

  function handleNamedAction() {
    incrementWindowCounter('__diffViewerActionCount');
  }

  function handleRevertAll() {
    incrementWindowCounter('__diffViewerRevertAllCount');
  }

  const original = `---
title: Project Plan
status: draft
owner: docs
---

# Project Plan

The first version includes authentication, a dashboard, and export tools.

## Tasks

- Build login
- Add dashboard
- Ship PDF export`;

  const current = `---
title: Project Plan
status: published
owner: editorial
---

# Project Plan

The first version includes authentication, a dashboard, and CSV export tools.

## Tasks

- Build login
- Add dashboard metrics
- Ship CSV export
- Add audit logging`;

  // COR-514 / DR-4: annotation-hook fixtures. Small, plain (no front matter)
  // documents keep the diff in the realtime tier so `data-ready` flips
  // quickly, and isolate the annotation-specific assertions from the
  // front-matter-bearing default mount above.
  const annotationOriginal = 'keep\nold middle\nkeep end';
  const annotationCurrent = 'keep\nkeep end\nbrand new';

  let firstSelection: DiffViewerAnnotationSelection | null = $state(null);
  let secondSelection: DiffViewerAnnotationSelection | null = $state(null);

  // Dedicated mount for `focusAnchor`'s mode-switch behavior: starts in
  // 'final' mode, which hides the old side of a modified row, then a button
  // calls the bound `ref.focusAnchor` to prove it switches to 'unified' and
  // moves focus.
  let focusAnchorViewMode: DiffViewerMode = $state('final');
  let focusAnchorRef: DiffViewerRef | undefined = $state();
  let focusAnchorResult: { status: 'focused' | 'unavailable' } | null = $state(null);

  function handleFocusOldLine2() {
    focusAnchorResult = focusAnchorRef?.focusAnchor({ side: 'old', startLine: 2 }) ?? null;
  }
</script>

<DiffViewer {original} {current} readonly={!editable} onRevertAll={handleRevertAll}>
  {#snippet toolbarActions()}
    {#if editable}
      <Button variant="secondary" size="xs" onclick={handleNamedAction}>Mark reviewed</Button>
    {/if}
  {/snippet}
</DiffViewer>

<div id="example-mount-annotation-first">
  <DiffViewer
    original={annotationOriginal}
    current={annotationCurrent}
    annotationSelection={firstSelection}
    onAnnotationSelectionChange={(next) => (firstSelection = next)}
  />
  <output id="annotation-first-result">{JSON.stringify(firstSelection)}</output>
</div>

<div id="example-mount-annotation-second">
  <DiffViewer
    original={annotationOriginal}
    current={annotationCurrent}
    annotationSelection={secondSelection}
    onAnnotationSelectionChange={(next) => (secondSelection = next)}
  />
  <output id="annotation-second-result">{JSON.stringify(secondSelection)}</output>
</div>

<div id="example-mount-focus-anchor">
  <DiffViewer
    original={annotationOriginal}
    current={annotationCurrent}
    bind:viewMode={focusAnchorViewMode}
    bind:ref={focusAnchorRef}
    onAnnotationSelectionChange={() => {}}
  />
  <Button size="xs" onclick={handleFocusOldLine2}>Focus old line 2</Button>
  <output id="focus-anchor-view-mode">{focusAnchorViewMode}</output>
  <output id="focus-anchor-result">{JSON.stringify(focusAnchorResult)}</output>
</div>
