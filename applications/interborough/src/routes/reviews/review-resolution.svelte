<script lang="ts">
  /**
   * What became of a review that is no longer waiting: how it was closed and by whom, when, and the
   * reason given with the decision. An answer is only ever a digest on the Bureau's side, so it is
   * said to have been sent and never shown.
   */
  import { Badge, RelativeTime } from '@lostgradient/cinder';

  import { REVIEWS_COPY } from '../../app/copy.ts';
  import type { BureauReview } from '../../lib/bureau-reviews.ts';
  import { resolutionLabel } from './review-items.ts';

  interface ReviewResolutionProps {
    readonly review: BureauReview;
  }

  let { review }: ReviewResolutionProps = $props();

  const resolution = $derived(review.resolution);
</script>

<div class="ib-review-resolution" data-testid="review-resolution">
  <p class="ib-review-resolution__line">
    <Badge variant="neutral" size="sm">{resolutionLabel(review)}</Badge>
    {#if resolution !== undefined}
      <span>{REVIEWS_COPY.by} {resolution.decidedBy}</span>
      <RelativeTime date={resolution.decidedAt} />
    {/if}
  </p>
  {#if resolution?.reason !== undefined && resolution.reason !== ''}
    <p class="ib-review-resolution__reason">
      <span class="ib-review-resolution__label">{REVIEWS_COPY.reasonIs}</span>
      {resolution.reason}
    </p>
  {/if}
  {#if resolution?.answerDigest !== undefined}
    <p class="ib-review-pane__note">{REVIEWS_COPY.answerRecorded}</p>
  {/if}
</div>
