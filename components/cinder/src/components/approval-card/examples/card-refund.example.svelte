<script lang="ts" module>
  export const title = 'Refund approval card';
  export const description =
    'The card follows the approval-row rules on a neutral raised surface: who asked and when, the wrapping question, the tool with its identifier small and monospaced, muted "Dangerous, Can\'t be undone", then the effect line. The arguments sit under "Runs with" and a note field is sent with both Approve and Deny.';
</script>

<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';
</script>

<ApprovalCard
  question="Refund order 4471 for $42.00?"
  source="Tool runner"
  requestedAt="2026-11-02T10:38:00.000Z"
  now={new Date('2026-11-02T10:42:00.000Z')}
  consequence="Refunds $42.00 to the original payment method for order 4471, which arrived damaged."
  inputLabel="Runs with"
  tool={{ name: 'issue-refund', label: 'Issue refund', risk: 'high', irreversible: true }}
  operation={{
    kind: 'other',
    argsPreview: { orderId: 4471, amount: '$42.00', reason: 'Arrived damaged' },
  }}
  policyVersion="policy-2026-06"
  idempotencyKey="card-refund"
  state="pending"
  onResolve={() => undefined}
/>
