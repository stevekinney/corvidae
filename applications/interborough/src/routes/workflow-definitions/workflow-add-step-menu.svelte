<script lang="ts">
  /**
   * The one control that adds a step to a list, wherever the list is: the workflow's own steps, a
   * case, an otherwise path, a list of side-by-side steps, or the steps a repeat runs. Its menu has
   * the built-in kinds first, then each activity the Bureau's catalog lists (by its title) and each
   * code workflow a plugin contributed (by its title). While a catalog loads its group says so in
   * one disabled item, after a failed read it is one item that asks again, and an empty catalog
   * leaves its group out.
   */
  import { Dropdown } from '@lostgradient/cinder';
  import { Plus } from '@lucide/svelte';

  import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
  import { AGENT_ACTIVITY_ID } from '../../lib/bureau-workflow-catalog.ts';
  import { addControlId } from './workflow-builder-addresses.ts';
  import { useBuilderHost } from './workflow-builder-host.ts';
  import { addStep, type BuilderStepKind, type ListPath } from './workflow-builder-model.ts';
  import { startingInput } from './workflow-step-input.ts';

  interface Props {
    /** The list a step is added to. */
    into: ListPath;
    /** That list's address, which makes the trigger's id. */
    list: string;
    /** The trigger's accessible name: "Add a step", or where the step goes when the page holds several lists. */
    name: string;
  }

  let { into, list, name }: Props = $props();

  const host = useBuilderHost();
  const copy = WORKFLOW_COPY.builder;

  /** The kinds the builder draws itself, in the order the menu offers them. */
  const BUILT_IN: readonly { kind: BuilderStepKind; label: string }[] = [
    { kind: 'agent', label: copy.add.agent },
    { kind: 'person', label: copy.add.person },
    { kind: 'signal', label: copy.add.signal },
    { kind: 'wait', label: copy.add.wait },
    { kind: 'branch', label: copy.add.branch },
    { kind: 'parallel', label: copy.add.parallel },
    { kind: 'map', label: copy.add.map },
  ];

  /** The activities to offer: every one the catalog lists but `agent`, which has its own card above. */
  const activityEntries = $derived(
    host.activities.status === 'ready'
      ? host.activities.entries.filter((activity) => activity.id !== AGENT_ACTIVITY_ID)
      : [],
  );

  function add(kind: BuilderStepKind, options: Parameters<typeof addStep>[2] = {}): void {
    host.commit(addStep(host.text, kind, { into, ...options }));
  }

  function addActivity(id: string, schema: Readonly<Record<string, unknown>> | null): void {
    const input = startingInput(id, schema);
    add('activity', { handler: id, ...(input === undefined ? {} : { input }) });
  }

  function addWorkflow(id: string, schema: Readonly<Record<string, unknown>> | null): void {
    const input = startingInput(id, schema);
    add('workflow', { workflow: id, ...(input === undefined ? {} : { input }) });
  }
</script>

<Dropdown id={`${addControlId(list)}-menu`}>
  <Dropdown.Trigger id={addControlId(list)} aria-label={name} onclick={host.requestCatalogs}>
    <Plus aria-hidden="true" size={14} />
    {copy.addLabel}
  </Dropdown.Trigger>
  <Dropdown.Menu>
    {#each BUILT_IN as entry (entry.kind)}
      <Dropdown.Item data-add-kind={entry.kind} onclick={() => add(entry.kind)}>
        {entry.label}
      </Dropdown.Item>
    {/each}

    {#if host.activities.status === 'loading'}
      <Dropdown.Separator />
      <Dropdown.Label>{copy.addMenu.activitiesHeading}</Dropdown.Label>
      <Dropdown.Item disabled>{copy.addMenu.loadingActivities}</Dropdown.Item>
    {:else if host.activities.status === 'failed'}
      <Dropdown.Separator />
      <Dropdown.Label>{copy.addMenu.activitiesHeading}</Dropdown.Label>
      <Dropdown.Item closeOnSelect={false} onclick={host.activities.retry}>
        {copy.addMenu.activitiesFailed}
      </Dropdown.Item>
    {:else if activityEntries.length > 0}
      <Dropdown.Separator />
      <Dropdown.Label>{copy.addMenu.activitiesHeading}</Dropdown.Label>
      {#each activityEntries as activity (activity.id)}
        <Dropdown.Item
          data-add-activity={activity.id}
          onclick={() => addActivity(activity.id, activity.inputSchema)}
        >
          {activity.title ?? host.activityTitle(activity.id)}
        </Dropdown.Item>
      {/each}
    {/if}

    {#if host.workflows.status === 'loading'}
      <Dropdown.Separator />
      <Dropdown.Label>{copy.addMenu.workflowsHeading}</Dropdown.Label>
      <Dropdown.Item disabled>{copy.addMenu.loadingWorkflows}</Dropdown.Item>
    {:else if host.workflows.status === 'failed'}
      <Dropdown.Separator />
      <Dropdown.Label>{copy.addMenu.workflowsHeading}</Dropdown.Label>
      <Dropdown.Item closeOnSelect={false} onclick={host.workflows.retry}>
        {copy.addMenu.workflowsFailed}
      </Dropdown.Item>
    {:else if host.workflows.entries.length > 0}
      <Dropdown.Separator />
      <Dropdown.Label>{copy.addMenu.workflowsHeading}</Dropdown.Label>
      {#each host.workflows.entries as workflow (workflow.id)}
        <Dropdown.Item
          data-add-workflow={workflow.id}
          onclick={() => addWorkflow(workflow.id, workflow.inputSchema)}
        >
          {workflow.title}
        </Dropdown.Item>
      {/each}
    {/if}
  </Dropdown.Menu>
</Dropdown>
