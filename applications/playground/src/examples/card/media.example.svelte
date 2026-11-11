<script lang="ts" module>
  export const title = 'An optional media slot';
  export const description =
    'A media snippet fills a box at a set aspect ratio above the header. A card without media draws no placeholder and reserves no space.';
</script>

<script lang="ts">
  import { Card } from '@lostgradient/cinder';
</script>

<div style="display: grid; gap: 1rem; max-inline-size: 28rem;">
  <Card title="The Rooftop" description="Half-price wells until 8:00 pm" mediaAspectRatio="3 / 2">
    {#snippet media()}
      <svg viewBox="0 0 600 400" role="img" aria-label="The rooftop terrace at dusk" preserveAspectRatio="xMidYMid slice">
        <rect width="600" height="400" fill="currentColor" opacity="0.15" />
        <circle cx="440" cy="130" r="48" fill="currentColor" opacity="0.4" />
      </svg>
    {/snippet}
    Open until midnight.
  </Card>
  <Card title="The Pier" description="No photo yet">
    Cards without media draw no placeholder.
  </Card>
</div>
