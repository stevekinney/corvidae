<script lang="ts">
  /**
   * One workflow review, open: what the workflow asks a person to look at (its artifact, by
   * section when it has them) and the decision, or, once it is decided, what was decided and by
   * whom. A review with sections is decided section by section in the decision form; one without
   * is the draft (with a copy button) over a note and "Send back" and "Approve" in the footer
   * (`workflow-review-bar.svelte`). Either needs `reviews:write` and holds its submit without it.
   */
  import { Badge, CopyButton, DescriptionList, RelativeTime } from '@lostgradient/cinder';

  import { REVIEWS_COPY } from '../../app/copy.ts';
  import type { EngineReview } from '../../lib/bureau-reviews.ts';
  import type { ScopeGate } from '../../lib/scopes.svelte.ts';
  import ArtifactView from './artifact-view.svelte';
  import ReviewDecisionForm, { type ReviewDecisionSubmission } from './review-decision-form.svelte';
  import WorkflowReviewBar from './workflow-review-bar.svelte';
  import {
    extractReviewMetadataEntries,
    extractReviewSections,
    humanizeKey,
  } from './review-domain.ts';
  import { resolutionLabel } from './review-items.ts';
  import ReviewSource from './review-source.svelte';

  interface EngineReviewPaneProps {
    readonly review: EngineReview;
    /** Whether a decision on this review is being sent. */
    readonly submitting: boolean;
    /** `reviews:write` gate for the decision form; open when omitted. */
    readonly submitGate?: ScopeGate | undefined;
    /** Who the caller is, recorded as the reviewer of a decision made without the form. */
    readonly viewer?: string | undefined;
    readonly onSubmit: (reviewId: string, submission: ReviewDecisionSubmission) => void;
  }

  let { review, submitting, submitGate, viewer, onSubmit }: EngineReviewPaneProps = $props();

  const waiting = $derived(review.status === 'pending');
  const sections = $derived(extractReviewSections(review.artifact));
  /** The artifact as text for the Draft's copy button: a string as it is, anything else as JSON. */
  const draftText = $derived.by(() => {
    const artifact = review.artifact;
    if (artifact === undefined) return '';
    return typeof artifact === 'string' ? artifact : JSON.stringify(artifact, null, 2);
  });
  const metadataEntries = $derived(extractReviewMetadataEntries(review.artifact));
  const resolution = $derived(review.resolution);
</script>

<div class="ib-review-pane" data-kind="engine-review" data-review={review.id}>
  <p class="ib-review-pane__eyebrow">{REVIEWS_COPY.workflowEyebrow}</p>
  <h2 class="ib-review-pane__question">{review.reviewType}</h2>
  <ReviewSource {review} {waiting} />

  {#if resolution !== undefined}
    <div class="ib-review-resolution" data-testid="review-resolution">
      <p class="ib-review-resolution__line">
        <Badge variant="neutral" size="sm">{resolutionLabel(review)}</Badge>
        <span>{REVIEWS_COPY.by} {resolution.decidedBy}</span>
        <RelativeTime date={resolution.decidedAt} />
      </p>
      {#if resolution.reason !== undefined && resolution.reason !== ''}
        <p class="ib-review-resolution__reason">
          <span class="ib-review-resolution__label">{REVIEWS_COPY.reasonIs}</span>
          {resolution.reason}
        </p>
      {/if}
    </div>
  {/if}

  {#if metadataEntries.length > 0}
    <DescriptionList
      variant="two-column"
      items={metadataEntries.map(([key, value]) => ({
        term: humanizeKey(key),
        definition: typeof value === 'string' ? value : JSON.stringify(value),
      }))}
    />
  {/if}

  {#if sections}
    <div class="weft-review-artifact-sections">
      {#each Object.entries(sections) as [key, value] (key)}
        <div class="weft-review-artifact-section">
          <h3 class="weft-review-artifact-section__title">{humanizeKey(key)}</h3>
          <ArtifactView {value} label={humanizeKey(key)} />
        </div>
      {/each}
    </div>
  {:else}
    <div class="ib-review-draft">
      <div class="ib-review-draft__header">
        <h3 class="ib-review-draft__title">{REVIEWS_COPY.workflow.draftLabel}</h3>
        {#if draftText !== ''}
          <CopyButton
            value={draftText}
            label={REVIEWS_COPY.workflow.copyDraft}
            copiedLabel={REVIEWS_COPY.workflow.draftCopied}
            iconOnly
          />
        {/if}
      </div>
      <ArtifactView value={review.artifact} label={REVIEWS_COPY.artifactLabel} />
    </div>
  {/if}

  {#if waiting}
    {#if sections}
      <div class="ib-review-pane__decision">
        <ReviewDecisionForm
          reviewId={review.id}
          sectionKeys={Object.keys(sections)}
          {submitting}
          {submitGate}
          onSubmit={(submission) => onSubmit(review.id, submission)}
        />
      </div>
    {:else}
      <WorkflowReviewBar
        reviewId={review.id}
        {submitting}
        {viewer}
        {submitGate}
        onSubmit={(submission) => onSubmit(review.id, submission)}
      />
    {/if}
  {/if}
</div>
