<script lang="ts">
  /** Test-only: the review queries the navigation and the Reviews page read, below the providers. */
  import type { HttpClient } from '@lostgradient/weft';
  import { untrack } from 'svelte';

  import { bureauReviewsQuery, reviewListQuery } from '../routes/reviews/reviews-data.ts';

  let { client }: { client: Pick<HttpClient, 'listReviews'> } = $props();

  const bureauReviews = bureauReviewsQuery();
  const engineReviews = reviewListQuery(untrack(() => client) as HttpClient, () => 'pending');
</script>

<output
  data-bureau={bureauReviews.data?.length ?? -1}
  data-engine={engineReviews.data?.length ?? -1}
></output>
