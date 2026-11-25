<script lang="ts">
  import ApprovalCard from './approval-card.svelte';
  import type { ApprovalResolution } from './approval-card.types.ts';

  let { onResolve }: { onResolve: (resolution: ApprovalResolution) => void } = $props();
</script>

<ApprovalCard
  tool={{ name: 'deploy', risk: 'high', irreversible: true }}
  operation={{ kind: 'other' }}
  policyVersion="policy"
  idempotencyKey="request"
  state="pending"
  layout="detail"
  {onResolve}
>
  {#snippet actionRenderer(controls)}
    <div data-testid="custom-action-renderer">{@render controls()}</div>
  {/snippet}
</ApprovalCard>
