<script lang="ts">
  /** `ReviewsView`: the reviews area, renderable inside or outside the application shell. */
  import ReviewsRoute from '../routes/reviews/index.svelte';
  import StandaloneView from './standalone-view.svelte';
</script>

<StandaloneView>
  <ReviewsRoute />
</StandaloneView>
