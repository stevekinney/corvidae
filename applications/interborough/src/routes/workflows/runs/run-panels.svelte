<script lang="ts">
  /**
   * The plugin panels on a run's page (COR-1894): each MCP app a running plugin contributes that
   * opens from `bureau.tasks.inspect`, which is the run inspector. A panel renders through Chat's
   * `McpApp`, sandboxed to `allow-scripts` and nothing else, labelled with the plugin it comes
   * from. It owns no client and no credential: the host serves its page and runs the tools it
   * declared, as the person looking at the page. A host that lists no panel, or cannot list them,
   * leaves the page as it was.
   */
  import { McpApp } from '@lostgradient/chat';
  import { Badge } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { RUN_PAGE_COPY } from '../../../app/copy.ts';
  import { getMcpApps, loadPluginApp, pluginToolCaller } from '../../../lib/host-mcp-apps.ts';
  import { queryKeys } from '../../../lib/query.ts';

  /** The Bureau tool that opens the run inspector, and so the panels that belong to a run. */
  const RUN_PANEL_TOOL = 'bureau.tasks.inspect';

  interface RunPanelsProps {
    /** The Bureau task the panels show. */
    taskId: string;
  }

  let { taskId }: RunPanelsProps = $props();

  const apps = createQuery(
    () => ({
      queryKey: queryKeys.hostMcpApps(),
      queryFn: ({ signal }) => getMcpApps({ signal }),
      retry: false,
    }),
    undefined,
  );
  // Bureau composition keeps every app's `ui://` URI unique across plugins, so the URI keys the list.
  const panels = $derived(
    (apps.data ?? []).filter((candidate) => candidate.opensFromTool === RUN_PANEL_TOOL),
  );
</script>

{#each panels as panel (panel.uri)}
  {@const loadResource = () => loadPluginApp(panel.plugin, panel.app)}
  {@const onToolCall = pluginToolCaller(panel.plugin, panel.app)}
  <section
    class="ib-run__section"
    aria-labelledby="ib-run-panel-{panel.plugin}-{panel.app}"
    data-section="plugin-panel"
    data-plugin={panel.plugin}
  >
    <h2 id="ib-run-panel-{panel.plugin}-{panel.app}" class="ib-run__heading-2">
      {panel.title}
      <Badge>{RUN_PAGE_COPY.panelFromPlugin(panel.plugin)}</Badge>
    </h2>
    {#key taskId}
      <McpApp
        resourceUri={panel.uri}
        title={panel.title}
        {loadResource}
        {onToolCall}
        toolInput={{ arguments: { taskId } }}
      />
    {/key}
  </section>
{/each}
