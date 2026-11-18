<script lang="ts">
  import StaleRegion from '../stale-region/stale-region.svelte';
  import ApprovalCard from './approval-card.svelte';
  import type { ApprovalCardProps } from './approval-card.types.ts';

  let { card, stale = true }: { card: ApprovalCardProps; stale?: boolean } = $props();
</script>

<StaleRegion {stale}>
  <ApprovalCard {...card} />
</StaleRegion>
