<script lang="ts" module>
  export const title = 'Approval answered on another page';
  export const description =
    'An approval decided on another page while this one was open collapses to who decided, where and when, with no Deny or Approve left, under the question it asked.';
</script>

<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';
</script>

<ApprovalCard
  layout="row"
  question="Refund order 4471 for $42.00?"
  tool={{ name: 'issue-refund', label: 'Issue refund', risk: 'high', irreversible: true }}
  source="Tool runner"
  operation={{
    kind: 'other',
    argsPreview: { orderId: 4471, amount: '$42.00', reason: 'Arrived damaged' },
  }}
  policyVersion="policy-2026-06"
  idempotencyKey="row-elsewhere"
  state="approved"
  decidedBy="you"
  decidedIn="Reviews"
  decidedAt="2026-11-02T10:46:00.000Z"
/>
