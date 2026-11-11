<script lang="ts">
  /**
   * The agent editor (`/agents/new`, `/agents/:agent/edit`): creates an agent, or edits and deletes one, and lists the versions of it that have run.
   *
   * An agent is a Markdown file. The page reads it with its `hash`, builds the form once from what
   * it read, and names that hash in every write, so a file that changed on disk since is never
   * overwritten: the write is refused and the page says the agent changed outside Interborough,
   * with a reload that discards unsaved edits. A file that is gone is the not-found state, which
   * the view frame owns, so the page asks the frame to look again. A write that succeeds lands on
   * the agent's page, and a delete lands on the list.
   *
   * One Save sits in the form's sticky bar, after Cancel; ⌘Enter submits from anywhere on the page.
   * Save stays enabled (W35): a submit marks the fields that stop a save and focuses the first one,
   * and sends nothing until they are fixed. While a save is in flight the bar says "Saving…" and
   * Save is in its loading state; a save with no answer after {@link SAVE_TIMEOUT_MS} is stopped,
   * and the page says it could not confirm the save, keeps what was typed, and offers Try again and
   * Cancel (row 14x). It never says saved without the server's answer. A save the server fails
   * says so above the form, with what was typed still in it (row 42w). There is no draft and
   * nothing to publish: under the heading, a new agent's form says what an agent is (row 41a), and
   * an agent that exists says that a change is saved as a new version and that running chats keep
   * the version they started with (row 41q), naming the version a save in flight makes (row 43k).
   * The sticky bar says which version the agent is at (row 41y). The file line gives the file's
   * path relative to the Interborough home, with the full path in a tooltip and a copy button (row
   * 41r). While the agent is read, the form is placeholders with a Save that cannot be pressed
   * (rows 43h, 43i); the top bar's trail names the agent once it is read (row 41q).
   *
   * Leaving a form that differs from what was saved asks first (rows 42o, 42p), through the
   * router's {@link LeaveGuard}: Cancel, the breadcrumb, a link in the shell, back and forward, and
   * closing the tab. A save that lands, and a delete, go on without asking.
   *
   * What the form offers comes from `bureau.agents.catalog` and nothing else, and the A2A
   * switch is saved with the rest of the definition. A catalog with no model offers
   * nothing a save could use, so the page shows where to configure a provider instead of the form,
   * with Cancel in the header and no Save (row 42a). A new agent's catalog that fails to load
   * builds the form anyway, with the model field saying so and a Try again that keeps what was
   * typed (row 42v); the view frame's probe has already read the catalog once, so this is a read
   * that failed after it.
   *
   * Try it chats with the form as it stands, saved or not (`agent-try-drawer.svelte`), and nothing
   * is written. At desktop width it is a panel always open beside the form (row 41n); below 1024px
   * it is a secondary "Try it" button in the header beside the title (row 43t) that opens a 360px
   * right sheet on a tablet (row 44a) and a bottom sheet on a phone (row 43x). Closing the sheet
   * keeps the transcript for the next opening (rows 43z, 44b). A new agent's subtitle drops "beside
   * the form" on a tablet and the whole Try it clause on a phone (rows 44a, 43u).
   *
   * `/agents/new?from=<agent>` is Duplicate: the form for a new agent, filled from that agent (a
   * file agent's definition whole, a built-in agent's own statement of itself, `agent-copy.ts`). It
   * is named and created like any new agent, and a taken identifier is refused the same way.
   */
  import { onMount, tick, untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';

  import {
    Alert,
    Button,
    CodeLocation,
    ConfirmDialog,
    CopyButton,
    PageHeader,
    Skeleton,
    Tooltip,
  } from '@lostgradient/cinder';
  import { HttpClientError } from '@lostgradient/weft';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { usePageLabel } from '../../app/breadcrumbs.svelte.ts';
  import { AGENT_EDITOR_COPY, RETRY_LABEL } from '../../app/copy.ts';
  import {
    agentFaultOf,
    createAgent,
    deleteAgent,
    getAgentCatalog,
    getAgentDefinition,
    listAgentVersions,
    updateAgent,
    type AgentCatalog,
    type AgentFault,
  } from '../../lib/agent-definitions.ts';
  import { agentPath } from '../../lib/agent-paths.ts';
  import { shortcuts } from '../../lib/shortcuts.ts';
  import { getSettings } from '../../lib/bureau-settings.ts';
  import { agentFilePath, agentRelativePath, getHostPaths } from '../../lib/host-paths.ts';
  import { getProviders } from '../../lib/host-providers.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { LeaveGuard, router } from '../../lib/router.svelte.ts';
  import { restrictionsOf } from './agent-editor-models.ts';
  import { MODEL_POLICY_KEY } from '../settings/settings-controls.ts';
  import { AgentEditorState, type ModelContext } from './agent-editor-state.svelte.ts';
  import { copyIdentifierOf, copySeedOf } from './agent-copy.ts';
  import AgentEditorForm from './agent-editor-form.svelte';
  import AgentEditorLoading from './agent-editor-loading.svelte';
  import AgentEditorNoProvider from './agent-editor-no-provider.svelte';
  import AgentTryDrawer from './agent-try-drawer.svelte';
  import {
    TRY_BOTTOM_SHEET_QUERY,
    TRY_SHEET_QUERY,
    tryPlacementOf,
  } from './agent-try-session.svelte.ts';
  import { SAVE_TIMEOUT_MS } from './agent-editor-save.ts';

  interface Props {
    /** The identifier of the agent to edit; absent on `/agents/new`. */
    id?: string | undefined;
  }

  let { id }: Props = $props();

  const copy = AGENT_EDITOR_COPY;
  const queryClient = useQueryClient();

  // One page belongs to one agent: the outlet mounts a new page when the path changes.
  const agentId = untrack(() => id);
  // The agent a new agent is copied from (Duplicate), when the address names one.
  const copiedFrom = untrack(() => (id === undefined ? router.search.get('from') : null));

  // What the page reads once and then holds. A background refetch must not replace a form the
  // person is typing in, so nothing here refetches on its own and the form is built once.
  const stable = {
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    gcTime: 0,
    retry: false,
  } as const;

  // While the catalog offers no model, coming back to the window reads it again: a person who left
  // to connect a provider returns to the form. Once it offers one, the form is built from it and a
  // refetch must not change its choices.
  const catalog = createQuery(() => ({
    ...stable,
    refetchOnWindowFocus: () =>
      queryClient.getQueryData<AgentCatalog>(queryKeys.agents.catalog())?.models.length === 0,
    queryKey: queryKeys.agents.catalog(),
    queryFn: ({ signal }) => getAgentCatalog({ signal }),
  }));

  const detail = createQuery(() => ({
    ...stable,
    queryKey: queryKeys.agents.definition(agentId ?? ''),
    queryFn: ({ signal }) => getAgentDefinition(agentId ?? '', { signal }),
    enabled: agentId !== undefined,
  }));

  const source = createQuery(() => ({
    ...stable,
    queryKey: queryKeys.agents.definition(copiedFrom ?? ''),
    queryFn: ({ signal }) => getAgentDefinition(copiedFrom ?? '', { signal }),
    enabled: copiedFrom !== null,
  }));

  // What narrows the model field besides the catalog: the host's providers, to name the ones with
  // no key, and the model policy, to leave out what it forbids. The page works without either, and
  // offers what the catalog lists. The page marks a forbidden model in advance; the Bureau is what
  // refuses a save that names one, and the page shows that refusal like any other.
  const providers = createQuery(() => ({
    ...stable,
    queryKey: queryKeys.hostProviders(),
    queryFn: ({ signal }) => getProviders({ signal }),
  }));
  const policy = createQuery(() => ({
    ...stable,
    queryKey: queryKeys.settings.snapshot(),
    queryFn: ({ signal }) => getSettings({ signal }),
  }));

  /** Both have answered, one way or the other, so the form is built from what they said. */
  const modelContextSettled = $derived(!providers.isPending && !policy.isPending);

  function modelContext(
    providersData: typeof providers.data,
    policyData: typeof policy.data,
  ): ModelContext {
    return {
      hostProviders: providersData?.providers,
      ...(policyData === undefined
        ? {}
        : { restrictions: restrictionsOf(policyData.values[MODEL_POLICY_KEY]) }),
    };
  }

  // Where the file is. The page works without it, so a host that does not say shows the path
  // relative to the state directory.
  const hostPaths = createQuery(() => ({
    ...stable,
    queryKey: queryKeys.hostPaths(),
    queryFn: ({ signal }) => getHostPaths({ signal }),
  }));

  // The latest saved version, for the line under the heading. The page works without it.
  const versions = createQuery(() => ({
    ...stable,
    queryKey: queryKeys.agents.versions(agentId ?? ''),
    queryFn: ({ signal }) => listAgentVersions(agentId ?? '', { signal }),
    enabled: agentId !== undefined,
  }));
  const latestVersion = $derived(versions.data?.[0]);

  let editor = $state<AgentEditorState>();
  /** A write was refused because the file changed on disk after the form was filled. */
  let stale = $state(false);
  /** A write failed for a reason the person can act on, in the Bureau's words. */
  let failure = $state<{ readonly title: string; readonly message: string } | null>(null);
  /** A save had no answer within {@link SAVE_TIMEOUT_MS}, so the page stopped waiting (row 14x). */
  let timedOut = $state(false);
  let confirmingDelete = $state(false);
  let trying = $state(false);
  // Where Try it is drawn: beside the form at desktop width, else a sheet the header opens.
  const sheetViewport = new MediaQuery(TRY_SHEET_QUERY, false);
  const phoneViewport = new MediaQuery(TRY_BOTTOM_SHEET_QUERY, false);
  const tryPlacement = $derived(tryPlacementOf(sheetViewport.current, phoneViewport.current));
  const newAgentSubtitle = $derived(
    tryPlacement === 'beside'
      ? copy.newAgent.subtitle
      : tryPlacement === 'right'
        ? copy.try.subtitleTablet
        : copy.try.subtitlePhone,
  );

  /** A new agent with no copy to fill it: the form that can be built before the catalog has loaded. */
  const freshAgent = agentId === undefined && copiedFrom === null;

  // Leaving a form that differs from what it was built with asks first (rows 42o, 42p).
  const leaveGuard = new LeaveGuard(() => editor?.changed === true);
  $effect(() => leaveGuard.attach());

  // Builds the form once, when everything it is filled from has arrived. A reload builds it again.
  // A catalog with no model builds none, and a provider added since is picked up when the catalog is
  // read again: the form's choices are fixed when it is built. A new agent's form is built without
  // the catalog when it fails to load, and adopts the catalog, keeping what was typed, once a retry
  // reads it (row 42v).
  $effect(() => {
    const catalogData = catalog.data;
    const catalogFailed = catalog.isError;
    const detailData = detail.data;
    const sourceData = source.data;
    const settled = modelContextSettled;
    const context = modelContext(providers.data, policy.data);
    untrack(() => {
      if (!settled) return;
      if (editor?.catalogMissing === true && catalogData !== undefined) {
        // A catalog with no model has nothing to fill the form from: the no-provider state shows.
        editor =
          catalogData.models.length > 0 ? editor.withCatalog(catalogData, context) : undefined;
        return;
      }
      if (editor === undefined && catalogData === undefined && catalogFailed && freshAgent) {
        editor = AgentEditorState.withoutCatalog(context);
        return;
      }
      if (editor !== undefined || catalogData === undefined) return;
      if (catalogData.models.length === 0) return;
      if (agentId === undefined && copiedFrom !== null) {
        const seed = sourceData === undefined ? null : copySeedOf(sourceData);
        if (seed !== null) {
          editor = AgentEditorState.copy(seed, copyIdentifierOf(copiedFrom), catalogData, context);
        }
      } else if (agentId === undefined) {
        editor = AgentEditorState.create(catalogData, context);
      } else if (detailData?.state === 'ready' && detailData.definition !== null) {
        editor = AgentEditorState.edit(detailData, catalogData, context);
      }
    });
  });

  const invalidAgent = $derived(
    detail.data !== undefined && detail.data.state === 'invalid' ? detail.data : undefined,
  );

  const filePath = $derived.by(() => {
    const identifier = invalidAgent?.id ?? editor?.identifier ?? '';
    if (identifier === '') return '';
    const directory = hostPaths.data?.agentDirectory ?? copy.fallbackDirectory;
    return agentFilePath(directory, identifier);
  });

  /** The file's path relative to the Interborough home, which reads the same on every host. */
  const relativePath = $derived(agentRelativePath(invalidAgent?.id ?? editor?.identifier ?? ''));

  /** The agent's name as its file says it now, not as it is being typed. */
  const savedName = $derived(detail.data?.name ?? agentId ?? '');

  // The top bar's trail reads "Agents, Tool runner, Edit" once the agent is read (row 41q).
  usePageLabel(() => ({
    path: agentPath(agentId ?? ''),
    label: agentId === undefined ? undefined : detail.data?.name,
  }));

  const heading = $derived(
    agentId === undefined ? copy.createHeading : copy.editHeading(savedName),
  );

  /** The hash a write names: the one the form was filled from. */
  const currentHash = $derived(editor?.hash ?? detail.data?.hash ?? null);

  /** A file that is gone, or never was: the frame owns that state, so it is asked to look again. */
  function agentIsGone(): void {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.view('agent-editor', agentId ?? null),
    });
  }

  /**
   * Says why a write failed. `serverWords`, given for a save, is what a fault the Bureau did not sort
   * says instead of its own message: the status and that what was typed is still here (row 42w).
   */
  function failWith(fault: AgentFault, title: string, serverWords?: string): void {
    if (fault.kind === 'other' && serverWords !== undefined) {
      failure = { title, message: serverWords };
      return;
    }
    switch (fault.kind) {
      case 'stale':
        stale = true;
        return;
      case 'not-found':
        agentIsGone();
        return;
      case 'identifier-taken':
        // Only a create names an identifier; the field shows the answer.
        editor?.markIdentifierTaken(fault.reason);
        return;
      case 'forbidden':
        failure = { title, message: copy.forbidden };
        return;
      case 'rejected':
      case 'other':
        failure = { title, message: fault.message };
        return;
    }
  }

  function wasWritten(): void {
    void queryClient.invalidateQueries({ queryKey: ['agents'] });
  }

  /** The status a failed save answered with, or `undefined` when the server did not answer. */
  function statusOf(error: unknown): number | undefined {
    return error instanceof HttpClientError ? error.status : undefined;
  }

  // The save in flight: its request, so a save that times out can be stopped, and its clock.
  let saveRequest: AbortController | undefined;
  let saveClock: ReturnType<typeof setTimeout> | undefined;

  function stopSaveClock(): void {
    if (saveClock !== undefined) clearTimeout(saveClock);
    saveClock = undefined;
  }

  /** No answer in time: stop waiting, and say the save could not be confirmed (row 14x). */
  function saveTimedOut(): void {
    saveClock = undefined;
    timedOut = true;
    saveRequest?.abort();
  }

  const save = createMutation(() => ({
    mutationFn: (form: AgentEditorState) => {
      const request = new AbortController();
      saveRequest = request;
      const options = { signal: request.signal };
      return form.mode === 'create'
        ? createAgent(form.identifier, form.toDefinition(), options)
        : updateAgent(form.identifier, form.hash ?? '', form.toDefinition(), options);
    },
    onMutate: () => {
      failure = null;
      timedOut = false;
      stopSaveClock();
      saveClock = setTimeout(saveTimedOut, SAVE_TIMEOUT_MS);
    },
    onSettled: () => stopSaveClock(),
    onSuccess: (result) => {
      // The server answered, so the save is confirmed, even when it answered after the page stopped waiting.
      timedOut = false;
      wasWritten();
      leaveGuard.release();
      router.navigate(agentPath(result.id));
    },
    onError: (error) => {
      // A save the page stopped waiting for already says so; the abort is not a second failure.
      if (timedOut) return;
      failWith(agentFaultOf(error), copy.saveFailed, copy.newAgent.serverError(statusOf(error)));
    },
  }));

  // A page that is left stops waiting for its save.
  onMount(() => () => stopSaveClock());

  const removal = createMutation(() => ({
    mutationFn: (hash: string) => deleteAgent(agentId ?? '', hash),
    onMutate: () => {
      failure = null;
    },
    onSuccess: () => {
      wasWritten();
      leaveGuard.release();
      router.navigate('/agents');
    },
    onError: (error) => failWith(agentFaultOf(error), copy.deleteFailed),
  }));

  /** A save is in flight and the page is still waiting for it: Save shows its loading state. */
  const saving = $derived(save.isPending && !timedOut);
  const busy = $derived(saving || removal.isPending);

  /**
   * The line under the heading of a saved agent (rows 41q, 43k): what a save makes, and, while one
   * is in flight, the version it makes.
   */
  const editSubtitle = $derived(
    saving && latestVersion !== undefined
      ? copy.edit.subtitleSaving(latestVersion.revision + 1)
      : copy.edit.subtitle,
  );

  /** Moves focus to the field with `id`, once the messages a submit shows are on the page. */
  async function focusField(id: string): Promise<void> {
    await tick();
    document.getElementById(id)?.focus();
  }

  /**
   * Save and ⌘Enter (W35): a submit while a save is in flight is ignored. Otherwise the fields that
   * stop a save say why, focus goes to the first of them, and nothing is sent until they are fixed;
   * a model the Bureau will refuse is sent all the same, so its reason shows, and its field is
   * focused (row 43s).
   */
  function submit(): void {
    if (editor === undefined || saving || removal.isPending) return;
    editor.attempt();
    const problem = editor.firstProblem;
    if (editor.canSave) save.mutate(editor);
    if (problem !== undefined) void focusField(problem);
  }

  // ⌘Enter submits from anywhere on the page, a field included (`lib/shortcuts.ts`).
  onMount(() =>
    shortcuts.register({
      keys: ['Enter'],
      modifier: 'mod',
      label: copy.saveAction,
      group: copy.shortcutGroup,
      scope: { route: agentId === undefined ? '/agents/new' : '/agents/:agent/edit' },
      handler: () => submit(),
    }),
  );

  function confirmDelete(): void {
    if (currentHash !== null) removal.mutate(currentHash);
  }

  function cancel(): void {
    router.navigate(
      agentId !== undefined
        ? agentPath(agentId)
        : copiedFrom !== null
          ? agentPath(copiedFrom)
          : '/agents',
    );
  }

  /** Reads the file again and fills the form from it, which discards whatever was typed. */
  async function reload(): Promise<void> {
    const [catalogResult, detailResult, providersResult, policyResult] = await Promise.all([
      catalog.refetch(),
      detail.refetch(),
      providers.refetch(),
      policy.refetch(),
    ]);
    if (detailResult.isError) {
      failWith(agentFaultOf(detailResult.error), copy.loadFailed.title);
      return;
    }
    stale = false;
    failure = null;
    const catalogData = catalogResult.data;
    const detailData = detailResult.data;
    if (catalogData === undefined || detailData === undefined) return;
    // A catalog that has lost its last model offers nothing to fill the form from.
    const context = modelContext(providersResult.data, policyResult.data);
    editor =
      catalogData.models.length > 0 &&
      detailData.state === 'ready' &&
      detailData.definition !== null
        ? AgentEditorState.edit(detailData, catalogData, context)
        : undefined;
  }

  const condition = $derived.by(() => {
    if (stale) return 'stale';
    if (invalidAgent !== undefined) return 'invalid';
    return 'ready';
  });

  // A new agent's form is built without its catalog when that fails (row 42v), so only the other
  // pages count a failed catalog as a page that could not be loaded.
  const loadFailed = $derived(
    (catalog.isError && !freshAgent) || (agentId !== undefined && detail.isError),
  );
  /** The agent to copy could not be read, or is a file with nothing to copy. */
  const copyFailed = $derived(
    copiedFrom !== null &&
      !loadFailed &&
      (source.isError || (source.data !== undefined && copySeedOf(source.data) === null)),
  );
  /** The Bureau answered and offers no model, so no agent could be saved. */
  const noProvider = $derived(
    !loadFailed &&
      !copyFailed &&
      invalidAgent === undefined &&
      editor === undefined &&
      catalog.data !== undefined &&
      catalog.data.models.length === 0,
  );
  const loading = $derived(
    !loadFailed && !copyFailed && !noProvider && editor === undefined && invalidAgent === undefined,
  );

  /**
   * The header holds the delete only for a file the form cannot show, and only once the page knows
   * that is the state it is in: not while the catalog is still being read, and not when it failed.
   */
  const deleteInHeader = $derived(
    currentHash !== null &&
      editor === undefined &&
      !loadFailed &&
      (invalidAgent !== undefined || noProvider),
  );

  /** Reads the catalog and the host's paths again, so a provider added since shows its models. */
  function reloadProviders(): void {
    void catalog.refetch();
    void hostPaths.refetch();
  }
