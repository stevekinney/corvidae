<script lang="ts">
  /**
   * `/workflows/:workflow`: one workflow type, in four tabs. Overview leads with what a person acts
   * on: what the workflow is for, what starts it and whether it is active, its steps (for a file),
   * its input and output, and, for a file, send signal. Code is the file's source, or, for a type
   * code defined, the description and contract it registered. Runs is its newest runs and a link to
   * all of them. History is the versions that have run, each with whether it is compatible with the
   * current one; a type the Bureau registers for itself has none. The header holds start run, pause,
   * resume, edit and delete, which only a file has.
   *
   * A write names the hash of the file the page read, so a file that changed on disk since is
   * refused instead of overwritten: the page says the workflow changed outside Interborough, with a
   * reload, and changes nothing. A write that succeeds takes the file's new hash at once, so the
   * next action is not stale against the page's own write. A file that is gone is the frame's
   * not-found state, so the page asks the frame to look again. An invalid file shows its problem and
   * path and offers only delete and edit, and has no steps, schemas or runs.
   */
  import {
    Alert,
    Badge,
    Button,
    CodeLocation,
    ConfirmDialog,
    PageHeader,
    Skeleton,
    Tabs,
  } from '@lostgradient/cinder';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { RETRY_LABEL, WORKFLOW_COPY } from '../../app/copy.ts';
  import { agentFaultOf, type AgentFault } from '../../lib/agent-definitions.ts';
  import { getClient } from '../../lib/client.ts';
  import { getHostPaths, workflowFilePath } from '../../lib/host-paths.ts';
  import { queryKeys, workflowViewInstance } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import {
    availableActions,
    awaitedSignals,
    isEngineType,
    resolveWorkflow,
    startingSchedules,
    type WorkflowResolution,
  } from '../../lib/workflow-catalog.ts';
  import { workflowEditPath, workflowTypePath } from '../../lib/workflow-type-paths.ts';
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
  import StartRunDialog from './start-run-dialog.svelte';
  import WorkflowCode from './workflow-code.svelte';
  import WorkflowOverview from './workflow-overview.svelte';
  import {
    definitionDetails,
    schedulesSummary,
    schemaOf,
    triggerSummary,
  } from './workflow-presentation.ts';

  const copy = WORKFLOW_COPY;
  const client = getClient();
  const queryClient = useQueryClient();

  // One page belongs to one type: the outlet mounts a new page when the path changes.
  const type = untrack(() => router.current.params['workflow'] ?? '');
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
      queryKey: queryKeys.view('workflows', workflowViewInstance('/workflows/:workflow', type)),
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
  // What starts the workflow: a file's trigger, or the schedules the engine has for a code type.
  const starts = $derived(
    file !== undefined
      ? triggerSummary(document?.trigger ?? null)
      : schedulesSummary(schedules.data ?? null),
  );
  const engineType = isEngineType(type);
  // A file that loaded declares its schemas itself; otherwise the engine's contract does.
  const inputSchema = $derived(schemaOf(file?.inputSchema, definition, 'inputSchema'));
  const outputSchema = $derived(schemaOf(file?.outputSchema, definition, 'outputSchema'));
  const invalidFile = $derived(file !== undefined && file.state === 'invalid');
  /** A run starts from a ready, unpaused file the Bureau may write; the engine's own types start themselves. */
  const canStart = $derived(
    !engineType && file !== undefined && file.state === 'ready' && !file.paused,
  );
  let starting = $state(false);

  type TabValue = 'overview' | 'code' | 'runs' | 'history';
  /** The tabs this workflow has: an invalid file has no runs, and a type the Bureau registers for itself has no history. */
  const tabs = $derived<readonly TabValue[]>([
    'overview',
    'code',
    ...(invalidFile ? [] : (['runs'] as const)),
    ...(engineType ? [] : (['history'] as const)),
  ]);

  // The URL owns the tab, so a tab can be linked and the back button returns to it: `activeTab`
  // mirrors `?tab=` both ways, and each effect writes only when its target differs. Overview is
  // the address with no `tab`.
  let activeTab = $state(untrack(() => router.search.get('tab') ?? 'overview'));
  /** The tab shown: one this workflow does not have falls back to Overview. */
  const shownTab = $derived(tabs.some((tab) => tab === activeTab) ? activeTab : 'overview');

  $effect(() => {
    const next = shownTab;
    const search = new URLSearchParams(router.search);
    if ((search.get('tab') ?? 'overview') === next) return;
    if (next === 'overview') search.delete('tab');
    else search.set('tab', next);
    const query = search.size === 0 ? '' : `?${search.toString()}`;
    router.navigate(`${workflowTypePath(type)}${query}`, { replace: true });
  });

  $effect(() => {
    const fromUrl = router.search.get('tab') ?? 'overview';
    if (fromUrl !== activeTab) activeTab = fromUrl;
  });
