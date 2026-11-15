<script lang="ts">
  /** A page's own placeholder whose first block holds the group's "Still loading" line. */
  import Skeleton from './skeleton.svelte';

  interface Props {
    onCancel?: () => void;
  }

  let { onCancel }: Props = $props();
</script>

<Skeleton
  stillLoadingAfter={10_000}
  stillLoadingLabel="Still loading Home. This is taking longer than usual."
  {...onCancel === undefined ? {} : { onCancel }}
>
  <p data-real-text>Monday, Nov 2.</p>
  <Skeleton width="11rem" height="2.2rem" holdsStatusLine />
  <Skeleton height="4rem" />
</Skeleton>
