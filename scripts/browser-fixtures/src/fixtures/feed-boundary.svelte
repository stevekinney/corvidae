<script lang="ts">
  import { FeedBoundary } from '@lostgradient/cinder';
</script>

<ul class="ul gap-3">
  <li>09:14:02 — Job nightly-sync started</li>
  <li>09:14:20 — 4,182 records fetched</li>
  <FeedBoundary
    label="Connection lost — retrying"
    datetime="2026-05-12T09:15:00Z"
    timestamp="09:15:00"
  />
  <li>09:15:31 — Resumed from checkpoint 4,182</li>
  <li>09:16:05 — Job completed</li>
</ul>

<style>
  .ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    font-size: var(--cinder-text-sm);
  }
</style>
