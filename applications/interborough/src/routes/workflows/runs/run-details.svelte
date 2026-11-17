<script lang="ts">
  /**
   * The Details rail: the facts of one run, each label above its value so a long ID, hash or name
   * has the whole width of the rail to wrap in. What started the run leads (the lineage list), then
   * what ran, the run's ID, when it started and changed, and, for a run the workflow engine holds,
   * its deadline, version, revision, cleanup and tags. Under the facts are the runs related to this
   * one (with a topology that opens in a drawer), and every line the run logged. The run's status is
   * not here: it is in the header, once.
   */
  import { DescriptionList, StatusDot, type DescriptionListItem } from '@lostgradient/cinder';
  import type { WorkflowState } from '@lostgradient/weft';

  import { RUN_DETAIL_COPY, RUN_PAGE_COPY } from '../../../app/copy/runs.ts';
  import type { ChatContext } from '../../../lib/bureau-client.ts';
  import type { WorkflowFileRun } from '../../../lib/workflow-files.ts';
  import type { Goal } from '../../../lib/bureau-goals.ts';
  import type { TaskView } from '../../../lib/bureau-tasks.ts';
  import { goalPath } from '../../../lib/identifier-paths.ts';
  import { oneLine } from '../../../lib/one-line.ts';
  import { agentLabel } from '../../../lib/agent-label.ts';
  import { router, scheduleDetailPath, workflowDetailPath } from '../../../lib/router.svelte.ts';
  import { getPrincipalStore, scopeGate } from '../../../lib/scopes.svelte.ts';
  import { classifyRevisionAgainstActive } from '../../../lib/workflow-revision.ts';
  import { isBuiltInWorkflow, workflowTypeName } from '../../../lib/workflow-type-name.ts';
  import { workflowTypePath } from '../../../lib/workflow-type-paths.ts';
  import { finalizerStatusPresentation } from '../detail/workflow-status.ts';
  import RunChatRelated from './run-chat-related.svelte';
  import type { BureauSchedule } from '../../../lib/bureau-schedules.ts';
  import type { VersionStanding } from './run-instance.ts';
  import RunRelatedRuns from './run-related-runs.svelte';
  import { scheduleRailRules, scheduleRelatedSentence } from './run-related-lines.ts';
  import RunLineage from './run-lineage.svelte';
  import RunLogs from './run-logs.svelte';
  import RunRelated from './run-related.svelte';
  import { durationWords, goalName } from './run-rows.ts';
  import RunTags from './run-tags.svelte';
  import { runTagsFact } from './run-tags.ts';
  import type { RunEngine } from './run-engine.svelte.ts';

  interface RunDetailsProps {
    runId: string;
    /** The Bureau's task for the run. */
    task?: TaskView | undefined;
    /** The goal whose attempt the run is, when it is one. */
    goal?: Goal | undefined;
    /** The chat the run ran in, when the page has read it. */
    chat?: ChatContext | undefined;
    /** The engine's side of the run, and the run as it holds it. */
    engine?: RunEngine | undefined;
    workflow?: WorkflowState | undefined;
    /** The workflow a run of a workflow file belongs to, from the Bureau's record of it. */
    recordWorkflow?: string | undefined;
    workflowOrigin?: Extract<WorkflowFileRun['origin'], { readonly kind: 'agent-run' }> | null;
    /** When the run started, in milliseconds. */
    startedAt?: number | undefined;
    /** Whether the run is over, which says what its Related runs are. */
    over?: boolean;
    /** Which version the run ran and whether it is the workflow's current one, when read (COR-2424). */
    versionStanding?: VersionStanding | undefined;
    /** The schedule that started the run, when the page has read it. */
    schedule?: BureauSchedule | undefined;
    /** How many occurrences that schedule missed and has not fired since. */
    missedSince?: number | undefined;
    /** The origin the Bureau recorded for a workflow file's run, which has no task (COR-2424). */
    recordOrigin?: object | null | undefined;
    /** Who is viewing the page: their own run reads "You" in Started by. */
    viewer?: string | null | undefined;
  }

  let {
    runId,
    task,
    goal,
    chat,
    engine,
    workflow,
    recordWorkflow,
    workflowOrigin,
    startedAt,
    over = false,
    versionStanding,
    schedule,
    missedSince,
    recordOrigin = undefined,
    viewer = undefined,
  }: RunDetailsProps = $props();

  const principal = getPrincipalStore();
  const tagGate = $derived(scopeGate(principal, ['tags:write']));

  const REVISION_SUFFIX = {
    active: ' — active',
    stale: ' — differs from active',
    unknown: ' — active revision unknown',
  } as const;

  const revisionComparison = $derived(
    workflow === undefined || engine === undefined
      ? 'unpinned'
      : classifyRevisionAgainstActive(workflow.revision, engine.activeRevision),
  );
  const finalizer = $derived(
    workflow === undefined || engine === undefined
      ? undefined
      : finalizerStatusPresentation(workflow.status, engine.finalizerStatus),
  );
  const workflowType = $derived(workflow?.type ?? recordWorkflow);
  const versionSummary = $derived(
    workflow === undefined
      ? ''
      : [
          `wf ${workflow.versionTuple.workflowVersion}`,
          workflow.versionTuple.agentVersion ? `agent ${workflow.versionTuple.agentVersion}` : null,
          workflow.versionTuple.toolVersions && workflow.versionTuple.toolVersions.length > 0
            ? `tools ${workflow.versionTuple.toolVersions.length}`
            : null,
        ]
          .filter((part): part is string => part !== null)
          .join(', '),
  );
  const deadlineRemaining = $derived(
    workflow?.executionDeadline === undefined || engine === undefined
      ? null
      : workflow.executionDeadline - engine.clock.now,
  );
  const showDeadline = $derived(
    deadlineRemaining !== null &&
      workflow !== undefined &&
      (workflow.status === 'pending' ||
        workflow.status === 'running' ||
        workflow.status === 'suspended'),
  );

  /** Opens a link in place, leaving a modified click to the browser. */
  function open(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }

  // A schedule's chat run (row 55m) keeps its Schedule row, has no Tags row and says whether it was
  // the schedule's last run; a workflow file's instance a schedule started (row 55d) says the
  // schedule once, in Started by, keeps its Tags, and says what came from it under Related runs.
  const scheduleRules = $derived(
    scheduleRailRules({ hasTask: task !== undefined, scheduled: schedule !== undefined }),
  );
  const relatedSchedule = $derived(scheduleRules.scheduleRelated ? schedule : undefined);

  // Whether the goal's other attempts or the schedule's last run have something to say under Related runs.
  const relatedHasExtra = $derived(
    goal !== undefined ||
      (relatedSchedule !== undefined &&
        startedAt !== undefined &&
        scheduleRelatedSentence(relatedSchedule, startedAt, missedSince) !== undefined),
  );

  // A run the Bureau has a task for, or a goal's attempt, is said by what it is: its version, its
  // engine revision and its finish reason are not facts of it (rows 54j, 55h). An instance of a
  // workflow file names its version; any other run the engine holds names its version and revision.
  const bureauRun = $derived(task !== undefined || goal !== undefined);
  const showVersion = $derived(
    versionStanding !== undefined || (workflow !== undefined && !bureauRun),
  );
  const showRevision = $derived(
    workflow !== undefined && versionStanding === undefined && !bureauRun,
  );
  // The run's tags, as Cinder's tag list says them: a person's own, and the system's counted.
  const tagsFact = $derived(runTagsFact(workflow?.tags));
  let editingTags = $state(false);
  const showTags = $derived(
    engine !== undefined && workflow !== undefined && scheduleRules.tags && !editingTags,
  );
  // What the run said when it stopped, in one line: never an error's JSON. A canceled run's status
  // line already says it was canceled, so the message says nothing more (row 55h).
  const message = $derived(
    task?.statusMessage && task.status !== 'canceled' ? oneLine(task.statusMessage) : '',
  );

  const items = $derived.by((): DescriptionListItem[] => {
    const list: DescriptionListItem[] = [];
    if (
      task !== undefined ||
      goal !== undefined ||
      workflowOrigin !== undefined ||
      schedule !== undefined
    ) {
      list.push({
        id: 'started-by',
        term: RUN_PAGE_COPY.facts.startedBy,
        definition: startedBy,
      });
    }
    if (goal !== undefined) {
      list.push({ id: 'goal', term: RUN_DETAIL_COPY.facts.goal, definition: goalLink });
    }
    // A goal's attempt names its goal and its agent; the workflow behind it is not a fact (row 55h).
    if (workflowType !== undefined && goal === undefined) {
      list.push({
        id: 'workflow',
        term: RUN_PAGE_COPY.facts.workflow,
        definition: workflowLink,
        // A built-in workflow's identifier and "(built in)" under its name (row 54j).
        ...(isBuiltInWorkflow(workflowType)
          ? { note: `${workflowType} ${RUN_DETAIL_COPY.builtIn}` }
          : {}),
      });
    }
    const agentName = task?.agentName ?? goal?.agentName;
    if (agentName !== undefined && agentName !== null) {
      list.push({
        id: 'agent',
        term: RUN_PAGE_COPY.facts.agent,
        definition: agentLabel(agentName, undefined),
      });
    }
    if (schedule !== undefined && scheduleRules.scheduleRow) {
      list.push({
        id: 'schedule',
        term: RUN_DETAIL_COPY.schedule,
        definition: scheduleLink,
      });
    }
    list.push({
      id: 'run-id',
      term: RUN_PAGE_COPY.facts.runId,
      definition: { type: 'identifier', value: runId, visibleCharacters: 24 },
    });
    // When the run started and how long it took are said once, in the header's status line, and the
    // rail does not say them again (rows 54j, 54p, 55d, 55m list its facts without them).
    if (showDeadline && deadlineRemaining !== null) {
      list.push({
        id: 'deadline',
        term: RUN_PAGE_COPY.facts.deadline,
        definition:
          deadlineRemaining > 0
            ? RUN_PAGE_COPY.deadline(durationWords(deadlineRemaining))
            : RUN_PAGE_COPY.deadlinePassed,
      });
    }
    if (showVersion) {
      list.push({
        id: 'version',
        term: RUN_PAGE_COPY.facts.version,
        definition: version,
        // Where an older version stands against the current one (row 55d), in the list's own note.
        ...(versionStanding?.state === 'older' && versionStanding.current !== null
          ? { note: RUN_DETAIL_COPY.instance.versionOlderNote(versionStanding.current) }
          : {}),
      });
    }
    // An instance of a workflow file names its version above, which is the whole of what the rail
    // says about it (rows 54p, 55d); the revision is for the runs that have no such version.
    if (showRevision) {
      list.push({ id: 'revision', term: RUN_PAGE_COPY.facts.revision, definition: revision });
    }
    if (finalizer?.tooltip !== undefined) {
      list.push({ id: 'cleanup', term: RUN_PAGE_COPY.facts.cleanup, definition: cleanup });
    }
    if (message !== '') {
      list.push({ id: 'message', term: RUN_PAGE_COPY.facts.message, definition: message });
    }
    if (showTags) {
      list.push({
        id: 'tags',
        term: RUN_PAGE_COPY.facts.tags,
        definition: {
          type: 'tags',
          tags: tagsFact.tags,
          systemTagCount: tagsFact.systemTagCount,
          ...(tagGate.disabled ? {} : { onAddTag: () => (editingTags = true) }),
        },
      });
    }
    return list;
  });
