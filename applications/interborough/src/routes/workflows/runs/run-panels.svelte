<script lang="ts">
  /**
   * The plugin panels on a run's page (COR-1894, COR-2214): each MCP app a running plugin
   * contributes with a `run` placement, the run inspector among them, ordered by plugin name and
   * then in the order the host lists a plugin's panels. A panel renders through Chat's `McpApp`,
   * sandboxed to `allow-scripts` and nothing else, labelled with the plugin it comes from. It owns
   * no client and no credential: the host serves its page and runs the tools it declared, as the
   * person looking at the page. A host that lists no panel, or cannot list them, leaves the page as
   * it was.
   */
  import { McpApp } from '@lostgradient/chat';
  import { Section } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { RUN_PAGE_COPY } from '../../../app/copy/runs.ts';
  import { getPanels, loadPluginApp, pluginToolCaller } from '../../../lib/host-panels.ts';
  import { queryKeys } from '../../../lib/query.ts';

  /**
   * The run the panels show: a Bureau task (an agent run), or a run only the workflow engine holds
   * (a workflow instance, a fork among them), which has no task. Exactly one is given. `failed` is
   * whether the run failed: a panel that placed itself `when: 'failed'` is mounted only then
   * (COR-2543), so a run that did not fail shows no card with nothing to say.
   */
  type RunPanelsProps = (
    { taskId: string; workflowId?: never } | { workflowId: string; taskId?: never }
  ) & { failed?: boolean };

  let { taskId, workflowId, failed = false }: RunPanelsProps = $props();

  /**
   * What each run placement passes its panel (owner decision 2026-11-22): an agent run is
   * `{ taskId }`, as it always was; a workflow instance is `{ runId, runKind: 'workflow' }`, with no
   * `taskId`, so a panel that reads a task is never handed an id that names none.
   */
  const run = $derived(
    workflowId === undefined
      ? { key: `task:${String(taskId)}`, input: { taskId } }
      : { key: `workflow:${workflowId}`, input: { runId: workflowId, runKind: 'workflow' } },
  );

  const apps = createQuery(
    () => ({
      queryKey: queryKeys.hostPanels(),
      queryFn: ({ signal }) => getPanels({ signal }),
      retry: false,
    }),
    undefined,
  );
  // The host lists a plugin's panels in the order it declared them. The sort is stable, so that
  // order holds within a plugin; plugin names compare by code unit, never by locale. Bureau
  // composition keeps every app's `ui://` URI unique across plugins, so the URI keys the list.
  const panels = $derived(
    (apps.data ?? [])
      .filter((candidate) =>
        candidate.placements.some(
          (placement) =>
            placement.kind === 'run' &&
            (placement.when === undefined || (placement.when === 'failed' && failed)),
        ),
      )
      .toSorted((left, right) =>
        left.plugin < right.plugin ? -1 : left.plugin > right.plugin ? 1 : 0,
      ),
  );
</script>

{#each panels as panel (panel.uri)}
  {@const loadResource = () => loadPluginApp(panel.plugin, panel.app)}
  {@const onToolCall = pluginToolCaller(panel.plugin, panel.app)}
  <!-- Cinder's Section: the panel's title, with the plugin it comes from as the line under it. -->
  <Section
    title={panel.title}
    description={RUN_PAGE_COPY.panelFromPlugin(panel.plugin)}
    data-section="plugin-panel"
    data-plugin={panel.plugin}
    data-app={panel.app}
  >
    {#key run.key}
      <McpApp
        resourceUri={panel.uri}
        title={panel.title}
        {loadResource}
        {onToolCall}
        toolInput={{ arguments: run.input }}
      />
    {/key}
  </Section>
{/each}
