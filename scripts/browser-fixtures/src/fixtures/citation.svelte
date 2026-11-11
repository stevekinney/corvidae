<script lang="ts">
  import { Citation } from '@lostgradient/cinder';

  // COR-2263: gated behind a query param (as the diff-viewer fixture gates its scenarios) so the
  // default assertion fixture, its baselines and its axe sweep never see the extra markers. The
  // sources carry long unbroken strings so a browser test can prove they wrap inside the panel.
  const hierarchy = new URLSearchParams(globalThis.location.search).get('hierarchy') === '1';
  const longTitle = 'RefundPolicy'.repeat(12);
  const longDetail = 'ReturnsAcceptedWithinThirtyDays'.repeat(8);
</script>

<Citation sources={[{ label: 'Component metadata guide', url: '/docs/components' }]}
  >Source</Citation
>
{#if hierarchy}
  <div>
    <Citation label="Title only" sources={[{ label: 'Refund policy' }]} />
    <Citation
      label="Title and excerpt"
      sources={[{ label: longTitle, detail: longDetail, url: '/docs/refunds' }]}
    />
  </div>
{/if}