</script>

<div class="weft-agent-editor" data-editor={condition}>
  <PageHeader title={heading} headingLevel={1}>
    {#snippet description()}
      {#if agentId === undefined}
        <span data-testid="agent-new-subtitle">{newAgentSubtitle}</span>
      {:else}
        <span data-testid="agent-edit-subtitle">{editSubtitle}</span>
      {/if}
    {/snippet}
    {#snippet actions()}
      {#if editor !== undefined}
        <!-- Below 1024px Try it is this button beside the title, opening the sheet (rows 43t, 44a). -->
        {#if tryPlacement !== 'beside'}
          <Button variant="secondary" onclick={() => (trying = true)}>
            {copy.try.action}
          </Button>
        {/if}
      {:else if noProvider}
        <!-- Nothing to save without a model, so Save is not here; Cancel stays (row 42a). -->
        <Button variant="secondary" onclick={cancel}>{copy.cancelAction}</Button>
      {/if}
      <!-- With the form on screen, its footer holds the delete; a file the form cannot show keeps it here. -->
      {#if deleteInHeader}
        <Button
          data-changes
          variant="danger"
          disabled={busy}
          onclick={() => (confirmingDelete = true)}
        >
          {copy.deleteAction}
        </Button>
      {/if}
    {/snippet}
  </PageHeader>

  <!-- Drawn once the host has answered, so the line is not replaced when its tooltip arrives. -->
  {#if filePath !== '' && !hostPaths.isPending}
    <!-- The path relative to the home, which is where a person looks; the full one is in the tooltip (row 41r). -->
    <p class="weft-agent-editor__path">
      <span>{hostPaths.data?.mode === 'remote' ? copy.remote.fileLabel : copy.fileLabel}</span>
      {#if hostPaths.data === undefined}
        <CodeLocation
          class="weft-code-location"
          file={relativePath}
          data-testid="agent-file-path"
        />
      {:else}
        <!-- Focusable, so the full path is reachable from the keyboard as well as by hovering. -->
        <Tooltip text={filePath}>
          <CodeLocation
            class="weft-code-location"
            file={relativePath}
            tabindex={0}
            data-testid="agent-file-path"
          />
        </Tooltip>
      {/if}
      <CopyButton
        value={filePath}
        label={copy.newAgent.copyFilePath}
        copiedLabel={copy.newAgent.copiedFilePath}
        iconOnly
      />
    </p>
  {/if}

  {#if stale}
    <Alert variant="warning">
      <p class="weft-agent-editor__alert-title">{copy.stale.title}</p>
      <p class="weft-agent-editor__alert-body">{copy.stale.description}</p>
      <Button variant="secondary" onclick={() => void reload()}>{copy.stale.action}</Button>
    </Alert>
  {/if}

  <!-- Above the form, so above the Name field: what typed is still in the form below (row 42w). -->
  {#if failure !== null}
    <Alert variant="danger" dismissible onDismiss={() => (failure = null)}>
      <p class="weft-agent-editor__alert-title">{failure.title}</p>
      <p class="weft-agent-editor__alert-body">{failure.message}</p>
    </Alert>
  {/if}

  <!-- No answer in time: never "saved", and nothing typed is lost (row 14x). -->
  {#if timedOut}
    <Alert variant="warning" data-testid="agent-save-timed-out">
      <p class="weft-agent-editor__alert-body">{copy.newAgent.timedOut}</p>
      {#snippet actions()}
        <Button variant="secondary" onclick={submit}>{copy.newAgent.tryAgain}</Button>
        <Button variant="ghost" onclick={cancel}>{copy.cancelAction}</Button>
      {/snippet}
    </Alert>
  {/if}

  {#if loadFailed}
    <Alert variant="danger">
      <p class="weft-agent-editor__alert-title">{copy.loadFailed.title}</p>
      <p class="weft-agent-editor__alert-body">{copy.loadFailed.description}</p>
      <Button
        variant="secondary"
        onclick={() => {
          void catalog.refetch();
          void detail.refetch();
        }}>{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if copyFailed}
    <Alert variant="danger">
      <p class="weft-agent-editor__alert-title">{copy.copy.sourceFailed.title}</p>
      <p class="weft-agent-editor__alert-body">{copy.copy.sourceFailed.description}</p>
      <Button variant="secondary" onclick={() => void source.refetch()}>{RETRY_LABEL}</Button>
    </Alert>
  {:else if invalidAgent !== undefined}
    <Alert variant="danger">
      <p class="weft-agent-editor__alert-title">{copy.invalid.title}</p>
      <p class="weft-agent-editor__alert-body">{copy.invalid.description}</p>
      {#if invalidAgent.problem !== null}
        <p class="weft-agent-editor__alert-body" data-testid="agent-problem">
          <code>{invalidAgent.problem.code}</code>: {invalidAgent.problem.message}
        </p>
        {#if invalidAgent.problem.issues !== null}
          <ul class="weft-agent-editor__issues">
            {#each keyedByOccurrence(invalidAgent.problem.issues, (issue) => `${issue.path}:${issue.message}`) as { key, item: issue } (key)}
              <li><code>{issue.path}</code>: {issue.message}</li>
            {/each}
          </ul>
        {/if}
      {/if}
      <Button variant="secondary" onclick={() => void reload()}>{copy.invalid.action}</Button>
    </Alert>
  {:else if noProvider}
    <AgentEditorNoProvider
      paths={hostPaths.data}
      onReload={reloadProviders}
      reloading={catalog.isFetching || hostPaths.isFetching}
    />
  {:else if loading && agentId !== undefined}
    <AgentEditorLoading onCancel={cancel} />
  {:else if loading}
    <div role="status" aria-busy="true" aria-label={heading}>
      <Skeleton height="1.5rem" width="40%" />
      <Skeleton height="12rem" />
    </div>
  {:else if editor !== undefined}
    {#if copiedFrom !== null}
      <p class="weft-agent-editor__copied" data-testid="agent-copied-from">
        {copy.copy.from(source.data?.name ?? copiedFrom)}
      </p>
      {#if editor.droppedTools.length > 0}
        <Alert variant="warning">
          <p class="weft-agent-editor__alert-body" data-testid="agent-copy-dropped">
            {copy.copy.droppedTools(editor.droppedTools)}
          </p>
        </Alert>
      {/if}
    {/if}
    <!-- At desktop width the form and Try it sit side by side; below it Try it is a sheet. -->
    <div class="weft-agent-editor__workspace" data-try={tryPlacement}>
      <div class="weft-agent-editor__form">
        {#key editor}
          <AgentEditorForm
            {editor}
            {busy}
            {saving}
            onSave={submit}
            onCancel={cancel}
            onDelete={() => (confirmingDelete = true)}
            retryingModels={catalog.isFetching}
            onRetryModels={() => void catalog.refetch()}
            savedRevision={latestVersion?.revision}
            {savedName}
            referenceSizes={detail.data?.referenceSizes ?? null}
          />
        {/key}
      </div>
      <!-- One Try it in every placement, so its transcript outlives the sheet (rows 43z, 44b). -->
      <AgentTryDrawer
        {editor}
        bind:open={trying}
        placement={tryPlacement}
        providers={providers.data?.providers}
      />
    </div>
  {/if}
</div>

<ConfirmDialog
  bind:open={confirmingDelete}
  title={copy.deleteDialog.title}
  description={copy.deleteDialog.description(savedName)}
  confirmLabel={copy.deleteDialog.confirm}
  destructive
  onConfirm={confirmDelete}
/>

<!-- Asked before a form that differs from what was saved is left (rows 42o, 42p). -->
<ConfirmDialog
  bind:open={leaveGuard.asking}
  title={copy.newAgent.leave.title}
  description={copy.newAgent.leave.description(editor?.changedParts ?? [])}
  confirmLabel={copy.newAgent.leave.discard}
  cancelLabel={copy.newAgent.leave.keep}
  destructive
  onConfirm={() => leaveGuard.leave()}
/>

<style>
  .weft-agent-editor {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
  }

  /*
   * Beside the form at desktop width, Try it takes what the form's reading width leaves (row 41n,
   * S35) and stays in view while the form scrolls.
   */
  .weft-agent-editor__workspace[data-try='beside'] {
    display: grid;
    grid-template-columns: minmax(0, 48rem) minmax(20rem, 1fr);
    gap: var(--cinder-space-6);
    align-items: start;
  }

  .weft-agent-editor__workspace[data-try='beside'] > :global(.weft-agent-try-panel) {
    position: sticky;
    inset-block-start: 0;
  }

  .weft-agent-editor__form {
    min-inline-size: 0;
  }

  .weft-agent-editor__path {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: baseline;
    margin: 0;
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
    overflow-wrap: anywhere;
  }

  .weft-agent-editor__copied {
    margin: 0;
    color: var(--cinder-text-muted);
  }

  .weft-agent-editor__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .weft-agent-editor__alert-body {
    margin: 4px 0 8px;
  }

  .weft-agent-editor__issues {
    margin: 0 0 8px;
    padding-inline-start: var(--cinder-space-6);
  }
</style>
