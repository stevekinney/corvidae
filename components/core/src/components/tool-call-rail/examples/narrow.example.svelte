<script lang="ts" module>
  export const title = 'At 375 px';
  export const description =
    'In a narrow container each row has two lines: the name and duration on line one, and a muted line of key input and result, cut with an ellipsis, on line two. The summary reads "Used 30 tools, 1 failed, 1 waiting on you" with no duration, the dashed button says "Show 24 more" with the short "24 done", the failed row is red with a red cross and the waiting row is amber. The approval nests under the waiting row, and the failure line gives way to the panel.';
</script>

<script lang="ts">
  import { ApprovalCard, ToolCallRail } from '@lostgradient/cinder';
  import type { ToolCallRailCall } from '@lostgradient/cinder';

  const filler = Array.from({ length: 24 }, (_, index): ToolCallRailCall => ({
    id: `done-${index}`,
    name: 'Lookup order',
    input: String(4480 + index),
    result: '$20.00',
    duration: '0.3s',
    status: 'done',
  }));
  const calls: ToolCallRailCall[] = [
    {
      id: 'search',
      name: 'Search orders',
      input: 'carrier Parcelly',
      result: '14 orders',
      duration: '0.6s',
      status: 'done',
    },
    {
      id: 'lookup-4471',
      name: 'Lookup order',
      input: '4471',
      result: '$42.00, delivered Mon',
      duration: '0.2s',
      status: 'done',
    },
    {
      id: 'lookup-4476',
      name: 'Lookup order',
      input: '4476',
      result: '$96.00, delivered Mon',
      duration: '0.3s',
      status: 'done',
    },
    ...filler,
    {
      id: 'send-email',
      name: 'Send email',
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

<div style="inline-size: 375px; max-inline-size: 100%;">
  <ToolCallRail {calls} duration="18s" onSelect={() => undefined} onRetry={() => undefined}>
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
        idempotencyKey="approval-4480-narrow"
        state="pending"
        onResolve={() => undefined}
      />
    {/snippet}
  </ToolCallRail>
</div>
