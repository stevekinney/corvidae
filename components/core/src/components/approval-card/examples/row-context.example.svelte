<script lang="ts" module>
  export const title = 'Approval row with a context line';
  export const description =
    'A context slot writes a line above the question, such as a test chat whose tools run for real.';
</script>

<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';
</script>

<ApprovalCard
  layout="row"
  question="Refund order 4471 for $42.00?"
  tool={{ name: 'issue-refund', label: 'Issue refund', risk: 'high', irreversible: true }}
  source="Tool runner"
  requestedAt="2026-11-02T10:41:00.000Z"
  now={new Date('2026-11-02T10:42:00.000Z')}
  consequence="Sends $42.00 back to the original card"
  operation={{
    kind: 'other',
    argsPreview: { orderId: 4471, amount: '$42.00', reason: 'Arrived damaged' },
  }}
  policyVersion="policy-2026-06"
  idempotencyKey="row-context"
  state="pending"
  onResolve={() => undefined}
>
  {#snippet context()}
    Test chat, this runs for real: approving refunds order 4471.
  {/snippet}
</ApprovalCard>
