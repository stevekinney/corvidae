<script lang="ts">
  /**
   * `/workflows/:type`: one workflow type. Every type shows the engine's definition (its schemas, the
   * signals, updates and queries it accepts, and its active revision) and the schedules that start
   * it. A code-defined type shows the engine's revision panel and offers nothing to change. An
   * agent-authored one shows its file's steps, trigger, agent, and path, and the versions that have
   * run, and offers pause, resume, delete, edit, and send signal.
   *
   * A write names the hash of the file the page read, so a file that changed on disk since is
   * refused instead of overwritten: the page says the workflow changed outside Interborough, with a
   * reload, and changes nothing. A write that succeeds takes the file's new hash at once, so the
   * next action is not stale against the page's own write. A file that is gone is the frame's
   * not-found state, so the page asks the frame to look again. An invalid file shows its problem and
   * path and offers only delete and edit, and has no definition section.
   */
  import {
    Alert,
    Badge,
    Button,
    CodeLocation,
    ConfirmDialog,
    Skeleton,
  } from '@lostgradient/cinder';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { RETRY_LABEL, WORKFLOW_COPY } from '../../app/copy.ts';
  import { agentFaultOf, type AgentFault } from '../../lib/agent-definitions.ts';
  import { getClient } from '../../lib/client.ts';
  import { formatRelativeTime } from '../../lib/format/index.ts';
  import { getHostPaths, workflowFilePath } from '../../lib/host-paths.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { queryKeys, workflowViewInstance } from '../../lib/query.ts';
  import { router, scheduleDetailPath } from '../../lib/router.svelte.ts';
  import {
    availableActions,
    awaitedSignals,
    resolveWorkflow,
    startingSchedules,
    type WorkflowResolution,
  } from '../../lib/workflow-catalog.ts';
  import { workflowEditPath, workflowRunsPath } from '../../lib/workflow-type-paths.ts';
  import {
    deleteWorkflowFile,
    isApplyFailure,
    parseWorkflowText,
    pauseWorkflowFile,
    resumeWorkflowFile,
  } from '../../lib/workflow-files.ts';
  import WorkflowRevisionsPanel from '../system/workflow-revisions-panel.svelte';
  import DefinitionSection from './definition-section.svelte';
  import FileProblem from './file-problem.svelte';
  import RevisionHistory from './revision-history.svelte';
  import SignalForm from './signal-form.svelte';
  import { scheduleLabel, stepLabel, triggerLabel } from './workflow-presentation.ts';

  const copy = WORKFLOW_COPY;
  const client = getClient();
  const queryClient = useQueryClient();

  // One page belongs to one type: the outlet mounts a new page when the path changes.
  const type = untrack(() => router.current.params['type'] ?? '');
  const detailKey = queryKeys.workflowCatalog.detail(type);

  const resolution = createQuery(
    () => ({
      queryKey: detailKey,
      queryFn: async ({ signal }) => (await resolveWorkflow(client, type, { signal })) ?? null,
    }),
    undefined,
  );

  const schedules = createQuery(
    () => ({
      queryKey: queryKeys.workflowCatalog.schedules(type),
      queryFn: async () => {
        const page = await client.listSchedules({ workflowType: type });
        return startingSchedules(page.items);
      },
    }),
    undefined,
  );

  // Where the file is. A host that does not say shows the path relative to the state directory.
  const hostPaths = createQuery(
    () => ({ queryKey: queryKeys.hostPaths(), queryFn: ({ signal }) => getHostPaths({ signal }) }),
    undefined,
  );

  const resolved = $derived(resolution.data ?? undefined);
  const file = $derived(resolved?.kind === 'agent-authored' ? resolved.file : undefined);
  const document = $derived(file === undefined ? undefined : parseWorkflowText(file.text));
  const actions = $derived(file === undefined ? undefined : availableActions(file));
  const path = $derived(
    file === undefined
      ? ''
      : workflowFilePath(hostPaths.data?.workflowDirectory ?? copy.fallbackDirectory, file.id),
  );

  /** A write was refused because the file changed on disk after the page loaded. */
  let stale = $state(false);
  /** A write failed for a reason the person can act on, in the Bureau's words. */
  let failure = $state<{ readonly title: string; readonly message: string } | null>(null);
  let confirmingDelete = $state(false);
  /** The Bureau changed the file and the engine could not follow, so what is on disk is the change. */
  let unapplied = $state(false);

  /** A file that is gone, or never was: the frame owns that state, so it is asked to look again. */
  function workflowIsGone(): void {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.view('workflows', workflowViewInstance('/workflows/:type', type)),
    });
  }

  function failWith(fault: AgentFault, title: string): void {
    switch (fault.kind) {
      case 'stale':
        // The page's picture of the file is out of date, so what it said about it no longer holds.
        unapplied = false;
        stale = true;
        return;
      case 'not-found':
        workflowIsGone();
        return;
      case 'forbidden':
        failure = { title, message: copy.forbidden };
        return;
      case 'identifier-taken':
        // Only a create names an identifier, and this page never creates.
        failure = { title, message: title };
        return;
      case 'rejected':
      case 'other':
        failure = { title, message: fault.message };
        return;
    }
  }

  /** Takes the file's new hash and paused flag at once, then reads the file again to confirm. */
  function adopt(result: { readonly hash: string }, paused: boolean): void {
    // The write went through and the engine followed it, so nothing is left unapplied.
    unapplied = false;
    queryClient.setQueryData<WorkflowResolution | null>(detailKey, (previous) =>
      previous?.kind === 'agent-authored'
        ? { ...previous, file: { ...previous.file, hash: result.hash, paused } }
        : previous,
    );
    void queryClient.invalidateQueries({ queryKey: detailKey });
    void queryClient.invalidateQueries({ queryKey: queryKeys.workflowCatalog.list() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.workflowCatalog.schedules(type) });
  }

  /** The write reached the file: take what is on disk, and say the engine has not followed yet. */
  async function adoptWhatIsOnDisk(): Promise<void> {
    unapplied = true;
    await queryClient.invalidateQueries({ queryKey: detailKey });
    void queryClient.invalidateQueries({ queryKey: queryKeys.workflowCatalog.list() });
  }

  /** Sorts a refused write: one the Bureau made and the engine could not apply is not a failure. */
  function writeFailed(error: unknown, title: string): void {
    if (isApplyFailure(error)) {
      void adoptWhatIsOnDisk();
      return;
    }
    failWith(agentFaultOf(error), title);
  }

  /** After a delete: the list of workflows, which no longer shows this one. */
  function leaveForTheList(): void {
    router.navigate('/workflows');
    void queryClient.invalidateQueries({ queryKey: queryKeys.workflowCatalog.list() });
  }

  const pause = createMutation(() => ({
    mutationFn: (hash: string) => pauseWorkflowFile(type, hash),
    onMutate: () => {
      failure = null;
    },
    onSuccess: (result) => adopt(result, true),
    onError: (error) => writeFailed(error, copy.pauseFailed),
  }));

  const resume = createMutation(() => ({
    mutationFn: (hash: string) => resumeWorkflowFile(type, hash),
    onMutate: () => {
      failure = null;
    },
    onSuccess: (result) => adopt(result, false),
    onError: (error) => writeFailed(error, copy.resumeFailed),
  }));

  const removal = createMutation(() => ({
    mutationFn: (hash: string) => deleteWorkflowFile(type, hash),
    onMutate: () => {
      failure = null;
    },
    onSuccess: leaveForTheList,
    // A delete the Bureau made and the engine could not apply has still removed the file, so it
    // ends where a delete does.
    onError: (error) =>
      isApplyFailure(error) ? leaveForTheList() : writeFailed(error, copy.deleteFailed),
  }));

  const busy = $derived(pause.isPending || resume.isPending || removal.isPending);

  /** Runs a write against the hash of the file the page read, when the file has one. */
  function act(write: (hash: string) => void): void {
    const hash = file?.hash;
    if (hash !== undefined && hash !== null) write(hash);
  }

  /** Reads the file again, which discards what the page believed of it. */
  async function reload(): Promise<void> {
    const result = await resolution.refetch();
    if (result.isError) {
      failWith(agentFaultOf(result.error), copy.loadFailed.title);
      return;
    }
    stale = false;
    unapplied = false;
    failure = null;
    if (result.data === null) workflowIsGone();
  }

  // Both services no longer know the type: it was deleted after the frame looked. That is the
  // frame's not-found state, so it is asked to look again.
  $effect(() => {
    if (resolution.data === null) untrack(workflowIsGone);
  });

  function go(event: MouseEvent, target: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(target);
  }

  const runsPath = workflowRunsPath(type);
  const editPath = workflowEditPath(type);
  const condition = $derived(stale ? 'stale' : 'ready');
  const acceptedSignals = $derived(
    resolved?.kind === 'code' ? (resolved.definition.signals ?? []) : awaitedSignals(document),
  );