</script>

{#snippet startedBy()}
  {#if workflowOrigin?.kind === 'agent-run'}
    <span data-testid="run-lineage">
      An agent's tool call, <span>{workflowOrigin.agentId}</span>,
      <a href={router.href(workflowDetailPath(workflowOrigin.runId))}>Calling run</a>
    </span>
  {:else}
    <ol class="ib-run-lineage" data-testid="run-lineage">
      <RunLineage
        {runId}
        {task}
        {goal}
        {chat}
        {schedule}
        {recordOrigin}
        {viewer}
        startedRun={workflowType === undefined || startedAt === undefined
          ? undefined
          : { title: workflowTypeName(workflowType), startedAt }}
      />
    </ol>
  {/if}
{/snippet}

{#snippet relatedExtra()}
  <RunRelatedRuns
    {runId}
    {goal}
    schedule={relatedSchedule}
    {missedSince}
    {startedAt}
    heading={false}
  />
{/snippet}

{#snippet scheduleLink()}
  {#if schedule !== undefined}
    {@const path = scheduleDetailPath(schedule.id)}
    <a class="ib-run-value" href={router.href(path)} onclick={(event) => open(event, path)}
      >{schedule.description ?? schedule.id}</a
    >
  {/if}
{/snippet}

{#snippet goalLink()}
  {#if goal !== undefined}
    {@const path = goalPath(goal.goalRunId)}
    <a class="ib-run-value" href={router.href(path)} onclick={(event) => open(event, path)}
      >{goalName(goal)}</a
    >
  {/if}
{/snippet}

{#snippet workflowLink()}
  {#if workflowType !== undefined}
    {@const path = workflowTypePath(workflowType)}
    <a class="ib-run-value" href={router.href(path)} onclick={(event) => open(event, path)}
      >{workflowTypeName(workflowType)}</a
    >
  {/if}
{/snippet}

{#snippet version()}
  {#if workflowType !== undefined && isBuiltInWorkflow(workflowType)}
    <span class="ib-run-value">{RUN_DETAIL_COPY.facts.builtInVersion}</span>
  {:else if versionStanding !== undefined && versionStanding.state !== 'unknown'}
    <!-- The version the run ran, and whether it is the workflow's current one (rows 54p, 55d). -->
    <span class="ib-run-value" data-version-state={versionStanding.state}>
      <StatusDot
        status={versionStanding.state === 'current' ? 'success' : 'neutral'}
        label={versionStanding.state === 'current'
          ? RUN_DETAIL_COPY.instance.versionCurrent(versionStanding.ran)
          : RUN_DETAIL_COPY.instance.versionOlder(versionStanding.ran)}
      />
    </span>
  {:else}
    <code class="ib-identifier ib-run-value">{versionSummary}</code>
  {/if}
{/snippet}

{#snippet revision()}
  <span class="ib-run-value">
    {#if revisionComparison === 'unpinned'}
      Unpinned (pre-revision record)
    {:else}
      <code class="ib-identifier">{workflow?.revision}</code>{REVISION_SUFFIX[revisionComparison]}
    {/if}
  </span>
{/snippet}

{#snippet cleanup()}
  <span class="ib-run-value" title={finalizer?.tooltip}>{finalizer?.label}</span>
{/snippet}

<aside class="ib-run__rail" aria-labelledby="ib-run-details">
  <h2 id="ib-run-details" class="ib-run__heading-2">{RUN_PAGE_COPY.detailsHeading}</h2>
  <DescriptionList {items} variant="default" />
  {#if engine !== undefined && workflow !== undefined}
    <!-- Add a tag opens the editor in place of the Tags row. -->
    {#if editingTags && scheduleRules.tags}
      <RunTags client={engine.client} {workflow} {tagGate} />
    {/if}
    <!-- The goal's other attempts and the schedule's last run are said inside the engine's one Related runs. -->
    <RunRelated
      client={engine.client}
      {workflow}
      extra={relatedExtra}
      hasExtra={relatedHasExtra}
      {over}
    />
    <RunLogs client={engine.client} workflowId={workflow.id} />
  {:else}
    <RunRelatedRuns {runId} {goal} schedule={relatedSchedule} {missedSince} {startedAt} />
  {/if}
  {#if task !== undefined && workflow === undefined && task.kind === 'chat'}
    <RunChatRelated runId={task.id} contextId={task.contextId} title={chat?.title ?? undefined} />
  {/if}
</aside>
