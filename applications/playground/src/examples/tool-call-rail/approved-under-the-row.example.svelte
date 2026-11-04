<script lang="ts" module>
  export const title = 'An approved call with its approval beneath it';
  export const description =
    'A tool that changes things is one rail row with its approval nested under it, drawn as decided: "Approved by you · 10:42 AM" shows once, on the nested approval, and the row itself carries the result.';
</script>

<script lang="ts">
  import { ApprovalCard, ToolCallRail } from '@lostgradient/cinder';
</script>

<ToolCallRail
  calls={[
    {
      id: 'create-workflow',
      name: 'Create workflow',
      identifier: 'create-workflow',
      input: 'Morning briefing',
      result: 'Morning briefing',
      duration: '0.8s',
      status: 'done',
      nested: true,
    },
  ]}
>
  {#snippet children()}
    <ApprovalCard
      layout="row"
      tool={{ name: 'create-workflow', label: 'Create workflow', risk: 'medium' }}
      question={'Create workflow "Morning briefing"?'}
      operation={{
        kind: 'other',
        argsPreview: { name: 'Morning briefing', schedule: 'Every day at 9:00 AM Central time' },
      }}
      policyVersion="policy-2026-11"
      idempotencyKey="approval-create-workflow"
      state="approved"
      decidedBy="you"
      decidedAt={new Date('2026-11-02T16:42:00Z').toISOString()}
      onResolve={() => undefined}
    />
  {/snippet}
</ToolCallRail>
