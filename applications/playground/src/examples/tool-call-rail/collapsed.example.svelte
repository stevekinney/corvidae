<script lang="ts" module>
  export const title = 'Collapsed to one line';
  export const description =
    'Closed, the rail shows only the summary line "Used 30 tools, 1 failed, 1 waiting on you, 18s" with its chevron pointing right. The call that failed and the call waiting on you stay under it, with the failure line, its links and the approval, so nothing that needs a person is ever folded away.';
</script>

<script lang="ts">
  import { ApprovalCard, ToolCallRail } from '@lostgradient/cinder';
  import type { ToolCallRailCall } from '@lostgradient/cinder';

  const filler = Array.from({ length: 27 }, (_, index): ToolCallRailCall => ({
    id: `done-${index}`,
    name: index % 3 === 0 ? 'Search orders' : 'Lookup order',
    input: String(4400 + index),
    result: 'found',
    duration: '0.3s',
    status: 'done',
  }));
  const calls: ToolCallRailCall[] = [
    ...filler,
    {
      id: 'send-email',
      name: 'Send email',
      identifier: 'send-email',
      input: 'maya@example.com',
      result: 'SMTP timeout after 10s',
      duration: '10.0s',
      status: 'failed',
      failure: "Mail server didn't reply within 10s. The refund notice for 4471 wasn't sent.",
    },
    {
      id: 'refund-4476',
      name: 'Issue refund',
      input: '4476, $96.00',
      result: 'Approved by you 9:58 AM',
      duration: '0.9s',
      status: 'done',
    },
    {
      id: 'refund-4480',
      name: 'Issue refund',
      identifier: 'issue-refund',
      input: '4480, $27.25',
      status: 'waiting',
      nested: true,
    },
  ];
</script>

<ToolCallRail
  {calls}
  open={false}
  duration="18s"
  onSelect={() => undefined}
  onRetry={() => undefined}
  onCopyInput={() => undefined}
>
  {#snippet children()}
    <ApprovalCard
      layout="row"
      tool={{ name: 'issue-refund', risk: 'high', irreversible: true }}
      question="Refund order 4480 for $27.25?"
      source="the agent"
      requestedAt={new Date(Date.now() - 2 * 60_000).toISOString()}
      consequence="Sends $27.25 back to the original card"
      operation={{
        kind: 'other',
        argsPreview: { orderId: '4480', amount: '$27.25', reason: 'Arrived damaged' },
      }}
      policyVersion="policy-2026-11"
      idempotencyKey="approval-4480-collapsed"
      state="pending"
      onResolve={() => undefined}
    />
  {/snippet}
</ToolCallRail>
