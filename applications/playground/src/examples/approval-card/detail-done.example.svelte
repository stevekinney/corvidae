<script lang="ts" module>
  export const title = 'Approval detail, approved';
  export const description =
    'A decided detail is read-only with no actions: the green outcome line leads with the decision, who made it and when, then where it was asked, the input and the result.';
</script>

<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';
</script>

<ApprovalCard
  layout="detail"
  question="Refund order 4472 for $18.50?"
  source="Tool runner"
  sourceIn="Please refund order 4471, it arrived damaged."
  sourceInHref="#chat"
  tool={{ name: 'issue-refund', label: 'Issue refund', risk: 'high', irreversible: true }}
  operation={{
    kind: 'other',
    argsPreview: { orderId: 4472, amount: '$18.50', reason: 'Arrived damaged' },
  }}
  policyVersion="policy-2026-06"
  idempotencyKey="detail-done"
  state="approved"
  decidedBy="you"
  decidedAt="2026-11-02T10:33:00.000Z"
  now={new Date('2026-11-02T12:00:00.000Z')}
  result="Refunded $18.50 to the original card."
/>
