<script lang="ts" module>
  export const title = 'A failure inside the hidden run';
  export const description =
    'A failure in the middle of a run stays on the rail between two folded groups: the first 3 calls, "Show 10 more · 10 done: Lookup order ×10", the failed Send email with its danger line and links, "Show 13 more · 13 done: Check inventory ×4, Lookup customer ×4, Search orders ×3, 2 others", then the last 3 calls. Each group counts only the calls it hides.';
</script>

<script lang="ts">
  import { ToolCallRail } from '@lostgradient/cinder';
  import type { ToolCallRailCall } from '@lostgradient/cinder';

  const done = (
    id: string,
    name: string,
    input: string,
    result: string,
    duration = '0.3s',
  ): ToolCallRailCall => ({ id, name, input, result, duration, status: 'done' });

  const calls: ToolCallRailCall[] = [
    done('f1', 'Search orders', 'carrier Parcelly, damaged', '14 orders', '0.6s'),
    done('f2', 'Lookup order', '4471', '$42.00, delivered Mon', '0.2s'),
    done('f3', 'Lookup order', '4476', '$96.00, delivered Mon'),
    ...Array.from({ length: 10 }, (_, index) =>
      done(`lookup-${index}`, 'Lookup order', String(4480 + index), '$20.00'),
    ),
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
    ...Array.from({ length: 4 }, (_, index) =>
      done(`stock-${index}`, 'Check inventory', `MUG-0${index}`, `${index + 3} in stock`),
    ),
    ...Array.from({ length: 4 }, (_, index) =>
      done(`customer-${index}`, 'Lookup customer', `cus_${index}`, 'Found'),
    ),
    ...Array.from({ length: 3 }, (_, index) =>
      done(`search-${index}`, 'Search orders', `prior refunds ${index}`, 'none'),
    ),
    done('policy', 'Read policy', 'refund-policy', 'Damaged items refundable'),
    done('ticket-1', 'Update ticket', 'T-2290', 'Marked pending refund'),
    done('draft-1', 'Draft email', 'refund notice, 4471', 'Draft saved', '0.6s'),
    done('draft-2', 'Draft email', 'refund notice, 4472', 'Draft saved', '0.6s'),
    done('ticket-2', 'Update ticket', 'T-2291', 'Marked pending refund'),
  ];
</script>

<ToolCallRail
  {calls}
  duration="21s"
  onSelect={() => undefined}
  onRetry={() => undefined}
  onCopyInput={() => undefined}
/>
