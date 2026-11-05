<script lang="ts" module>
  export const title = 'Approval detail with Allow for this chat';
  export const description =
    'On the detail page the checkbox sits on its own line below the note and above Deny and Approve; the note travels with every decision.';
</script>

<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';
</script>

<ApprovalCard
  layout="detail"
  question="Triage refund request for order 4398?"
  source="Tool runner"
  sourceIn="a chat"
  requestedAt="2026-11-02T10:40:00.000Z"
  now={new Date('2026-11-02T10:42:00.000Z')}
  rememberScope="the rest of this chat"
  tool={{ name: 'triage-refunds', label: 'Triage refunds', risk: 'medium' }}
  operation={{
    kind: 'other',
    argsPreview: { orderId: 4398, amount: '$27.25', reason: 'Arrived damaged' },
  }}
  policyVersion="policy-2026-06"
  idempotencyKey="detail-remember"
  state="pending"
  onResolve={() => undefined}
/>
