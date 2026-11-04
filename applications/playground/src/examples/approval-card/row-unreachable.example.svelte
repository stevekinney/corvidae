<script lang="ts" module>
  export const title = 'Approval row, agent unreachable';
  export const description =
    'When the approval cannot be answered right now, the reason sits above Add a note, Deny and Approve, and both buttons are named by it. The question, the line, the consequence and Input stay visible.';
</script>

<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';
</script>

<ApprovalCard
  layout="row"
  question="Refund order 4471 for $42.00?"
  tool={{ name: 'issue-refund', label: 'Issue refund', risk: 'high', irreversible: true }}
  source="Tool runner"
  requestedAt="2026-11-02T10:38:00.000Z"
  now={new Date('2026-11-02T10:42:00.000Z')}
  consequence="Sends $42.00 back to the original card"
  operation={{
    kind: 'other',
    argsPreview: { orderId: 4471, amount: '$42.00', reason: 'Arrived damaged' },
  }}
  policyVersion="policy-2026-06"
  idempotencyKey="row-unreachable"
  state="pending"
  disabledReason="Approving is off until Interborough is reachable"
  onResolve={() => undefined}
/>
