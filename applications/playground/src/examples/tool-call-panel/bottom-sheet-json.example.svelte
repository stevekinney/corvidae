<script lang="ts" module>
  export const title = 'A phone sheet with JSON blocks';
  export const description =
    'The phone panel for Lookup order opens as a bottom sheet over the run page with a grabber, the title "Lookup order", Close, "Reads, ran in 0.4s", and Input and Output JSON blocks. The line under the title is the caller\'s own words, and Output is the Result heading renamed.';
</script>

<script lang="ts">
  import { Button, ToolCallPanel } from '@lostgradient/cinder';

  let open = $state(false);
</script>

<Button variant="secondary" onclick={() => (open = true)}>Open Lookup order</Button>
<ToolCallPanel
  bind:open
  placement="sheet"
  view="json"
  name="Lookup order"
  status="done"
  summary="Reads, ran in 0.4s"
  resultLabel="Output"
  input={'{ "orderId": "4471" }'}
  result={'{ "total": 42.00, "status": "paid" }'}
/>
