<script lang="ts" module>
  export const title = 'Approval row with Allow for this chat';
  export const description =
    'A tool set to On changes offers a checkbox on its own line before Deny and Approve; a tool set to Always never does.';
</script>

<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';
</script>

<ApprovalCard
  layout="row"
  question="Triage the refund request for order 4398?"
  tool={{ name: 'triage-refunds', label: 'Triage refunds', risk: 'medium' }}
  source="Tool runner"
  requestedAt="2026-11-02T10:44:00.000Z"
  now={new Date('2026-11-02T10:42:00.000Z')}
  rememberScope="the rest of this chat"
  operation={{
    kind: 'other',
    argsPreview: { orderId: 4398, amount: '$27.25', reason: 'Arrived damaged' },
  }}
  policyVersion="policy-2026-06"
  idempotencyKey="approval-row-02"
  state="pending"
  onResolve={() => undefined}
/>
