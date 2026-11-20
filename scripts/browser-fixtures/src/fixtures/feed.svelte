<script lang="ts">
  import { Feed } from '@lostgradient/cinder';
</script>

<Feed aria-label="Project activity">
  <Feed.Event datetime="2025-05-12T15:30:00Z" timestamp="2m ago">
    {#snippet icon()}
      <span aria-hidden="true">★</span>
    {/snippet}
    <p class="paragraph">Ada Lovelace starred the repository.</p>
  </Feed.Event>
  <Feed.Event datetime="2025-05-12T14:05:00Z" timestamp="1h ago">
    {#snippet icon()}
      <span aria-hidden="true">✎</span>
    {/snippet}
    <p class="paragraph">Grace Hopper opened a pull request.</p>
  </Feed.Event>
  <Feed.Event variant="minimal" datetime="2025-05-11T09:42:00Z" timestamp="Yesterday">
    <p class="paragraph">Alan Turing commented on issue #42.</p>
  </Feed.Event>
</Feed>

<style>
  .paragraph {
    margin: 0;
  }
</style>
