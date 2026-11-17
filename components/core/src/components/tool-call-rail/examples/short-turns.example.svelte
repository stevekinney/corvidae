<script lang="ts" module>
  export const title = 'Short turns and where the fold starts';
  export const description =
    'One or two calls are plain rows: no "Used N tools" line, no rail and no fold. From 3 calls the summary line appears and every call still shows. From 8 calls the middle folds, with the first 3 and last 3 around "Show 2 more, 2 done: Lookup order ×2". With 7 calls hiding one row would save nothing, so all 7 show.';
</script>

<script lang="ts">
  import { ToolCallRail } from '@lostgradient/cinder';
  import type { ToolCallRailCall } from '@lostgradient/cinder';

  const lookup = (index: number): ToolCallRailCall => ({
    id: `lookup-${index}`,
    name: 'Lookup order',
    identifier: 'lookup-order',
    input: String(4471 + index * 5),
    result: '$42.00, delivered Mon',
    duration: '0.2s',
    status: 'done',
  });
  const turn = (count: number): ToolCallRailCall[] =>
    Array.from({ length: count }, (_, i) => lookup(i));
</script>

<div style="display: grid; gap: 1.5rem;">
  <section>
    <p>Order 4471 is $42.00 and was delivered Monday.</p>
    <ToolCallRail calls={turn(1)} label="One call" />
  </section>
  <section>
    <p>Two calls look the same.</p>
    <ToolCallRail calls={turn(2)} label="Two calls" />
  </section>
  <ToolCallRail calls={turn(3)} endLabel="Run finished, no reply" label="Three calls" />
  <ToolCallRail calls={turn(7)} label="Seven calls" />
  <ToolCallRail calls={turn(8)} endLabel="Run finished, no reply" label="Eight calls" />
</div>
