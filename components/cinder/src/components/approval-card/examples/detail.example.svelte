<script lang="ts" module>
  export const title = 'Approval detail';
  export const description =
    "The approval's own page: the eyebrow with its risk glyph, the question, who asked (the source and the chat are links) and how long it has waited, what the source said as a collapsed line, what the tool is, the Input block with Fields and JSON, then one line with the risk glyph that says what cannot be undone and what approving does. Deny and Approve sit below.";
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
  said="Order 4471 is $42.00, delivered Monday, and the carrier flagged it as damaged…"
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
  idempotencyKey="detail"
  state="pending"
  onResolve={() => undefined}
/>
