<script lang="ts">
  import { untrack } from 'svelte';
  import { provideReviewsNavigation, reviewsNavigation } from './reviews-navigation.ts';

  let { receive }: { receive: (navigation: ReturnType<typeof reviewsNavigation>) => void } =
    $props();
  provideReviewsNavigation('https://example.test/reviews?tab=done');
  untrack(() => receive(reviewsNavigation()));
</script>
