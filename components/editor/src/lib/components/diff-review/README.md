# DiffReview

Aggregate single- and multi-target diff review (COR-509 / DR-6): a file list with changed-line/comment counts and a Reviewed checkbox, the diff surface for the currently selected file, comment creation via range or file selection, a drafts inventory, and Markdown/JSON export. Composed entirely from the public `DiffViewer` (COR-514) and `SourceDiffViewer` (COR-515) annotation hooks, `diff-review-state` (COR-516), and the export functions (COR-513) — no private controller from either viewer is imported.

```svelte
<script lang="ts">
  import { DiffReview, createDiffReviewState } from '@lostgradient/editor';
  import type { DiffReviewTargetInput } from '@lostgradient/editor';

  const targets: DiffReviewTargetInput[] = [
    {
      targetId: 'readme',
      kind: 'markdown',
      label: 'README.md',
      original,
      current,
      normalizeInputs: true,
    },
    { targetId: 'patch', kind: 'source', label: 'Refactor', patch: unifiedPatchText },
  ];

  const created = createDiffReviewState(targets);
  let state = $state(created.ok ? created.value : undefined);
</script>

{#if state}
  <DiffReview {targets} {state} onStateChange={(next) => (state = next)} />
{/if}
```

## Props

| Prop | Type | Description |
| --- | --- | --- |
| `targets` | `DiffReviewTargetInput[]` | Live document/patch content for every target `state` tracks. The host keeps this and `state.targets` in sync via its own `set-targets` dispatch when content changes. |
| `state` | `DiffReviewState` | Controlled session state (`@lostgradient/editor/diff-review-state`). |
| `onStateChange` | `(next: DiffReviewState) => void` | Called after every successful action. |
| `readonly` | `boolean` | Disables comments, drafts, review note, and Reviewed. Navigation, filtering, and export remain available. Default `false`. |
| `reviewTitle` | `string` | Markdown export heading. Default `'Review feedback'`. |
| `class` | `string` | Additional class merged onto the root element. |

## Renderer selection

A Markdown target renders through `DiffViewer`; a source-patch target renders through Cinder's `SourceDiffViewer`, scoped to the currently selected file via `activeFileOccurrence`. Both are wired through their public `annotationSelection`/`onAnnotationSelectionChange` hooks; `DiffReview` converts each viewer's selection into a `DiffReviewRangeAnchor` (`diff-review-annotation-bridge.ts`) and immediately dispatches `create-draft` with it — the composer is a live view over that draft, not a local text buffer, so a partially written comment survives target switching, filtering, mode changes, and remount exactly like any other draft. Save dispatches `save-draft` (converting it into a real comment); Cancel only closes the composer panel and does **not** discard the draft, which remains recoverable from the drafts inventory.

## Layout

`.diff-review-layout` stacks the file list, diff, and review sidebar in document order below a `60rem` container width, and lays them out as three columns above it (`@container` query on `.diff-review`). Each region carries its own `aria-label` (`"File navigation"`, `"Diff"`, `"Review"`).

## Internal, undiscoverable pieces

`diff-review-file-list.svelte`, `diff-review-renderer.svelte`, `diff-review-drafts-inventory.svelte`, and `diff-review-toolbar.svelte` are internal composition pieces. None is exported from `index.ts`, registered as its own mirror subpath, or discoverable outside this directory — only `DiffReview` itself and `DiffReviewComments` (a sibling public leaf) are public.

## Related

`diff-review-comments`, `diff-viewer`, `review-editor`.
