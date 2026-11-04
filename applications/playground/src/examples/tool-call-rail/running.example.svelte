<script lang="ts" module>
  export const title = 'Still running';
  export const description =
    'While the turn runs the summary reads "Used 12 tools so far…" with a spinner and no failed or waiting counts. The rail keeps the first 3 calls, one dashed "Show 8 more" button and the call under way, which shows a spinner in place of the dot, "Running…" in place of a result and the elapsed time. A second rail shows a short turn whose last call is still running.';
</script>

<script lang="ts">
  import { ToolCallRail } from '@lostgradient/cinder';
  import type { ToolCallRailCall } from '@lostgradient/cinder';

  const long: ToolCallRailCall[] = [
    {
      id: 'a1',
      name: 'Search orders',
      input: 'carrier Parcelly, damaged',
      result: '14 orders',
      duration: '0.6s',
      status: 'done',
    },
    {
      id: 'a2',
      name: 'Lookup order',
      input: '4471',
      result: '$42.00, delivered Mon',
      duration: '0.2s',
      status: 'done',
    },
    {
      id: 'a3',
      name: 'Lookup order',
      input: '4476',
      result: '$96.00, delivered Mon',
      duration: '0.3s',
      status: 'done',
    },
    ...Array.from({ length: 6 }, (_, index): ToolCallRailCall => ({
      id: `lookup-${index}`,
      name: 'Lookup order',
      input: String(4480 + index),
      result: '$20.00',
      duration: '0.3s',
      status: 'done',
    })),
    { id: 'policy', name: 'Read policy', input: 'refund-policy', duration: '0.2s', status: 'done' },
    {
      id: 'inventory',
      name: 'Check inventory',
      input: 'MUG-04',
      result: '6 in stock',
      duration: '0.3s',
      status: 'done',
    },
    { id: 'a12', name: 'Lookup order', input: '4508', duration: '1.2s', status: 'running' },
  ];
  const short: ToolCallRailCall[] = [
    {
      id: 'b1',
      name: 'Search orders',
      input: 'carrier Parcelly, damaged',
      result: '14 orders',
      duration: '0.6s',
      status: 'done',
    },
    {
      id: 'b2',
      name: 'Lookup order',
      input: '4471',
      result: '$42.00, delivered Mon',
      duration: '0.2s',
      status: 'done',
    },
    { id: 'b3', name: 'Lookup order', input: '4476', duration: '1.2s', status: 'running' },
  ];
</script>

<div style="display: grid; gap: 1.5rem;">
  <ToolCallRail calls={long} running />
  <ToolCallRail calls={short} running label="Tool calls so far" />
</div>
