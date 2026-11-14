<script lang="ts">
  import { Link, Spotlight } from '@lostgradient/cinder';
</script>

<div style="display: flex; flex-direction: column; gap: 2rem; max-inline-size: 40rem;">
  <Spotlight value="Ends in 45 min" status="online" statusLabel="Live">
    {#snippet caveat()}Updated 12 min ago{/snippet}
  </Spotlight>

  <!-- The value titles what follows it (COR-2329): its action at the end of its first line. -->
  <div data-testid="spotlight-action">
    <Spotlight value="2 need you">
      {#snippet action()}<Link href="/reviews" variant="more">Open Reviews</Link>{/snippet}
    </Spotlight>
  </div>

  <div data-testid="spotlight-action-long" style="inline-size: 20rem;">
    <Spotlight value="Nothing needs you">
      {#snippet action()}<Link href="/reviews" variant="more">Open Reviews</Link>{/snippet}
    </Spotlight>
  </div>
</div>
