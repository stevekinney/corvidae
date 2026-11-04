<script lang="ts" module>
  export const title = 'Cards with a description';
  export const description =
    'variant="card" draws each choice as a left-aligned card with a radio indicator, an icon, a title and a one-sentence description, for choosing a source type or similar. The selected card takes the accent border and tint.';
</script>

<script lang="ts">
  import { ChoiceGrid } from '@lostgradient/cinder';
  import GlobeIcon from '@lucide/svelte/icons/globe';
  import ServerIcon from '@lucide/svelte/icons/server';

  let source = $state<string | null>('mcp');
</script>

<ChoiceGrid variant="card" columns={2} ariaLabel="What are you connecting?" bind:value={source}>
  <ChoiceGrid.Item
    value="mcp"
    description="A server that offers tools, such as GitHub or a database."
  >
    {#snippet icon()}<ServerIcon />{/snippet}
    MCP server
  </ChoiceGrid.Item>
  <ChoiceGrid.Item value="openapi" description="A web API described by an OpenAPI 3 file.">
    {#snippet icon()}<GlobeIcon />{/snippet}
    OpenAPI spec
  </ChoiceGrid.Item>
</ChoiceGrid>