</script>

<article class="weft-workflow-type" data-page="workflow-detail" data-condition={condition}>
  <header class="weft-workflow-type__header">
    <div class="weft-workflow-type__identity">
      <h1 class="weft-workflow-type__title">{type}</h1>
      {#if file !== undefined}
        <div class="weft-workflow-type__badges">
          <Badge variant="accent" size="sm">{copy.agentAuthoredBadge}</Badge>
          {#if file.state === 'invalid'}
            <Badge variant="danger" size="sm">{copy.invalidBadge}</Badge>
          {/if}
          {#if file.paused}
            <Badge variant="neutral" size="sm">{copy.pausedBadge}</Badge>
          {/if}
        </div>
      {/if}
    </div>
    <div class="weft-workflow-type__actions">
      <Button
        href={router.href(runsPath)}
        variant="secondary"
        size="sm"
        onclick={(event) => go(event, runsPath)}>{copy.runsAction}</Button
      >
      {#if file !== undefined && actions !== undefined}
        {#if actions.edit}
          <Button
            href={router.href(editPath)}
            variant="secondary"
            size="sm"
            onclick={(event) => go(event, editPath)}>{copy.editAction}</Button
          >
        {/if}
        {#if actions.pause && !file.paused}
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || file.hash === null}
            onclick={() => act(pause.mutate)}>{copy.pauseAction}</Button
          >
        {/if}
        {#if actions.resume && file.paused}
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || file.hash === null}
            onclick={() => act(resume.mutate)}>{copy.resumeAction}</Button
          >
        {/if}
        {#if actions.delete}
          <Button
            variant="danger"
            size="sm"
            disabled={busy}
            onclick={() => (confirmingDelete = true)}>{copy.deleteAction}</Button
          >
        {/if}
      {/if}
    </div>
  </header>

  {#if stale}
    <Alert variant="warning">
      <p class="weft-workflow-type__alert-title">{copy.stale.title}</p>
      <p class="weft-workflow-type__alert-body">{copy.stale.description}</p>
      <Button variant="secondary" onclick={() => void reload()}>{copy.stale.action}</Button>
    </Alert>
  {/if}

  {#if unapplied}
    <Alert variant="warning">
      <p class="weft-workflow-type__alert-title">{copy.applyFailed.title}</p>
      <p class="weft-workflow-type__alert-body">{copy.applyFailed.description}</p>
    </Alert>
  {/if}

  {#if failure !== null}
    <Alert variant="danger" dismissible onDismiss={() => (failure = null)}>
      <p class="weft-workflow-type__alert-title">{failure.title}</p>
      <p class="weft-workflow-type__alert-body">{failure.message}</p>
    </Alert>
  {/if}

  {#if resolution.isError}
    <Alert variant="danger">
      <p class="weft-workflow-type__alert-title">{copy.loadFailed.title}</p>
      <p class="weft-workflow-type__alert-body">{copy.loadFailed.description}</p>
      <Button variant="secondary" onclick={() => void resolution.refetch()}>{RETRY_LABEL}</Button>
    </Alert>
  {:else if resolution.isPending}
    <div role="status" aria-busy="true" aria-label={type}>
      <Skeleton height="1.5rem" width="40%" />
      <Skeleton height="12rem" />
    </div>
  {:else if resolved !== undefined}
    {#if file !== undefined}
      <section class="weft-workflow-type__section" aria-label={copy.fileLabel}>
        <dl class="weft-workflow-facts">
          <dt>{copy.fileLabel}</dt>
          <dd><CodeLocation file={path} data-testid="workflow-file-path" /></dd>
          {#if file.agent !== null}
            <dt>{copy.agentLabel}</dt>
            <dd data-testid="workflow-agent">{file.agent}</dd>
          {/if}
          {#if document !== undefined}
            <dt>{copy.triggerLabel}</dt>
            <dd data-testid="workflow-trigger">{triggerLabel(document.trigger)}</dd>
          {/if}
        </dl>
        {#if file.problem !== null}
          <Alert variant="danger">
            <FileProblem problem={file.problem} />
          </Alert>
        {/if}
        {#if document !== undefined}
          <h2 class="weft-workflow-section__heading">{copy.stepsLabel}</h2>
          {#if document.steps.length === 0}
            <p class="weft-workflow-type__none">{copy.noSteps}</p>
          {:else}
            <ol class="weft-workflow-type__steps" data-testid="workflow-steps">
              {#each keyedByOccurrence( document.steps, (step) => stepLabel(step) ) as { key, item: step } (key)}
                <li>{stepLabel(step)}</li>
              {/each}
            </ol>
          {/if}
        {/if}
      </section>
    {/if}

    {#if resolved.kind === 'code'}
      <DefinitionSection definition={resolved.definition} signals={acceptedSignals} />
    {:else if resolved.definition !== undefined}
      <DefinitionSection definition={resolved.definition} signals={acceptedSignals} />
    {:else if file?.state === 'ready'}
      <section class="weft-workflow-type__section">
        <h2 class="weft-workflow-section__heading">{copy.definition.heading}</h2>
        <p class="weft-workflow-type__none">{copy.definition.notRegistered}</p>
        <dl class="weft-workflow-facts">
          <dt>{copy.definition.signals}</dt>
          <dd data-testid="workflow-accepted-signals">
            {acceptedSignals.length === 0 ? copy.definition.none : acceptedSignals.join(', ')}
          </dd>
        </dl>
      </section>
    {/if}

    <section class="weft-workflow-type__section" data-testid="workflow-schedules">
      <h2 class="weft-workflow-section__heading">{copy.schedules.heading}</h2>
      {#if schedules.isError}
        <p role="alert">{copy.schedules.failed}</p>
      {:else if schedules.isPending}
        <Skeleton height="2rem" />
      {:else if schedules.data.length === 0}
        <p class="weft-workflow-type__none">{copy.schedules.none}</p>
      {:else}
        <ul class="weft-workflow-type__schedules">
          {#each schedules.data as schedule (schedule.id)}
            <li data-schedule={schedule.id} data-status={schedule.status}>
              <a
                href={router.href(scheduleDetailPath(schedule.id))}
                onclick={(event) => go(event, scheduleDetailPath(schedule.id))}>{schedule.id}</a
              >
              <span>{scheduleLabel(schedule)}</span>
              <Badge variant={schedule.status === 'active' ? 'success' : 'neutral'} size="sm"
                >{schedule.status === 'active'
                  ? copy.schedules.active
                  : copy.schedules.paused}</Badge
              >
              {#if schedule.lastFireAt !== undefined}
                <span class="weft-workflow-type__muted">
                  {formatRelativeTime(schedule.lastFireAt)}
                </span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    {#if resolved.kind === 'code'}
      <section class="weft-workflow-type__section">
        <WorkflowRevisionsPanel workflowName={type} />
      </section>
    {:else}
      <RevisionHistory id={type} />
    {/if}

    {#if actions?.signal === true}
      <SignalForm {document} />
    {/if}
  {/if}
</article>

<ConfirmDialog
  bind:open={confirmingDelete}
  title={copy.deleteDialog.title}
  description={copy.deleteDialog.description(type)}
  confirmLabel={copy.deleteDialog.confirm}
  destructive
  onConfirm={() => act(removal.mutate)}
/>

<style>
  .weft-workflow-type {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .weft-workflow-type__header {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    align-items: flex-start;
    justify-content: space-between;
  }

  .weft-workflow-type__identity {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  .weft-workflow-type__title {
    margin: 0;
    font-size: var(--cinder-text-xl);
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .weft-workflow-type__badges,
  .weft-workflow-type__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .weft-workflow-type__section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .weft-workflow-type__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .weft-workflow-type__alert-body {
    margin: 4px 0 8px;
  }

  .weft-workflow-type__none,
  .weft-workflow-type__muted {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .weft-workflow-type__steps {
    margin: 0;
    padding-inline-start: var(--cinder-space-6);
    overflow-wrap: anywhere;
  }

  .weft-workflow-type__schedules {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .weft-workflow-type__schedules li {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    align-items: center;
    padding: var(--cinder-space-2) var(--cinder-space-3);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-md);
    font-size: var(--cinder-text-sm);
  }
</style>