</script>

{#snippet headerActions()}
  {#if file !== undefined && actions !== undefined}
    {#if canStart}
      <Button variant="primary" size="sm" disabled={busy} onclick={() => (starting = true)}
        >{copy.page.startAction}</Button
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
    {#if actions.edit}
      <Button
        href={router.href(editPath)}
        variant="secondary"
        size="sm"
        onclick={(event) => go(event, editPath)}>{copy.editAction}</Button
      >
    {/if}
    {#if actions.delete}
      <Button variant="danger" size="sm" disabled={busy} onclick={() => (confirmingDelete = true)}
        >{copy.deleteAction}</Button
      >
    {/if}
  {/if}
{/snippet}

<article class="ib-workflow" data-page="workflow-detail" data-condition={condition}>
  <PageHeader headingLevel={1} title={type} actions={headerActions} />
  <div class="ib-workflow__identity">
    <div class="ib-workflow__heading">
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
        <CodeLocation class="weft-code-location" file={path} data-testid="workflow-file-path" />
      </Alert>
    {/if}

    <Tabs bind:value={activeTab}>
      <Tabs.List label={copy.page.tabsLabel}>
        <Tabs.Trigger value="overview">{copy.page.tabs.overview}</Tabs.Trigger>
        <Tabs.Trigger value="code">{copy.page.tabs.code}</Tabs.Trigger>
        {#if tabs.includes('runs')}
          <Tabs.Trigger value="runs">{copy.page.tabs.runs}</Tabs.Trigger>
        {/if}
        {#if tabs.includes('history')}
          <Tabs.Trigger value="history">{copy.page.tabs.history}</Tabs.Trigger>
        {/if}
      </Tabs.List>

      <Tabs.Panel value="overview">
        <WorkflowOverview
          {document}
          {inputSchema}
          {outputSchema}
          {details}
          filePath={file?.state === 'ready' ? path : undefined}
          mode={hostPaths.data?.mode}
          schedules={schedules.data}
          schedulesFailed={schedules.isError}
          canSignal={actions?.signal === true}
          showSchemas={!invalidFile}
        />
      </Tabs.Panel>
      <Tabs.Panel value="code">
        <WorkflowCode {type} kind={resolved.kind} text={file?.text ?? null} {document} />
      </Tabs.Panel>
      {#if tabs.includes('runs')}
        <Tabs.Panel value="runs">
          <RecentRuns
            {type}
            kind={resolved.kind}
            onStart={canStart ? () => (starting = true) : undefined}
          />
        </Tabs.Panel>
      {/if}
      {#if tabs.includes('history')}
        <Tabs.Panel value="history">
          {#if resolved.kind === 'code'}
            <WorkflowRevisionsPanel workflowName={type} />
          {:else}
            <RevisionHistory id={type} />
          {/if}
        </Tabs.Panel>
      {/if}
    </Tabs>
  {/if}
</article>

{#if canStart}
  <StartRunDialog {type} bind:open={starting} />
{/if}

<ConfirmDialog
  bind:open={confirmingDelete}
  title={copy.deleteDialog.title}
  description={copy.deleteDialog.description(type)}
  confirmLabel={copy.deleteDialog.confirm}
  destructive
  onConfirm={() => act(removal.mutate)}
/>
