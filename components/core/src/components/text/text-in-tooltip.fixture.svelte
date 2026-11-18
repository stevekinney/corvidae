<script lang="ts">
  import Tooltip from '@lostgradient/tooltip/components/tooltip/tooltip.svelte';
  import Text from './text.svelte';

  let { text }: { text: string } = $props();
</script>

<Tooltip text="Outer hint">
  <Text as="span" truncate="end" {text} />
</Tooltip>
