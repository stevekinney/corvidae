<script lang="ts">
  /**
   * The plugin panels on a run's page (COR-1894, COR-2214): each MCP app a running plugin
   * contributes with a `run` placement, the run inspector among them, ordered by plugin name and
   * then in the order the host lists a plugin's panels. A panel is mounted only when it has
   * something to say about this run (`run-panel-scope.ts`). It renders through Chat's `McpApp`,
   * sandboxed to `allow-scripts` and nothing else, in a region named by its title and with no card
   * title of its own: the panel draws its own heading. It owns no client and no credential: the
   * host serves its page and runs the tools it declared, as the person looking at the page. A host
   * that lists no panel, or cannot list them, leaves the page as it was.
   */
  import { McpApp } from '@lostgradient/chat';
  import { createQuery } from '@tanstack/svelte-query';

  import { getPanels, loadPluginApp, pluginToolCaller } from '../../../lib/host-panels.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { panelHasSomethingToSay, type RunPanelRun } from './run-panel-scope.ts';

  /**
   * The run the panels show: a Bureau task (an agent run), or a run only the workflow engine holds
   * (a workflow instance, a fork among them), which has no task. Exactly one is given. A workflow
   * instance also says whether it is a fork, which decides whether the comparison has anything to
   * say. `failed` is whether the run failed.
   *
   * One rule mounts a panel, from two parts that both must hold: the panel has a `run` placement
   * that is on (no `when`, or `when: 'failed'` and the run failed, COR-2543, so a run that did not
   * fail shows no card with nothing to say), and the host's scope table says the panel has something
   * to say about this kind of run (`run-panel-scope.ts`, COR-2544).
   */
  type RunPanelsProps = (
    | { taskId: string; workflowId?: never; fork?: never }
    | { workflowId: string; fork: boolean; taskId?: never }
  ) & { failed?: boolean };

  let { taskId, workflowId, fork, failed = false }: RunPanelsProps = $props();

  /** What the page knows about the run, for the panels' mounting rules (`run-panel-scope.ts`). */
  const runScope = $derived<RunPanelRun>(
    workflowId === undefined ? { kind: 'task' } : { kind: 'workflow', fork: fork === true },
  );

  /**
   * What each run placement passes its panel (COR-2544, owner decision 2026-11-22): an agent run is
   * `{ taskId }`, as it always was; a workflow instance is `{ runId, runKind: 'workflow' }`, with no
   * `taskId`, so a panel that reads a task is never handed an id that names none, and one that reads
   * a workflow run (the run comparison) reads `runId`.
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
      // A run placement that is on: no `when`, or `when: 'failed'` and the run failed.
      .filter((candidate) =>
        candidate.placements.some(
          (placement) =>
            placement.kind === 'run' &&
            (placement.when === undefined || (placement.when === 'failed' && failed)),
        ),
      )
      // A card is mounted only when it has something to say about this kind of run.
      .filter((candidate) => panelHasSomethingToSay(candidate.plugin, candidate.app, runScope))
      .toSorted((left, right) =>
        left.plugin < right.plugin ? -1 : left.plugin > right.plugin ? 1 : 0,
      ),
  );
</script>

{#each panels as panel (panel.uri)}
  {@const loadResource = () => loadPluginApp(panel.plugin, panel.app)}
  {@const onToolCall = pluginToolCaller(panel.plugin, panel.app)}
  <!-- No card title and no "From the … plugin" line: the panel draws its own heading, and the
       plugin it comes from is not what a person reading the run needs. The name is the region's. -->
  <section
    class="weft-run-panel"
    aria-label={panel.title}
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
  </section>
{/each}

<style>
  .weft-run-panel {
    min-inline-size: 0;
  }
</style>
