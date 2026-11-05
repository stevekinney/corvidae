<script lang="ts" module>
  export const title = 'Approval row';
  export const description =
    'The shared approval row: risk glyph and question, the tool and where it came from, the consequence, Input, Add a note, Deny and Approve.';
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
  idempotencyKey="approval-row-01"
  state="pending"
  onResolve={() => undefined}
/>
