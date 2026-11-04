<script lang="ts">
  import ServerIcon from '@lucide/svelte/icons/server';
  import GlobeIcon from '@lucide/svelte/icons/globe';
  import ChoiceGrid from './choice-grid.svelte';
  import ChoiceGridItem from '../choice-grid-item/choice-grid-item.svelte';

  let {
    value = $bindable('mcp'),
    values = $bindable([]),
    multiple = false,
    variant = 'card',
  }: {
    value?: string | null;
    values?: string[];
    multiple?: boolean;
    variant?: 'tile' | 'card';
  } = $props();
</script>

<ChoiceGrid
  {variant}
  {multiple}
  columns={2}
  ariaLabel="What are you connecting?"
  bind:value
  bind:values
>
  <ChoiceGridItem
    value="mcp"
    description="A server that offers tools, such as GitHub or a database."
  >
    {#snippet icon()}<ServerIcon />{/snippet}
    MCP server
  </ChoiceGridItem>
  <ChoiceGridItem value="openapi" description="A web API described by an OpenAPI 3 file.">
    {#snippet icon()}<GlobeIcon />{/snippet}
    OpenAPI spec
  </ChoiceGridItem>
</ChoiceGrid>
