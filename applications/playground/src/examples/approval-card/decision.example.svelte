<script lang="ts" module>
  export const title = 'Explicit decision';
  export const description =
    'The decision surface: the action as the title with an Irreversible badge, the pause, Tool, Target, Amount and the open Command, the countdown, Add a note, then Deny and a named primary that arms on its first press.';
</script>

<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';
</script>

<ApprovalCard
  layout="decision"
  question="Refund order 4471 for $42.00?"
  tool={{ name: 'issue-refund', label: 'Issue refund', risk: 'high', irreversible: true }}
  pauseSentence="The agent is paused until you decide."
  facts={[
    { label: 'Target', value: 'order 4471' },
    { label: 'Amount', value: '$42.00' },
  ]}
  approveLabel="Refund"
  why="The customer reported the parcel arrived damaged."
  operation={{ kind: 'command', command: 'refund --order 4471 --amount 42.00' }}
  expiresAt="2999-01-01T00:00:00.000Z"
  policyVersion="policy-2026-06"
  idempotencyKey="approval-decision-01"
  state="pending"
  onResolve={() => undefined}
/>
