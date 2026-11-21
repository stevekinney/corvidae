<script lang="ts">
  /**
   * `/settings/mcp`: where Interborough's MCP endpoint is and how to connect a coding agent or an
   * MCP client to it (COR-2539). The body is `mcp-body.svelte`; this is the Settings frame around
   * it, with the section navigation and the heading.
   */
  import { MCP_COPY } from '../../../app/copy/mcp.ts';
  import { SETTINGS_SECTION_COPY } from '../../../app/copy/settings.ts';
  import SettingsFrame from '../settings-frame.svelte';
  import McpBody from './mcp-body.svelte';
</script>

<SettingsFrame title={SETTINGS_SECTION_COPY.mcp} intro={MCP_COPY.intro} page="settings-mcp">
  {#snippet body({ schema, snapshot })}
    <McpBody {schema} {snapshot} />
  {/snippet}
</SettingsFrame>
