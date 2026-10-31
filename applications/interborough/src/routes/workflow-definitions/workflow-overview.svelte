<script lang="ts">
  /**
   * The Overview tab of a workflow's page: its steps as compact rows (for a file), its input and
   * output as two field lists side by side, what starts it (its schedules), the facts of its
   * contract, and the form that sends a signal. Only what the workflow has is shown: a code-defined
   * type has no steps, and a fact it does not have is no row.
   */
  import { Alert, Badge, EmptyState, SchemaView, SectionHeading } from '@lostgradient/cinder';

  import { WORKFLOW_COPY } from '../../app/copy.ts';
  import { formatRelativeTime } from '../../lib/format/index.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { router, scheduleDetailPath } from '../../lib/router.svelte.ts';
  import type { WorkflowDocument } from '../../lib/workflow-files.ts';
  import SignalForm from './signal-form.svelte';
  import WorkflowDetails from './workflow-details.svelte';
  import {
    hasDefinitionDetails,
    scheduleLabel,
    stepLabel,
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
    /** The file's document, for an agent-authored workflow whose file loaded. */
    document: WorkflowDocument | undefined;
    /** The JSON Schema an instance's input is held to, when the workflow declares one. */
    inputSchema: unknown;
    /** The JSON Schema an instance's result is held to, when the workflow declares one. */
    outputSchema: unknown;
    details: DefinitionDetails;
    /** The workflow's file path, when its file loaded. */
    filePath: string | undefined;
    mode: 'local' | 'remote' | undefined;
    /** The schedules that start the type, or `undefined` until they have loaded. */
    schedules: readonly Schedule[] | undefined;
    schedulesFailed: boolean;
    /** Whether the page offers to send a signal, which only a ready file does. */
    canSignal: boolean;
    /** Whether the workflow has a contract to show: an invalid file has none. */
    showSchemas: boolean;
  }

  let {
    document,
    inputSchema,
    outputSchema,
    details,
    filePath,
    mode,
    schedules,
    schedulesFailed,
    canSignal,
    showSchemas,
  }: Props = $props();

  const copy = WORKFLOW_COPY;

  function go(event: MouseEvent, target: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(target);
  }
</script>

<div class="ib-workflow__overview" data-testid="workflow-overview">
  {#if document !== undefined}
    <section class="ib-workflow__section" aria-label={copy.stepsLabel}>
      <SectionHeading level={2} title={copy.stepsLabel} />
      {#if document.steps.length === 0}
        <EmptyState
          kind="first-use"
          size="compact"
          headingLevel={3}
          title={copy.page.overview.stepsEmptyTitle}
          description={copy.page.overview.stepsEmptyDescription}
        />
      {:else}
        <ol class="ib-workflow__steps" data-testid="workflow-steps">
          {#each keyedByOccurrence( document.steps, (step) => stepLabel(step) ) as { key, item: step } (key)}
            <li class="ib-workflow__step">{stepLabel(step)}</li>
          {/each}
        </ol>
      {/if}
    </section>
  {/if}

  {#if showSchemas}
    <div class="ib-workflow__schemas" data-testid="workflow-schemas">
      <section class="ib-workflow__section" aria-label={copy.page.overview.inputLabel}>
        <SectionHeading level={2} title={copy.page.overview.inputLabel} />
        <SchemaView
          schema={inputSchema ?? null}
          label={copy.page.overview.inputLabel}
          emptyLabel={copy.page.overview.noSchema}
          data-testid="workflow-input-schema"
        />
      </section>
      <section class="ib-workflow__section" aria-label={copy.page.overview.outputLabel}>
        <SectionHeading level={2} title={copy.page.overview.outputLabel} />
        <SchemaView
          schema={outputSchema ?? null}
          label={copy.page.overview.outputLabel}
          emptyLabel={copy.page.overview.noSchema}
          data-testid="workflow-output-schema"
        />
      </section>
    </div>
  {/if}

  {#if schedulesFailed}
    <Alert variant="warning">{copy.page.schedulesFailed}</Alert>
  {:else if schedules !== undefined && schedules.length > 0}
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

  {#if canSignal}
    <SignalForm {document} />
  {/if}

  {#if filePath !== undefined || hasDefinitionDetails(details)}
    <WorkflowDetails {details} {filePath} {document} {mode} />
  {/if}
</div>
