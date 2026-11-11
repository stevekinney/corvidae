<script lang="ts">
  /**
   * The Overview tab of a workflow's page: its steps as one numbered list (for a file), its input
   * and output side by side as field lists, what starts it (the schedules of a type that code
   * registered), and the facts of its contract. Only what the workflow has is shown: a code-defined
   * type has no steps, a fact it does not have is no row, and a schema it does not declare is a
   * sentence rather than an empty list with a disclosure. What starts the workflow, when it last ran
   * and where its file is are the header's lines, so the page never repeats them below. A type
   * Interborough runs itself says so here instead.
   */
  import { Alert, Badge, EmptyState, SchemaView, SectionHeading } from '@lostgradient/cinder';

  import { WORKFLOW_COPY } from '../../app/copy.ts';
  import { agentLabel } from '../../lib/agent-label.ts';
  import { formatRelativeTime } from '../../lib/format/index.ts';
  import { router, scheduleDetailPath } from '../../lib/router.svelte.ts';
  import { stepRows, type WorkflowStepSource } from './workflow-page-presentation.ts';
  import WorkflowDetails from './workflow-details.svelte';
  import WorkflowSteps from './workflow-steps.svelte';
  import {
    hasDefinitionDetails,
    scheduleLabel,
    type DefinitionDetails,
  } from './workflow-presentation.ts';

  type Schedule = {
    readonly id: string;
    readonly status: string;
    readonly cronExpression?: string;
    readonly intervalMs?: number;
    readonly lastFireAt?: number | undefined;
  };

  interface Props {
    /**
     * The steps to list: the file's, or, for a file that cannot load, the last good version's.
     * `undefined` for a type with no steps.
     */
    steps: readonly WorkflowStepSource[] | undefined;
    /** The JSON Schema an instance's input is held to, when the workflow declares one. */
    inputSchema: unknown;
    /** The JSON Schema an instance's result is held to, when the workflow declares one. */
    outputSchema: unknown;
    details: DefinitionDetails;
    /** The schedules that start the type, or `undefined` until they have loaded. */
    schedules: readonly Schedule[] | undefined;
    schedulesFailed: boolean;
    /** Whether the workflow has a contract to show: an invalid file has none. */
    showSchemas: boolean;
    /** Words that say what an internal workflow is, in place of the contract it does not show. */
    internalNote?: string | undefined;
    /**
     * Whether the Overview lists the schedules itself: a type that code registered, whose header
     * has no schedule line. A file's header names its schedule, so its Overview does not repeat it.
     */
    listSchedules: boolean;
  }

  let {
    steps: sources,
    inputSchema,
    outputSchema,
    details,
    schedules,
    schedulesFailed,
    showSchemas,
    internalNote,
    listSchedules,
  }: Props = $props();

  const copy = WORKFLOW_COPY;
  const rows = $derived(
    sources === undefined
      ? []
      : stepRows(sources, (identifier) => agentLabel(identifier, undefined)),
  );

  /** A schema the view can list: a JSON Schema object. Anything else is "declares no schema". */
  function declares(schema: unknown): boolean {
    return typeof schema === 'object' && schema !== null;
  }

  function go(event: MouseEvent, target: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(target);
  }
</script>

{#snippet schemaSection(label: string, schema: unknown, testId: string)}
  <section class="ib-workflow__section" aria-label={label}>
    <SectionHeading level={2} title={label} />
    {#if declares(schema)}
      <SchemaView
        {schema}
        {label}
        rawLabel={copy.page.schemaRawLabel}
        emptyLabel={copy.page.overview.noSchema}
        data-testid={testId}
      />
    {:else}
      <p class="ib-workflow__muted" data-testid={testId}>{copy.page.overview.noSchema}</p>
    {/if}
  </section>
{/snippet}

<div class="ib-workflow__overview" data-testid="workflow-overview">
  {#if internalNote !== undefined}
    <p class="ib-workflow__description" data-testid="workflow-internal-note">{internalNote}</p>
  {/if}

  {#if sources !== undefined}
    <section class="ib-workflow__section" aria-label={copy.stepsLabel}>
      <SectionHeading level={2} title={`${copy.stepsLabel} ${String(rows.length)}`} />
      {#if rows.length === 0}
        <EmptyState
          kind="first-use"
          size="compact"
          headingLevel={3}
          title={copy.page.overview.stepsEmptyTitle}
          description={copy.page.overview.stepsEmptyDescription}
        />
      {:else}
        <WorkflowSteps steps={rows} />
      {/if}
    </section>
  {/if}

  {#if showSchemas}
    <div class="ib-workflow__schemas" data-testid="workflow-schemas">
      {@render schemaSection(copy.page.overview.inputLabel, inputSchema, 'workflow-input-schema')}
      {@render schemaSection(
        copy.page.overview.outputLabel,
        outputSchema,
        'workflow-output-schema',
      )}
    </div>
  {/if}

  {#if schedulesFailed}
    <Alert variant="warning">{copy.page.schedulesFailed}</Alert>
  {:else if listSchedules && schedules !== undefined && schedules.length > 0}
    <section class="ib-workflow__section" data-testid="workflow-schedules">
      <SectionHeading level={2} title={copy.page.schedulesHeading} />
      <ul class="ib-workflow__list">
        {#each schedules as schedule (schedule.id)}
          <li data-schedule={schedule.id} data-status={schedule.status}>
            <a
              href={router.href(scheduleDetailPath(schedule.id))}
              onclick={(event) => go(event, scheduleDetailPath(schedule.id))}>{schedule.id}</a
            >
            <span>{scheduleLabel(schedule)}</span>
            <Badge variant={schedule.status === 'active' ? 'success' : 'neutral'} size="sm"
              >{schedule.status === 'active'
                ? copy.page.scheduleActive
                : copy.page.schedulePaused}</Badge
            >
            {#if schedule.lastFireAt !== undefined}
              <span class="ib-workflow__muted">{formatRelativeTime(schedule.lastFireAt)}</span>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if hasDefinitionDetails(details)}
    <WorkflowDetails {details} />
  {/if}
</div>
