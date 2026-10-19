<script lang="ts">
  /** Test-only page for `BureauReviewRow`: a query client around it. Never imported by production code. */
  import { QueryClientProvider } from '@tanstack/svelte-query';

  import type { BureauReview } from '../../lib/bureau-reviews.ts';
  import { createQueryClient } from '../../lib/query.ts';
  import BureauReviewRow from './bureau-review-row.svelte';

  interface BureauReviewRowHarnessProps {
    review: BureauReview;
    selected: boolean;
    now: number;
  }

  let { review, selected, now }: BureauReviewRowHarnessProps = $props();

  const queryClient = createQueryClient();
</script>

<QueryClientProvider client={queryClient}>
  <ul>
    <li><BureauReviewRow {review} {selected} {now} onSelect={() => {}} /></li>
  </ul>
</QueryClientProvider>
