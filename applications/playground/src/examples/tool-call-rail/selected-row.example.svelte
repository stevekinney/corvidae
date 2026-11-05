<script lang="ts" module>
  export const title = 'The selected row';
  export const description =
    'The row whose panel is open is tinted and keeps the shared quiet focus ring, 2px and wrapping the whole row, while its panel is open. Choosing it again closes the panel; Esc or Close in the panel hands focus back to that row through focusCall.';
</script>

<script lang="ts">
  import { ToolCallRail } from '@lostgradient/cinder';

  let selectedId = $state<string | undefined>('lookup-4476');
</script>

<ToolCallRail
  calls={[
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
      result: '$96.00, delivered Tue',
      duration: '0.3s',
      status: 'done',
    },
    {
      id: 'lookup-4480',
      name: 'Lookup order',
      input: '4480',
      result: '$27.25, delivered Tue',
      duration: '0.4s',
      status: 'done',
    },
  ]}
  {selectedId}
  onSelect={(id) => (selectedId = selectedId === id ? undefined : id)}
/>
