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
  import { reduceDiffReviewState } from '../../diff-review-state/index.ts';
  import type { DiffReviewDraft } from '../../diff-review-state/index.ts';
  import { exportDiffReviewJson, exportDiffReviewMarkdown } from '../../export/index.ts';
  import { dispatchDiffReviewAction } from '../../utilities/diff-review-dispatch.ts';
  import { formatDiffReviewCommentLocation } from '../diff-review-comments/diff-review-comment-location.ts';
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
  /**
   * The draft currently shown in the composer panel, if any. The composer
   * never holds its own text buffer -- every keystroke is a real
   * `update-draft` dispatch, so a partially written comment survives target
   * switching, filtering, mode changes, collapse, and remount exactly like
   * any other draft (contract: "must not discard a partially written
   * comment").
   */
  let activeDraftId = $state<string | null>(null);
  let resetToken = $state(0);
  let draftsOpen = $state(false);

  const fileEntries = $derived(buildDiffReviewFileEntries(targets, reviewState));
  const visibleFileEntries = $derived(filterDiffReviewFileEntries(fileEntries, filterQuery));
  const selectedTarget = $derived(targets.find((t) => t.targetId === reviewState.selectedTargetId));
  const exportGate = $derived(getDiffReviewExportGate(reviewState));
  const activeDraft = $derived(
    reviewState.drafts.find((draft) => draft.draftId === activeDraftId) ?? null,
  );

  /**
   * Selecting a file may require two sequential transitions (switch target,
   * then switch file). Each call to `reduceDiffReviewState` only sees the
   * state it is handed -- chaining two `dispatchDiffReviewAction` calls
   * against the same stale `reviewState` would compute the second transition
   * from pre-first-transition state and silently drop it. Reducing locally
   * and dispatching only the final result keeps this atomic from the host's
   * perspective (exactly one `onStateChange` call, with the fully-applied
   * state).
   */
  function selectFile(targetId: string, fileOccurrence: number): void {
    let current = reviewState;
    if (targetId !== current.selectedTargetId) {
      const result = reduceDiffReviewState(current, { type: 'select-target', targetId });
      if (!result.ok) return;
      current = result.value;
    }
    dispatchDiffReviewAction(current, { type: 'select-file', fileOccurrence }, onStateChange);
  }

  function setReviewed(targetId: string, fileOccurrence: number, reviewed: boolean): void {
    dispatchDiffReviewAction(
      reviewState,
      { type: 'set-reviewed', targetId, fileOccurrence, reviewed },
      onStateChange,
    );
  }

  function handleSelectionChange(result: DiffReviewAnnotationBridgeResult | null): void {
    if (result === null) {
      // Clearing the viewer's own selection only closes the composer panel;
      // an already-created draft remains in state, recoverable from the
      // drafts inventory.
      activeDraftId = null;
      return;
    }
    if (!reviewState.selectedTargetId) return;
    const draftId = crypto.randomUUID();
    const outcome = dispatchDiffReviewAction(
      reviewState,
      {
        type: 'create-draft',
        draftId,
        targetId: reviewState.selectedTargetId,
        anchor: result.anchor,
        oldPath: result.oldPath,
        newPath: result.newPath,
      },
      onStateChange,
    );
    if (outcome.ok) activeDraftId = draftId;
  }

  function addFileComment(): void {
    if (!reviewState.selectedTargetId) return;
    const fileOccurrence = reviewState.selectedFileOccurrence ?? 0;
    const draftId = crypto.randomUUID();
    const outcome = dispatchDiffReviewAction(
      reviewState,
      {
        type: 'create-draft',
        draftId,
        targetId: reviewState.selectedTargetId,
        anchor: { kind: 'file', fileOccurrence },
      },
      onStateChange,
    );
    if (outcome.ok) activeDraftId = draftId;
  }

  function updateComposerBody(body: string): void {
    if (!activeDraftId) return;
    dispatchDiffReviewAction(
      reviewState,
      { type: 'update-draft', draftId: activeDraftId, body },
      onStateChange,
    );
  }

  function closeComposer(): void {
    activeDraftId = null;
    resetToken += 1;
  }

  function saveComposer(): void {
    if (!activeDraftId) return;
    const outcome = dispatchDiffReviewAction(
      reviewState,
      { type: 'save-draft', draftId: activeDraftId },
      onStateChange,
    );
    if (outcome.ok) closeComposer();
  }

  function openDraft(draft: DiffReviewDraft): void {
    if (targets.some((target) => target.targetId === draft.targetId)) {
      selectFile(draft.targetId, draft.anchor.fileOccurrence);
    }
    activeDraftId = draft.draftId;
    draftsOpen = true;
  }

  function saveDraft(draftId: string): void {
    const outcome = dispatchDiffReviewAction(
      reviewState,
      { type: 'save-draft', draftId },
      onStateChange,
    );
    if (outcome.ok && draftId === activeDraftId) closeComposer();
  }

  function discardDraft(draftId: string): void {
    const outcome = dispatchDiffReviewAction(
      reviewState,
      { type: 'discard-draft', draftId },
      onStateChange,
    );
    if (outcome.ok && draftId === activeDraftId) closeComposer();
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
      {#if activeDraft}
        <div
          class="diff-review-composer"
          role="group"
          aria-label={`New comment on ${formatDiffReviewCommentLocation(activeDraft)}`}
        >
          <p class="diff-review-composer-location">
            {formatDiffReviewCommentLocation(activeDraft)}
          </p>
          <textarea
            aria-label="Comment"
            value={activeDraft.body}
            oninput={(event) => updateComposerBody(event.currentTarget.value)}></textarea>
          <div class="diff-review-composer-actions">
            <button
              type="button"
              onclick={saveComposer}
              disabled={activeDraft.body.trim().length === 0}
            >
              Save
            </button>
            <button type="button" onclick={closeComposer}>Cancel</button>
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
