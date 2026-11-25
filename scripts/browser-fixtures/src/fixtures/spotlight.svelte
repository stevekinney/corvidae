<script lang="ts">
  import { Badge, Container, Link, Spotlight } from '@lostgradient/cinder';

  const headline = new URLSearchParams(globalThis.location.search).has('headline');
</script>

<Container
  maxWidth="narrow"
  centered={false}
  padded={false}
  class="spotlight-fixture-container gap-8"
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

  <div data-testid="spotlight-action-long" class="spotlight-action-long-layout">
    <Spotlight value="Nothing needs you">
      {#snippet action()}<Link href="/reviews" variant="more">Open Reviews</Link>{/snippet}
    </Spotlight>
  </div>
</Container>

{#if headline}
  <div data-testid="spotlight-headline">
    <Spotlight>
      {#snippet value()}Its last 2 runs <Badge size="sm" variant="danger">Failed</Badge>{/snippet}
    </Spotlight>
  </div>
{/if}

<style>
  :global(.spotlight-fixture-container) {
    display: flex;
    flex-direction: column;
  }

  .spotlight-action-long-layout {
    inline-size: 20rem;
  }
</style>
