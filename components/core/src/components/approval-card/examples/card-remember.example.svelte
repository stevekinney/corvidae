<script lang="ts" module>
  export const title = 'Card with Allow for the rest of this chat';
  export const description =
    'A tool set to On changes offers the checkbox on its own line, below the note and above Deny and Approve. The note travels with Approve, with Allow, and with Deny. A tool set to Always shows only the note, Deny and Approve.';
</script>

<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';
</script>

<ApprovalCard
  question="Triage refund request for order 4398?"
  source="Tool runner"
  requestedAt="2026-11-02T10:40:00.000Z"
  now={new Date('2026-11-02T10:42:00.000Z')}
  rememberScope="the rest of this chat"
  tool={{ name: 'triage-refunds', label: 'Triage refunds', risk: 'medium' }}
  operation={{
    kind: 'other',
    argsPreview: { orderId: 4398, amount: '$27.25', reason: 'Arrived damaged' },
  }}
  policyVersion="policy-2026-06"
  idempotencyKey="card-remember"
  state="pending"
  onResolve={() => undefined}
/>
