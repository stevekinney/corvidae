<script lang="ts" module>
  export const title = 'Decision receipt';
  export const description =
    'A decided approval stays in the transcript with a check badge, who decided where and when, and the note, result and command behind Details.';
</script>

<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';
</script>

<ApprovalCard
  layout="decision"
  question="Refund order 4471 for $42.00?"
  tool={{ name: 'issue-refund', label: 'Issue refund', risk: 'high', irreversible: true }}
  operation={{ kind: 'command', command: 'refund --order 4471 --amount 42.00' }}
  policyVersion="policy-2026-06"
  idempotencyKey="approval-decision-02"
  state="approved"
  decidedBy="Priya Raman"
  decidedIn="Reviews"
  decidedInHref="/reviews"
  decidedAt="2026-11-02T10:46:00.000Z"
  decisionNote="Checked the order first."
  result="Refunded $42.00 to the original card."
/>
