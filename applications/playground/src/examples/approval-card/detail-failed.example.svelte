<script lang="ts" module>
  export const title = 'Approval detail, approving failed';
  export const description =
    'The failure shows in the detail as a red-toned inline message below the consequence line. Nothing was approved, so the row stays in Waiting; the decision bar stays live with Deny and a primary Approve, and Approve is the retry.';
</script>

<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';
</script>

<ApprovalCard
  layout="detail"
  question="Refund order 4471 for $42.00?"
  source="Tool runner"
  sourceHref="#tool-runner"
  sourceIn="Please refund order 4471, it arrived damaged."
  sourceInHref="#chat"
  requestedAt="2026-11-02T10:38:00.000Z"
  now={new Date('2026-11-02T10:42:00.000Z')}
  inputLabel="Input"
  consequence="Sends $42.00 back to the original card."
  tool={{ name: 'issue-refund', label: 'Issue refund', risk: 'high', irreversible: true }}
  operation={{
    kind: 'other',
    argsPreview: { orderId: 4471, amount: '$42.00', reason: 'Arrived damaged' },
  }}
  policyVersion="policy-2026-06"
  footnote="The agent continues as soon as you answer."
  idempotencyKey="detail-failed"
  state="pending"
  failure={{
    summary: "Couldn't approve.",
    detail: "Interborough couldn't reach the agent. Nothing was refunded.",
  }}
  onResolve={() => undefined}
/>
