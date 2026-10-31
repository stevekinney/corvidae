<script lang="ts">
  /**
   * One workflow review, open: what the workflow asks a person to look at (its artifact, by
   * section when it has them) and the decision form, or, once it is decided, what was decided and
   * by whom. The decision form needs `reviews:write` and disables its own submit without it.
   */
  import { Badge, DescriptionList, RelativeTime } from '@lostgradient/cinder';

  import { REVIEWS_COPY } from '../../app/copy.ts';
  import type { EngineReview } from '../../lib/bureau-reviews.ts';
  import type { ScopeGate } from '../../lib/scopes.svelte.ts';
  import ArtifactView from './artifact-view.svelte';
  import ReviewDecisionForm, { type ReviewDecisionSubmission } from './review-decision-form.svelte';
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
    readonly onSubmit: (reviewId: string, submission: ReviewDecisionSubmission) => void;
  }

  let { review, submitting, submitGate, onSubmit }: EngineReviewPaneProps = $props();

  const waiting = $derived(review.status === 'pending');
  const sections = $derived(extractReviewSections(review.artifact));
  const metadataEntries = $derived(extractReviewMetadataEntries(review.artifact));
  const resolution = $derived(review.resolution);
</script>

<div class="ib-review-pane" data-kind="engine-review" data-review={review.id}>
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
    <ArtifactView value={review.artifact} label={REVIEWS_COPY.artifactLabel} />
  {/if}

  {#if waiting}
    <ReviewDecisionForm
      reviewId={review.id}
      sectionKeys={sections ? Object.keys(sections) : []}
      {submitting}
      {submitGate}
      onSubmit={(submission) => onSubmit(review.id, submission)}
    />
  {/if}
</div>
