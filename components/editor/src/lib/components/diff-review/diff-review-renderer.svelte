<script lang="ts" module>
  import type { DiffReviewTargetInput } from '../../diff-review-state/index.ts';
  import type { DiffReviewAnnotationBridgeResult } from './diff-review-annotation-bridge.ts';

  export interface DiffReviewRendererProps {
    target: DiffReviewTargetInput | undefined;
    selectedFileOccurrence: number | null;
    readonly?: boolean;
    /** Incrementing this clears any in-progress viewer selection (e.g. after Save/Cancel). */
    resetToken: number;
    onselectionchange: (result: DiffReviewAnnotationBridgeResult | null) => void;
  }
</script>

<script lang="ts">
  import { SourceDiffViewer } from '@lostgradient/cinder';
  import type { SourceDiffAnnotationSelection } from '@lostgradient/cinder';

  import DiffViewer from '../diff-viewer/diff-viewer.svelte';
  import type { DiffViewerAnnotationSelection } from '../diff-viewer/diff-viewer.types.ts';
  import {
    diffViewerSelectionToAnchor,
    sourceDiffSelectionToAnchor,
  } from './diff-review-annotation-bridge.ts';

  let {
    target,
    selectedFileOccurrence,
    readonly = false,
    resetToken,
    onselectionchange,
  }: DiffReviewRendererProps = $props();

  let markdownSelection = $state<DiffViewerAnnotationSelection | null>(null);
  let sourceSelection = $state<SourceDiffAnnotationSelection | null>(null);

  $effect(() => {
    // Referencing resetToken makes this effect re-run whenever the parent
    // asks the renderer to drop its in-progress selection.
    void resetToken;
    markdownSelection = null;
    sourceSelection = null;
  });

  function handleMarkdownSelectionChange(selection: DiffViewerAnnotationSelection | null): void {
    markdownSelection = selection;
    onselectionchange(selection ? diffViewerSelectionToAnchor(selection) : null);
  }

  function handleSourceSelectionChange(selection: SourceDiffAnnotationSelection | null): void {
    sourceSelection = selection;
    onselectionchange(selection ? sourceDiffSelectionToAnchor(selection) : null);
  }
</script>

{#if target === undefined}
  <p class="diff-review-renderer-empty">No file selected.</p>
{:else if target.kind === 'markdown'}
  <DiffViewer
    original={target.original}
    current={target.current}
    normalizeInputs={target.normalizeInputs}
    readonly
    annotationSelection={markdownSelection}
    {...readonly ? {} : { onAnnotationSelectionChange: handleMarkdownSelectionChange }}
  />
{:else}
  <SourceDiffViewer
    patch={target.patch}
    activeFileOccurrence={selectedFileOccurrence}
    annotationSelection={sourceSelection}
    {...readonly ? {} : { onAnnotationSelectionChange: handleSourceSelectionChange }}
  />
{/if}
