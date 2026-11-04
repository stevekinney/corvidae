<script lang="ts" module>
  export const title = 'A turn of 30 calls';
  export const description =
    'The first 3 and last 3 calls stay on the rail around one dashed "Show 24 more" button that says what it hides, counted from this turn only. The failed Send email keeps its danger line with Details, Ask the agent to retry and Copy input, and the call waiting on you stays its own row with its approval beneath it. Choosing a row selects it; "Show 24 more" opens the hidden calls in place and "Show fewer" folds them again.';
</script>

<script lang="ts">
  import { ApprovalCard, ToolCallRail } from '@lostgradient/cinder';
  import type { ToolCallRailCall } from '@lostgradient/cinder';

  const done = (
    id: string,
    name: string,
    identifier: string,
    input: string,
    result: string,
    duration: string,
  ): ToolCallRailCall => ({ id, name, identifier, input, result, duration, status: 'done' });

  const calls: ToolCallRailCall[] = [
    done('c1', 'Search orders', 'search-orders', 'carrier Parcelly, damaged', '14 orders', '0.6s'),
    done('c2', 'Lookup order', 'lookup-order', '4471', '$42.00, delivered Mon', '0.2s'),
    done('c3', 'Lookup order', 'lookup-order', '4476', '$96.00, delivered Mon', '0.3s'),
    done('c4', 'Lookup order', 'lookup-order', '4476', '$96.00, delivered Tue', '0.4s'),
    done('c5', 'Lookup order', 'lookup-order', '4480', '$27.25, delivered Tue', '0.5s'),
    done('c6', 'Lookup order', 'lookup-order', '4483', '$61.10, delivered Tue', '0.2s'),
    done('c7', 'Lookup order', 'lookup-order', '4487', '$15.00, delivered Wed', '0.3s'),
    done('c8', 'Lookup order', 'lookup-order', '4490', '$38.75, delivered Wed', '0.4s'),
    done('c9', 'Lookup order', 'lookup-order', '4492', '$72.40, delivered Wed', '0.5s'),
    done('c10', 'Lookup order', 'lookup-order', '4495', '$22.00, delivered Thu', '0.2s'),
    done('c11', 'Lookup order', 'lookup-order', '4501', '$54.90, delivered Thu', '0.3s'),
    done('c12', 'Lookup order', 'lookup-order', '4503', '$31.60, delivered Thu', '0.4s'),
    done('c13', 'Lookup order', 'lookup-order', '4508', '$19.99, delivered Fri', '0.5s'),
    done('c14', 'Read policy', 'read-policy', 'refund-policy', 'Damaged items refundable', '0.2s'),
    done('c15', 'Check inventory', 'check-inventory', 'MUG-04', '6 in stock', '0.3s'),
    done('c16', 'Check inventory', 'check-inventory', 'LMP-11', '0 in stock', '0.3s'),
    done('c17', 'Check inventory', 'check-inventory', 'PLT-02', '14 in stock', '0.2s'),
    done('c18', 'Check inventory', 'check-inventory', 'MUG-09', '3 in stock', '0.3s'),
    done('c19', 'Lookup customer', 'lookup-customer', 'cus_8821', 'Maya Ortiz, 3 orders', '0.4s'),
    done('c20', 'Lookup customer', 'lookup-customer', 'cus_9034', 'Dev Patel, 1 order', '0.3s'),
    done('c21', 'Lookup customer', 'lookup-customer', 'cus_7710', 'Ana Silva, 5 orders', '0.4s'),
    done('c22', 'Lookup customer', 'lookup-customer', 'cus_9102', 'Lee Chen, 2 orders', '0.3s'),
    done('c23', 'Search orders', 'search-orders', 'prior refunds, 30 days', '2 found', '0.5s'),
    done('c24', 'Search orders', 'search-orders', 'duplicate shipments', 'none', '0.5s'),
    done('c25', 'Draft email', 'draft-email', 'refund notice, 4471', 'Draft saved', '0.6s'),
    done('c26', 'Draft email', 'draft-email', 'refund notice, 4472', 'Draft saved', '0.6s'),
    done('c27', 'Update ticket', 'update-ticket', 'T-2291', 'Marked pending refund', '0.3s'),
    {
      id: 'c28',
      name: 'Send email',
      identifier: 'send-email',
      input: 'maya@example.com',
      result: 'SMTP timeout after 10s',
      duration: '10.0s',
      status: 'failed',
      failure: "Mail server didn't reply within 10s. The refund notice for 4471 wasn't sent.",
    },
    {
      id: 'c29',
      name: 'Issue refund',
      identifier: 'issue-refund',
      input: '4476, $96.00',
      result: 'Approved by you 9:58 AM',
      duration: '0.9s',
      status: 'done',
    },
    {
      id: 'c30',
      name: 'Issue refund',
      identifier: 'issue-refund',
      input: '4480, $27.25',
      status: 'waiting',
      nested: true,
    },
  ];

  let selectedId = $state<string | undefined>(undefined);
</script>

<p>Checking the Parcelly damaged-carrier batch against the refund policy.</p>
<ToolCallRail
  {calls}
  duration="18s"
  {selectedId}
  onSelect={(id) => (selectedId = selectedId === id ? undefined : id)}
  onRetry={() => undefined}
  onCopyInput={() => undefined}
  footnote="Failures and calls that need you stay visible wherever they fall. Counts reflect this turn only."
>
  {#snippet children()}
    <ApprovalCard
      layout="row"
      tool={{ name: 'issue-refund', label: 'Issue refund', risk: 'high', irreversible: true }}
      question="Refund order 4480 for $27.25?"
      source="the agent"
      requestedAt={new Date(Date.now() - 2 * 60_000).toISOString()}
      consequence="Sends $27.25 back to the original card"
      operation={{
        kind: 'other',
        argsPreview: { orderId: '4480', amount: '$27.25', reason: 'Arrived damaged' },
      }}
      policyVersion="policy-2026-11"
      idempotencyKey="approval-4480"
      state="pending"
      onResolve={() => undefined}
    />
  {/snippet}
</ToolCallRail>
