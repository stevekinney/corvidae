<script lang="ts">
  /**
   * `/workflows/:type`: one workflow type, leading with what a person acts on: what it is for,
   * what starts it and whether it is active, its steps (for a file), its last five runs and a
   * link to all of them, and, for a file, pause, resume, edit, delete, and send signal. What the
   * engine's contract says (the signals, updates and queries it accepts, the schemas of its input
   * and output) and where a file is sit in a Details disclosure that exists only when it has
   * something in it. The revisions, and the form that installs one, sit in a collapsed Engine
   * disclosure, which a type the Bureau registers for itself does not have.
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
    Collapsible,
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
    isEngineType,
    resolveWorkflow,
    startingSchedules,
    type WorkflowResolution,
  } from '../../lib/workflow-catalog.ts';
  import { workflowEditPath } from '../../lib/workflow-type-paths.ts';
  import {
    deleteWorkflowFile,
    isApplyFailure,
    parseWorkflowText,
    pauseWorkflowFile,
    resumeWorkflowFile,
  } from '../../lib/workflow-files.ts';
  import WorkflowRevisionsPanel from '../system/workflow-revisions-panel.svelte';
  import FileProblem from './file-problem.svelte';
  import RecentRuns from './recent-runs.svelte';
  import RevisionHistory from './revision-history.svelte';
  import SignalForm from './signal-form.svelte';
  import WorkflowDetails from './workflow-details.svelte';
  import {
    definitionDetails,
    hasDefinitionDetails,
    scheduleLabel,
    schedulesSummary,
    stepLabel,
    triggerSummary,
  } from './workflow-presentation.ts';

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

  const editPath = workflowEditPath(type);
  const condition = $derived(stale ? 'stale' : 'ready');
  const acceptedSignals = $derived(
    resolved?.kind === 'code' ? (resolved.definition.signals ?? []) : awaitedSignals(document),
  );
  /** The engine's definition of the type: a code type's own, or the one it loaded a ready file as. */
  const definition = $derived(resolved?.definition);
  const description = $derived(
    resolved?.kind === 'agent-authored'
      ? (file?.description ?? null)
      : (definition?.description ?? null),
  );
  const details = $derived(definitionDetails(definition, acceptedSignals));
  // A file that loaded always has its path to show; a code type has something to show only if its contract does.
  const showDetails = $derived(file?.state === 'ready' || hasDefinitionDetails(details));
  // What starts the workflow: a file's trigger, or the schedules the engine has for a code type.
  const starts = $derived(
    file !== undefined
      ? triggerSummary(document?.trigger ?? null)
      : schedulesSummary(schedules.data ?? null),
  );
  const engineType = isEngineType(type);
  const hasSchedules = $derived((schedules.data?.length ?? 0) > 0);
</script>

