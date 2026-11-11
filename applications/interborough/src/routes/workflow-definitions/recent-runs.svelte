<script lang="ts">
  /**
   * The Runs tab (board PageWorkflow, "Runs tab"): the Runs list of `/runs`, limited to this
   * workflow. The same filter bar leads it, with the six status segments and their counts (All,
   * Waiting on you, Running, Done, Failed, Canceled) and the Started by chip, then the same
   * status-first two-line rows (`run-list-row.svelte`) under day bands that name the zone their
   * times are in. Each row opens the run under this workflow.
   *
   * `/runs` reads the Bureau's tasks, and no task names its workflow, so the tab reads this
   * workflow's own instances (`workflow-run-rows.ts`): a file's from the Bureau
   * (`bureau.workflows.runs.list`) and a code type's from the engine, the newest twenty, as the
   * header counts them for the tab's name. The filters are this tab's own and are not kept in the
   * address, which holds the tab. A workflow that has not run keeps the bar, every count at 0, over
   * the compact empty state ("Runs tab, empty"): a disc with a play glyph, a title, one sentence,
   * and a plain hint that names the header's action, Start run, or Resume for a paused workflow.
   * The link to every run of the workflow closes the tab.
   */
  import {
    Alert,
    Button,
    DataList,
    EmptyState,
    FilterBar,
    Skeleton,
    type AppliedFilter,
    type FacetDefinition,
    type FilterSegment,
  } from '@lostgradient/cinder';
  import { Play } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';

  import { RETRY_LABEL, TASK_COPY, WORKFLOW_COPY } from '../../app/copy.ts';
  import { agentLabel as agentLabelOf } from '../../lib/agent-label.ts';
  import { getClient } from '../../lib/client.ts';
  import { followLinks } from '../../lib/follow-links.ts';
  import { viewerTimeZone } from '../../lib/format/clock.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router, workflowRunPath } from '../../lib/router.svelte.ts';
  import { listWorkflowFileRuns } from '../../lib/workflow-files.ts';
  import { workflowRunsPath } from '../../lib/workflow-type-paths.ts';
  import { HOME_CLOCK_MILLISECONDS } from '../home/home-clock.svelte.ts';
  import {
    filterRunRows,
    RUN_SEGMENTS,
    RUN_STATUS_SEGMENTS,
    runDayGroup,
    runSegmentCounts,
    type RunFilter,
    type RunRow,
  } from '../workflows/runs/run-rows.ts';
  import RunListRow from '../workflows/runs/run-list-row.svelte';
  import { STARTED_BY_KINDS, STARTED_BY_LABELS } from '../workflows/runs/started-by.ts';
  import { workflowRunRows, type WorkflowRunSummary } from './workflow-run-rows.ts';

  interface Props {
    /** The workflow's type, which is its file's identifier for an agent-authored workflow. */
    type: string;
    /** Whose runs: the Bureau's for a file, the engine's for a code-defined type. */
    kind: 'code' | 'agent-authored';
    /** The workflow's name as its header reads it: the title of every row. */
    title: string;
    /** The agent the workflow runs, or `null` when it names none: line two's agent. */
    agentName: string | null;
    /** Whether the header offers Start run, which the empty state's hint then names. */
    canStart: boolean;
    /** Whether the workflow is a paused file, whose empty state says why nothing starts it. */
    paused: boolean;
  }

  let { type, kind, title, agentName, canStart, paused }: Props = $props();

  const copy = WORKFLOW_COPY.page.runs;
  const client = getClient();
  /** How many runs the tab lists: as many as the header counts for the tab's name. */
  const RECENT_LIMIT = 20;

  const runs = createQuery(
    () => ({
      queryKey: queryKeys.workflowCatalog.recentRuns(kind, type),
      queryFn: async ({ signal }): Promise<readonly WorkflowRunSummary[]> => {
        if (kind === 'agent-authored') {
          const files = await listWorkflowFileRuns(type, RECENT_LIMIT, { signal });
          return files.map((run) => ({
            id: run.id,
            status: run.status,
            createdAt: Date.parse(run.createdAt),
            updatedAt: Date.parse(run.updatedAt),
            origin: run.origin ?? null,
          }));
        }
        const page = await client.list({ type, limit: RECENT_LIMIT });
        return page.items.map((run) => ({
          id: run.id,
          status: run.status,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          origin: null,
        }));
      },
      retry: false,
    }),
    undefined,
  );

  const runsPath = $derived(workflowRunsPath(type));

  function agentLabel(name: string): string {
    return agentLabelOf(name, undefined);
  }

  const everyRun = $derived<RunRow[]>(workflowRunRows(runs.data ?? [], { title, agentName }));

  // The tab's own filters: a status segment, and what started the run.
  let filter = $state<RunFilter>({});
  const others = $derived<RunFilter>(
    filter.startedBy === undefined ? {} : { startedBy: filter.startedBy },
  );
  const unsegmented = $derived(filterRunRows(everyRun, others, agentLabel));
  const counts = $derived(runSegmentCounts(unsegmented));
  const rows = $derived(
    filter.status === undefined
      ? unsegmented
      : filterRunRows(unsegmented, { status: filter.status }, agentLabel),
  );

  const segments = $derived<FilterSegment[]>(
    RUN_SEGMENTS.map((value) => ({
      value,
      label: TASK_COPY.list.segments[value],
      // The counts wait for the read: a segment is not 0 because the read has not arrived.
      count: runs.isPending ? 'pending' : counts[value],
    })),
  );
  const facets: FacetDefinition[] = [
    {
      type: 'choice',
      key: 'startedBy',
      label: TASK_COPY.startedByLabel,
      multiple: false,
      options: STARTED_BY_KINDS.map((value) => ({ value, label: STARTED_BY_LABELS[value] })),
    },
  ];
  const appliedFilters = $derived<AppliedFilter[]>(
    filter.startedBy === undefined
      ? []
      : [{ key: 'startedBy', value: filter.startedBy, label: TASK_COPY.startedByLabel }],
  );

  function chooseSegment(value: string): void {
    const status = RUN_STATUS_SEGMENTS.find((segment) => segment === value);
    const { status: _status, ...rest } = filter;
    filter = status === undefined ? rest : { ...rest, status };
  }

  function chooseStartedBy(value: string): void {
    const startedBy = STARTED_BY_KINDS.find((one) => one === value);
    const { startedBy: _startedBy, ...rest } = filter;
    filter = startedBy === undefined ? rest : { ...rest, startedBy };
  }

  // The clock line two's waits and running durations are counted to, read again each minute.
  const zone = viewerTimeZone();
  let now = $state(Date.now());
  $effect(() => {
    // poll-reason: clock
    const timer = setInterval(() => {
      now = Date.now();
    }, HOME_CLOCK_MILLISECONDS);
    return () => clearInterval(timer);
  });

  /** What the empty state says, by why nothing has run: paused, startable, or started elsewhere. */
  const empty = $derived.by(() => {
    if (paused) return { description: copy.emptyDescriptionPaused, hint: copy.emptyHintPaused };
    if (canStart) return { description: copy.emptyDescription, hint: copy.emptyHint };
    return { description: copy.emptyDescriptionCode, hint: undefined };
  });

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<section class="ib-workflow__section ib-workflow-runs" data-testid="workflow-recent-runs">
  {#if runs.isError}
    <Alert variant="danger">
      <p class="ib-workflow__alert-body">{WORKFLOW_COPY.page.runsFailed}</p>
      <Button variant="secondary" size="sm" onclick={() => void runs.refetch()}
        >{RETRY_LABEL}</Button
      >
    </Alert>
  {:else}
    <FilterBar
      aria-label={copy.filtersLabel}
      {segments}
      segmentValue={filter.status ?? 'all'}
      segmentsLabel={TASK_COPY.statusLabel}
      {facets}
      {appliedFilters}
      searchVisible={false}
      onSegmentChange={chooseSegment}
      onFacetChange={(key, value) => {
        if (key === 'startedBy') chooseStartedBy(value);
      }}
      onFilterRemove={(key) => {
        if (key === 'startedBy') chooseStartedBy('');
      }}
    />
    {#if runs.isPending}
      <div role="status" aria-busy="true" aria-label={WORKFLOW_COPY.page.recentRuns}>
        <Skeleton height="1.5rem" />
      </div>
    {:else if everyRun.length === 0}
      <EmptyState
        kind="first-use"
        size="compact"
        headingLevel={3}
        title={copy.emptyTitle}
        description={empty.description}
      >
        {#snippet icon()}<Play aria-hidden="true" />{/snippet}
        {#snippet action()}
          {#if empty.hint !== undefined}
            <p class="ib-workflow-runs__hint" data-testid="workflow-runs-hint">{empty.hint}</p>
          {/if}
        {/snippet}
      </EmptyState>
    {:else if rows.length === 0}
      <EmptyState
        kind="filtered"
        size="compact"
        headingLevel={3}
        title={copy.noMatchTitle}
        description={copy.noMatchDescription}
        clearFiltersLabel={TASK_COPY.clearAction}
        onClearFilters={() => (filter = {})}
      />
    {:else}
      <div class="ib-workflow-runs__list" {@attach followLinks}>
        <DataList
          items={rows}
          key={(row: RunRow) => row.id}
          aria-label={copy.rowsLabel}
          groupBy={(row: RunRow) => runDayGroup(row.startedAt, now, zone)}
        >
          {#snippet children(row: RunRow)}
            <RunListRow {row} {now} {zone} {agentLabel} href={workflowRunPath(type, row.id)} />
          {/snippet}
        </DataList>
      </div>
    {/if}
  {/if}
  <p class="ib-workflow-runs__all">
    <a href={router.href(runsPath)} onclick={(event) => go(event, runsPath)}
      >{WORKFLOW_COPY.runsAction}</a
    >
  </p>
</section>
