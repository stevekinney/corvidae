<script lang="ts" module>
  export const title = 'Card, approving failed';
  export const description =
    'Deny failing reads the same way: a red-toned inline message below the effect line says what failed and what is still true. Nothing was decided, so the live Deny and Approve are the retry and there is no separate Try again.';
</script>

<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';
</script>

<ApprovalCard
  question="Refund order 4471 for $42.00?"
  source="Tool runner"
  requestedAt="2026-11-02T10:38:00.000Z"
  now={new Date('2026-11-02T10:42:00.000Z')}
  consequence="Sends $42.00 back to the original card"
  tool={{ name: 'issue-refund', label: 'Issue refund', risk: 'high', irreversible: true }}
  operation={{
    kind: 'other',
    argsPreview: { orderId: 4471, amount: '$42.00', reason: 'Arrived damaged' },
  }}
  policyVersion="policy-2026-06"
  idempotencyKey="card-failed"
  state="pending"
  failure={{
    summary: "Couldn't deny.",
    detail: "Interborough couldn't reach the agent. Nothing changed.",
  }}
  onResolve={() => undefined}
/>
