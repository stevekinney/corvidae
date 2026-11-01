<script lang="ts">
  /**
   * The Details rail: the facts of one run, each label above its value so a long ID, hash or name
   * has the whole width of the rail to wrap in. What started the run leads (the lineage list), then
   * what ran, the run's ID, when it started and changed, and, for a run the workflow engine holds,
   * its deadline, version, revision, cleanup and tags. Under the facts are the runs related to this
   * one (with a topology that opens in a drawer) and every line the run logged. The run's status is
   * not here: it is in the header, once.
   */
  import { DescriptionList, type DescriptionListItem } from '@lostgradient/cinder';
  import type { WorkflowState } from '@lostgradient/weft';

  import { RUN_PAGE_COPY } from '../../../app/copy.ts';
  import type { ChatContext } from '../../../lib/bureau-client.ts';
  import type { Goal } from '../../../lib/bureau-goals.ts';
  import { isTerminalState, type TaskView } from '../../../lib/bureau-tasks.ts';
  import { formatDuration } from '../../../lib/format/index.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import { getPrincipalStore, scopeGate } from '../../../lib/scopes.svelte.ts';
  import { classifyRevisionAgainstActive } from '../../../lib/workflow-revision.ts';
  import { workflowTypePath } from '../../../lib/workflow-type-paths.ts';
  import { finalizerStatusPresentation } from '../detail/workflow-status.ts';
  import RunLineage from './run-lineage.svelte';
  import RunLogs from './run-logs.svelte';
  import RunRelated from './run-related.svelte';
  import RunTags from './run-tags.svelte';
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
    /** When the run started and last changed, in milliseconds. */
    startedAt?: number | undefined;
    updatedAt?: number | undefined;
    /** Whether the run is over, so its time is the time it took. */
    over?: boolean;
  }

  let {
    runId,
    task,
    goal,
    chat,
    engine,
    workflow,
    recordWorkflow,
    startedAt,
    updatedAt,
    over = false,
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
          .join(' · '),
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

  const items = $derived.by((): DescriptionListItem[] => {
    const list: DescriptionListItem[] = [];
    if (task !== undefined || goal !== undefined) {
      list.push({
        id: 'started-by',
        term: RUN_PAGE_COPY.facts.startedBy,
        definition: startedBy,
      });
    }
    if (workflowType !== undefined) {
      list.push({ id: 'workflow', term: RUN_PAGE_COPY.facts.workflow, definition: workflowLink });
    }
    list.push({
      id: 'run-id',
      term: RUN_PAGE_COPY.facts.runId,
      definition: { type: 'identifier', value: runId, visibleCharacters: 24 },
    });
    if (startedAt !== undefined) {
      list.push({
        id: 'started',
        term: RUN_PAGE_COPY.facts.started,
        definition: { type: 'timestamp', value: startedAt },
      });
    }
    if (updatedAt !== undefined && over) {
      list.push({
        id: 'updated',
        term: RUN_PAGE_COPY.facts.updated,
        definition: { type: 'timestamp', value: updatedAt },
      });
    }
    if (startedAt !== undefined && updatedAt !== undefined && over) {
      list.push({
        id: 'took',
        term: RUN_PAGE_COPY.facts.took,
        definition: formatDuration(Math.max(0, updatedAt - startedAt)),
      });
    }
    if (showDeadline && deadlineRemaining !== null) {
      list.push({
        id: 'deadline',
        term: RUN_PAGE_COPY.facts.deadline,
        definition:
          deadlineRemaining > 0
            ? RUN_PAGE_COPY.deadline(formatDuration(deadlineRemaining))
            : RUN_PAGE_COPY.deadlinePassed,
      });
    }
    if (workflow !== undefined) {
      list.push({ id: 'version', term: RUN_PAGE_COPY.facts.version, definition: version });
      list.push({ id: 'revision', term: RUN_PAGE_COPY.facts.revision, definition: revision });
    }
    if (finalizer?.tooltip !== undefined) {
      list.push({ id: 'cleanup', term: RUN_PAGE_COPY.facts.cleanup, definition: cleanup });
    }
    if (task?.statusMessage) {
      list.push({
        id: 'message',
        term: RUN_PAGE_COPY.facts.message,
        definition: task.statusMessage,
      });
    }
    if (task?.finishReason && isTerminalState(task.status)) {
      list.push({
        id: 'finish-reason',
        term: RUN_PAGE_COPY.facts.finishReason,
        definition: task.finishReason,
      });
    }
    return list;
  });
</script>

{#snippet startedBy()}
  <ol class="ib-run-lineage" data-testid="run-lineage">
    <RunLineage {runId} {task} {goal} {chat} />
  </ol>
{/snippet}

{#snippet workflowLink()}
  {#if workflowType !== undefined}
    {@const path = workflowTypePath(workflowType)}
    <a class="ib-run-value" href={router.href(path)} onclick={(event) => open(event, path)}
      ><code class="ib-identifier">{workflowType}</code></a
    >
  {/if}
{/snippet}

{#snippet version()}
  <code class="ib-identifier ib-run-value">{versionSummary}</code>
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
    <RunTags client={engine.client} {workflow} {tagGate} />
    <RunRelated client={engine.client} {workflow} />
    <RunLogs client={engine.client} workflowId={workflow.id} />
  {/if}
</aside>
