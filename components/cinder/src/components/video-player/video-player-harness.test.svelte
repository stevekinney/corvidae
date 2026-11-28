<script lang="ts">
  import VideoPlayer from './video-player.svelte';

  let {
    requested,
    onBound,
  }: {
    /** A position the page writes to the bound `currentTime`. */
    requested?: number | undefined;
    /** Hears every value the bound `currentTime` takes. */
    onBound?: (seconds: number) => void;
  } = $props();

  let currentTime = $state(0);

  $effect(() => {
    if (requested !== undefined) currentTime = requested;
  });

  $effect(() => {
    onBound?.(currentTime);
  });
</script>

<VideoPlayer src="https://example.com/media/clip" label="Bound clip" bind:currentTime>
  {#snippet actions({ currentTime: position })}
    <button type="button" data-testid="comment">Comment at {position}</button>
  {/snippet}
</VideoPlayer>
