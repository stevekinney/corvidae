<script lang="ts" module>
  export const title = 'Forty or more tools';
  export const description =
    'From forty selectable items the counter reads the total, and every group but the first starts collapsed under its sticky header. The list scrolls inside the dialog, and searching opens every group that has a match.';
</script>

<script lang="ts">
  import { Button, ToolPicker, type ToolPickerItem } from '@lostgradient/cinder';

  let open = $state(false);
  let selected = $state<string[]>([]);

  const sources: [name: string, count: number][] = [
    ['Built in', 6],
    ['GitHub', 21],
    ['Payments API', 15],
  ];

  const items: ToolPickerItem[] = sources.flatMap(([name, count]) =>
    Array.from({ length: count }, (_, index) => ({
      value: `${name}-${index + 1}`,
      label: `${name} tool ${index + 1}`,
      code: `${name.toLowerCase().replaceAll(' ', '-')}_${index + 1}`,
      description: `Does one thing in ${name}`,
      group: name,
      meta: index % 5 === 0 ? 'Dangerous' : index % 2 === 0 ? 'Changes things' : 'Reads',
      detail: index % 5 === 0 ? 'Always (default)' : 'On changes (default)',
    })),
  );
</script>

<Button variant="secondary" onclick={() => (open = true)}>Add tools</Button>
<p>{selected.length} chosen.</p>

<ToolPicker bind:open bind:selected {items} />
