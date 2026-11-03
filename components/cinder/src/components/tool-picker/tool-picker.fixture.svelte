<script lang="ts">
  import ToolPicker from './tool-picker.svelte';
  import type { ToolPickerGroup, ToolPickerItem } from './tool-picker.types.ts';

  let {
    items,
    groups,
    initial = [],
    onDone,
    onCancel,
  }: {
    items: ToolPickerItem[];
    groups?: ToolPickerGroup[];
    initial?: string[];
    onDone?: (selected: string[]) => void;
    onCancel?: () => void;
  } = $props();

  let open = $state(false);
  // The initial choices seed the page's state once.
  // svelte-ignore state_referenced_locally
  let selected = $state<string[]>([...initial]);
</script>

<button type="button" data-testid="open" onclick={() => (open = true)}>Add tools</button>
<output data-testid="chosen">{selected.join(',')}</output>
<ToolPicker
  bind:open
  bind:selected
  {items}
  {groups}
  {...onDone ? { onDone } : {}}
  {...onCancel ? { onCancel } : {}}
/>
