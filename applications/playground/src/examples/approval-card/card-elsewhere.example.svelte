<script lang="ts" module>
  export const title = 'Approval answered somewhere else';
  export const description =
    'When the approval is approved in Reviews while the page is open, the card is replaced by who decided, where and when, and the page says it changed. Approve and Deny are gone, so nobody approves twice.';
</script>

<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';
</script>

<ApprovalCard
  question="Refund order 4471 for $42.00?"
  source="Tool runner"
  tool={{ name: 'issue-refund', label: 'Issue refund', risk: 'high', irreversible: true }}
  operation={{
    kind: 'other',
    argsPreview: { orderId: 4471, amount: '$42.00', reason: 'Arrived damaged' },
  }}
  policyVersion="policy-2026-06"
  idempotencyKey="card-elsewhere"
  state="approved"
  decidedBy="you"
  decidedIn="Reviews"
  decidedAt="2026-11-02T10:44:00.000Z"
  notice="Refund order 4471 for $42.00 · Issue refund. The run is continuing, so this page changed. You don't need to do anything here."
/>
