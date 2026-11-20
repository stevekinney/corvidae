<script lang="ts">
  import { Container, Link, Spotlight } from '@lostgradient/cinder';
</script>

<Container
  maxWidth="narrow"
  centered={false}
  padded={false}
  style="display: flex; flex-direction: column; gap: var(--cinder-space-8);"
>
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
</Container>
