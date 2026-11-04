<script lang="ts" module>
  export const title = 'Approval detail, expired';
  export const description =
    'An expired approval is read-only. Beside who asked it reads Expired with a neutral dot, the input stays, and a notice says when it expired and what that means.';
</script>

<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';
</script>

<ApprovalCard
  layout="detail"
  question="Refund order 4398 for $27.25?"
  source="Tool runner in Please refund order 4398, it arrived damaged."
  tool={{ name: 'issue-refund', label: 'Issue refund', risk: 'high', irreversible: true }}
  operation={{
    kind: 'other',
    argsPreview: { orderId: 4398, amount: '$27.25', reason: 'Arrived damaged' },
  }}
  policyVersion="policy-2026-06"
  idempotencyKey="detail-expired"
  state="pending"
  expiresAt="2026-11-02T10:15:00.000Z"
  notice="This approval expired at 10:15 AM, the time its request set (expiresAt). Nothing was refunded. It moves to Done as Expired."
/>