<article class="ib-workflow" data-page="workflow-detail" data-condition={condition}>
  <header class="ib-workflow__header">
    <div class="ib-workflow__identity">
      <div class="ib-workflow__heading">
        <h1 class="ib-workflow__title">{type}</h1>
        {#if resolved !== undefined}
          <Badge variant={file === undefined ? 'neutral' : 'accent'} size="sm"
            >{file === undefined ? copy.codeBadge : copy.agentAuthoredBadge}</Badge
          >
        {/if}
        {#if file !== undefined && file.state === 'invalid'}
          <Badge variant="danger" size="sm">{copy.invalidBadge}</Badge>
        {/if}
        {#if file?.agent !== null && file?.agent !== undefined}
          <code class="ib-workflow-agent" data-testid="workflow-agent">{file.agent}</code>
        {/if}
      </div>
      {#if description}
        <p class="ib-workflow__description" data-testid="workflow-description">{description}</p>
      {/if}
      {#if starts !== null || file?.state === 'ready'}
        <p class="ib-workflow__status">
          {#if starts !== null}
            <span data-testid="workflow-trigger">
              {#if starts.kind === 'signal'}{copy.list.onSignal}
                <code>{starts.name}</code>{:else}{starts.words}{/if}
            </span>
          {/if}
          {#if file?.state === 'ready'}
            <span data-testid="workflow-state"
              >{file.paused ? copy.page.statusPaused : copy.page.statusActive}</span
            >
          {/if}
        </p>
      {/if}
    </div>
    {#if file !== undefined && actions !== undefined}
      <div class="ib-workflow__actions">
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
        {#if actions.edit}
          <Button
            href={router.href(editPath)}
            variant="secondary"
            size="sm"
            onclick={(event) => go(event, editPath)}>{copy.editAction}</Button
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
      </div>
    {/if}
  </header>

  {#if stale}
    <Alert variant="warning">
      <p class="ib-workflow__alert-title">{copy.stale.title}</p>
      <p class="ib-workflow__alert-body">{copy.stale.description}</p>
      <Button variant="secondary" size="sm" onclick={() => void reload()}
        >{copy.stale.action}</Button
      >
    </Alert>
  {/if}

  {#if unapplied}
    <Alert variant="warning">
      <p class="ib-workflow__alert-title">{copy.applyFailed.title}</p>
      <p class="ib-workflow__alert-body">{copy.applyFailed.description}</p>
    </Alert>
  {/if}

  {#if failure !== null}
    <Alert variant="danger" dismissible onDismiss={() => (failure = null)}>
      <p class="ib-workflow__alert-title">{failure.title}</p>
      <p class="ib-workflow__alert-body">{failure.message}</p>
    </Alert>
  {/if}

  {#if resolution.isError}
    <Alert variant="danger">
      <p class="ib-workflow__alert-title">{copy.loadFailed.title}</p>
      <p class="ib-workflow__alert-body">{copy.loadFailed.description}</p>
      <Button variant="secondary" size="sm" onclick={() => void resolution.refetch()}
        >{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if resolution.isPending}
    <div role="status" aria-busy="true" aria-label={type}>
      <Skeleton height="1.5rem" width="40%" />
      <Skeleton height="12rem" />
    </div>
  {:else if resolved !== undefined}
    {#if file !== undefined && file.problem !== null}
      <Alert variant="danger">
        <FileProblem problem={file.problem} />
        <CodeLocation file={path} data-testid="workflow-file-path" />
      </Alert>
    {/if}

    {#if document !== undefined}
      <section class="ib-workflow__section" aria-labelledby="ib-workflow-steps">
        <h2 id="ib-workflow-steps" class="weft-workflow-section__heading">{copy.stepsLabel}</h2>
        {#if document.steps.length === 0}
          <p class="ib-workflow__muted">{copy.noSteps}</p>
        {:else}
          <ol class="ib-workflow__steps" data-testid="workflow-steps">
            {#each keyedByOccurrence( document.steps, (step) => stepLabel(step) ) as { key, item: step } (key)}
              <li>{stepLabel(step)}</li>
            {/each}
          </ol>
        {/if}
      </section>
    {/if}

    {#if !(file !== undefined && file.state === 'invalid')}
      <RecentRuns {type} kind={resolved.kind} />
    {/if}

    {#if schedules.isError}
      <p class="ib-workflow__muted" role="alert">{copy.page.schedulesFailed}</p>
    {:else if hasSchedules && schedules.data !== undefined}
      <section class="ib-workflow__section" data-testid="workflow-schedules">
        <h2 class="weft-workflow-section__heading">{copy.page.schedulesHeading}</h2>
        <ul class="ib-workflow__list">
          {#each schedules.data as schedule (schedule.id)}
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
                <span class="ib-workflow__muted">
                  {formatRelativeTime(schedule.lastFireAt)}
                </span>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if actions?.signal === true}
      <SignalForm {document} />
    {/if}

    {#if showDetails}
      <Collapsible trigger={copy.page.details} class="ib-disclosure">
        <WorkflowDetails
          {details}
          filePath={file?.state === 'ready' ? path : undefined}
          {document}
        />
      </Collapsible>
    {/if}

    {#if !engineType}
      <Collapsible trigger={copy.page.engine} class="ib-disclosure">
        {#if resolved.kind === 'code'}
          <WorkflowRevisionsPanel workflowName={type} />
        {:else}
          <RevisionHistory id={type} />
        {/if}
      </Collapsible>
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
