<script lang="ts" module>
  /**
   * @cinder
   * @category domain
   * @status domain-suite
   * @purpose Aggregate single- and multi-target diff review: file list, comment controls, drafts inventory, and Markdown/JSON export -- composed entirely from the public DiffViewer/SourceDiffViewer annotation hooks and diff-review-state.
   * @tag diff-review
   * @useWhen Reviewing one or many mixed Markdown/source-patch targets and collecting comments for an agent handoff.
   * @avoidWhen Rendering a single diff with no comment/export workflow -- use DiffViewer or SourceDiffViewer directly.
   * @related diff-review-comments, diff-viewer, review-editor
   */
  export type { DiffReviewProps } from './diff-review.types.ts';
</script>

<script lang="ts">
  import { exportDiffReviewJson, exportDiffReviewMarkdown } from '../../export/index.ts';
  import { dispatchDiffReviewAction } from '../../utilities/diff-review-dispatch.ts';
  import DiffReviewComments from '../diff-review-comments/diff-review-comments.svelte';
  import type { DiffReviewAnnotationBridgeResult } from './diff-review-annotation-bridge.ts';
  import DiffReviewDraftsInventory from './diff-review-drafts-inventory.svelte';
  import { getDiffReviewExportGate } from './diff-review-export-gate.ts';
  import { buildDiffReviewFileEntries } from './diff-review-file-entries.ts';
  import { filterDiffReviewFileEntries } from './diff-review-file-filter.ts';
  import DiffReviewFileList from './diff-review-file-list.svelte';
  import DiffReviewRenderer from './diff-review-renderer.svelte';
  import DiffReviewToolbar from './diff-review-toolbar.svelte';
  import type { DiffReviewExportScope } from './diff-review-toolbar.svelte';
  import type { DiffReviewProps } from './diff-review.types.ts';

  let {
    targets,
    state: reviewState,
    onStateChange,
    readonly = false,
    reviewTitle = 'Review feedback',
    class: className,
    ...rest
  }: DiffReviewProps = $props();

  let filterQuery = $state('');
  let pendingAnchor = $state<DiffReviewAnnotationBridgeResult | null>(null);
  let composerBody = $state('');
  let resetToken = $state(0);
  let draftsOpen = $state(false);

  const fileEntries = $derived(buildDiffReviewFileEntries(targets, reviewState));
  const visibleFileEntries = $derived(filterDiffReviewFileEntries(fileEntries, filterQuery));
  const selectedTarget = $derived(targets.find((t) => t.targetId === reviewState.selectedTargetId));
  const exportGate = $derived(getDiffReviewExportGate(reviewState));

  function selectFile(targetId: string, fileOccurrence: number): void {
    if (targetId !== reviewState.selectedTargetId) {
      dispatchDiffReviewAction(reviewState, { type: 'select-target', targetId }, onStateChange);
    }
    dispatchDiffReviewAction(reviewState, { type: 'select-file', fileOccurrence }, onStateChange);
  }

  function setReviewed(targetId: string, fileOccurrence: number, reviewed: boolean): void {
    dispatchDiffReviewAction(
      reviewState,
      { type: 'set-reviewed', targetId, fileOccurrence, reviewed },
      onStateChange,
    );
  }

  function handleSelectionChange(result: DiffReviewAnnotationBridgeResult | null): void {
    pendingAnchor = result;
    composerBody = '';
  }

  function addFileComment(): void {
    const fileOccurrence = reviewState.selectedFileOccurrence ?? 0;
    pendingAnchor = { anchor: { kind: 'file', fileOccurrence }, oldPath: null, newPath: null };
    composerBody = '';
  }

  function cancelComposer(): void {
    pendingAnchor = null;
    composerBody = '';
    resetToken += 1;
  }

  function saveComposer(): void {
    if (!pendingAnchor || !reviewState.selectedTargetId || composerBody.trim().length === 0) return;
    dispatchDiffReviewAction(
      reviewState,
      {
        type: 'create-comment',
        targetId: reviewState.selectedTargetId,
        anchor: pendingAnchor.anchor,
        body: composerBody,
        oldPath: pendingAnchor.oldPath,
        newPath: pendingAnchor.newPath,
      },
      onStateChange,
    );
    cancelComposer();
  }

  function openDraft(draft: { targetId: string; anchor: { fileOccurrence: number } }): void {
    selectFile(draft.targetId, draft.anchor.fileOccurrence);
    draftsOpen = true;
  }

  function saveDraft(draftId: string): void {
    dispatchDiffReviewAction(reviewState, { type: 'save-draft', draftId }, onStateChange);
  }

  function discardDraft(draftId: string): void {
    dispatchDiffReviewAction(reviewState, { type: 'discard-draft', draftId }, onStateChange);
  }

  function getExportContent(format: 'markdown' | 'json', scope: DiffReviewExportScope) {
    const options = { scope, reviewTitle };
    return format === 'markdown'
      ? exportDiffReviewMarkdown(reviewState, options)
      : exportDiffReviewJson(reviewState, options);
  }
</script>

<div class={['diff-review', className].filter(Boolean).join(' ')} {...rest}>
  <DiffReviewToolbar
    {filterQuery}
    onfilterchange={(query) => (filterQuery = query)}
    gate={exportGate}
    ongetcontent={getExportContent}
    onopendrafts={() => (draftsOpen = true)}
  />

  <div class="diff-review-layout">
    <nav class="diff-review-files" aria-label="File navigation">
      <DiffReviewFileList
        entries={visibleFileEntries}
        selectedTargetId={reviewState.selectedTargetId}
        selectedFileOccurrence={reviewState.selectedFileOccurrence}
        {readonly}
        onselect={selectFile}
        onreviewedchange={setReviewed}
      />
    </nav>

    <main class="diff-review-diff" aria-label="Diff">
      {#if !readonly}
        <button type="button" onclick={addFileComment}>Add file comment</button>
      {/if}
      <DiffReviewRenderer
        target={selectedTarget}
        selectedFileOccurrence={reviewState.selectedFileOccurrence}
        {readonly}
        {resetToken}
        onselectionchange={handleSelectionChange}
      />
      {#if pendingAnchor}
        <div class="diff-review-composer" role="group" aria-label="New comment">
          <textarea aria-label="Comment" bind:value={composerBody}></textarea>
          <div class="diff-review-composer-actions">
            <button
              type="button"
              onclick={saveComposer}
              disabled={composerBody.trim().length === 0}
            >
              Save
            </button>
            <button type="button" onclick={cancelComposer}>Cancel</button>
          </div>
        </div>
      {/if}
    </main>

    <aside class="diff-review-sidebar" aria-label="Review">
      {#if draftsOpen}
        <DiffReviewDraftsInventory
          drafts={reviewState.drafts}
          {readonly}
          onopen={openDraft}
          onsave={saveDraft}
          ondiscard={discardDraft}
        />
      {/if}
      <DiffReviewComments state={reviewState} {onStateChange} {readonly} />
    </aside>
  </div>
</div>
