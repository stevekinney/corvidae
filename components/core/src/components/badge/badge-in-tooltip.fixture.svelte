<script lang="ts">
  import Tooltip from '../tooltip/tooltip.svelte';
  import Badge from './badge.svelte';

  let { label }: { label: string } = $props();
</script>

<Tooltip text="Outer hint">
  <Badge truncate>{label}</Badge>
</Tooltip>
