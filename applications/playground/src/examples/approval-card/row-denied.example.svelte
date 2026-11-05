<script lang="ts" module>
  export const title = 'Denied approval';
  export const description =
    'A denied approval stays in the transcript as a neutral decision with who decided and when, the input it was asked about, and the note that went to the agent as the reason.';
</script>

<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';
</script>

<ApprovalCard
  layout="row"
  question="Refund order 4398 for $27.25?"
  tool={{ name: 'issue-refund', label: 'Issue refund', risk: 'high', irreversible: true }}
  source="Tool runner"
  operation={{ kind: 'other', argsPreview: { orderId: 4398, amount: '$27.25' } }}
  policyVersion="policy-2026-06"
  idempotencyKey="approval-row-04"
  state="denied"
  decidedBy="you"
  decidedAt="2026-11-02T10:40:00.000Z"
  decisionNote="Check the carrier’s claim first."
/>
