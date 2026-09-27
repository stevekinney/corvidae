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
  // COR-514 review: gated behind a query param (matching `editable` above) so
  // the default assertion-fixture snapshot/axe sweep (`component-sweep.ts`)
  // and the unrelated `data-ready`/toolbar-metrics checks in
  // `components.playwright.ts` never see this scenario's extra mount or its
  // large (>100KB) padded document.
  const staleScenarioEnabled = new URLSearchParams(globalThis.location.search).get('stale') === '1';

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

  // COR-514 review: real (non-synthetic) coverage for "while diff computation
  // is stale, creating line comments is disabled ... and saved comments
  // remain available" (DR-4 acceptance). A manual-tier (>100KB) document
  // never auto-recomputes on further edits -- `scheduleCompute` only flips
  // `isStale` -- so appending padding to `staleCurrent` after the first
  // compute leaves the same three rows on screen, now stale, without a
  // reactive re-render race to work around.
  const staleAnnotationOriginal = 'keep\nold middle\nkeep end';
  const staleAnnotationCurrentBase = 'keep\nCHANGED\nkeep end';
  const staleAnnotationPadding = 'Padding line.\n'.repeat(8000); // > 100_000 chars
  let staleLargeMode = $state(false);
  const staleAnnotationCurrent = $derived(
    staleLargeMode
      ? `${staleAnnotationCurrentBase}\n${staleAnnotationPadding}`
      : staleAnnotationCurrentBase,
  );
  let staleSelection: DiffViewerAnnotationSelection | null = $state(null);
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

{#if staleScenarioEnabled}
  <div id="example-mount-stale-annotation">
    <DiffViewer
      original={staleAnnotationOriginal}
      current={staleAnnotationCurrent}
      annotationSelection={staleSelection}
      onAnnotationSelectionChange={(next) => (staleSelection = next)}
    >
      {#snippet lineAnnotation({ side, line })}
        <span data-testid="stale-saved-comment">Saved comment: {side}:{line}</span>
      {/snippet}
    </DiffViewer>
    <Button size="xs" onclick={() => (staleLargeMode = true)}>Make document large</Button>
    <output id="stale-annotation-result">{JSON.stringify(staleSelection)}</output>
  </div>
{/if}
