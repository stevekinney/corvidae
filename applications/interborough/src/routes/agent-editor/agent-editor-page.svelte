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
   * One Save sits in the header and submits the form by its id; ⌘Enter does the same from anywhere
   * on the page. There is no draft and nothing to publish: under the heading, an agent that exists
   * says when it was last saved and links to its versions, on the Settings tab of its page.
   *
   * What the form offers comes from `bureau.agents.catalog` and nothing else, and the A2A
   * switch is saved with the rest of the definition. A catalog with no model offers
   * nothing a save could use, so the page shows where to configure a provider instead of the form.
   */
  import { onMount, untrack } from 'svelte';

  import {
    Alert,
    Button,
    CodeLocation,
    ConfirmDialog,
    PageHeader,
    RelativeTime,
    Skeleton,
  } from '@lostgradient/cinder';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { AGENT_EDITOR_COPY, RETRY_LABEL } from '../../app/copy.ts';
  import {
    agentFaultOf,
    createAgent,
    deleteAgent,
    getAgentCatalog,
    getAgentDefinition,
    listAgentVersions,
    updateAgent,
    type AgentFault,
  } from '../../lib/agent-definitions.ts';
  import { agentPath } from '../../lib/agent-paths.ts';
  import { shortcuts } from '../../lib/shortcuts.ts';
  import { agentFilePath, getHostPaths } from '../../lib/host-paths.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { AgentEditorState } from './agent-editor-state.svelte.ts';
  import AgentEditorForm from './agent-editor-form.svelte';
  import { AGENT_EDITOR_FORM_ID } from './agent-editor-form-id.ts';
  import AgentEditorNoProvider from './agent-editor-no-provider.svelte';
  import AgentRevisionHistory from './agent-revision-history.svelte';

  interface Props {
    /** The identifier of the agent to edit; absent on `/agents/new`. */
    id?: string | undefined;
  }

  let { id }: Props = $props();

  const copy = AGENT_EDITOR_COPY;
  const queryClient = useQueryClient();

  // One page belongs to one agent: the outlet mounts a new page when the path changes.
  const agentId = untrack(() => id);

  // What the page reads once and then holds. A background refetch must not replace a form the
  // person is typing in, so nothing here refetches on its own and the form is built once.
  const stable = {
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    gcTime: 0,
    retry: false,
  } as const;

  const catalog = createQuery(() => ({
    ...stable,
    queryKey: queryKeys.agents.catalog(),
    queryFn: ({ signal }) => getAgentCatalog({ signal }),
  }));

  const detail = createQuery(() => ({
    ...stable,
    queryKey: queryKeys.agents.definition(agentId ?? ''),
    queryFn: ({ signal }) => getAgentDefinition(agentId ?? '', { signal }),
    enabled: agentId !== undefined,
  }));

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
  const versionsPath = $derived(`${agentPath(agentId ?? '')}?tab=settings`);

  let editor = $state<AgentEditorState>();
  /** A write was refused because the file changed on disk after the form was filled. */
  let stale = $state(false);
  /** A write failed for a reason the person can act on, in the Bureau's words. */
  let failure = $state<{ readonly title: string; readonly message: string } | null>(null);
  let confirmingDelete = $state(false);

  // Builds the form once, when everything it is filled from has arrived. A reload builds it again.
  // A catalog with no model builds none, and a provider added since is picked up when the catalog is
  // read again: the form's choices are fixed when it is built.
  $effect(() => {
    const catalogData = catalog.data;
    const detailData = detail.data;
    untrack(() => {
      if (editor !== undefined || catalogData === undefined) return;
      if (catalogData.models.length === 0) return;
      if (agentId === undefined) {
        editor = AgentEditorState.create(catalogData);
      } else if (detailData?.state === 'ready' && detailData.definition !== null) {
        editor = AgentEditorState.edit(detailData, catalogData);
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

  /** The agent's name as its file says it now, not as it is being typed. */
  const savedName = $derived(detail.data?.name ?? agentId ?? '');

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

  function failWith(fault: AgentFault, title: string): void {
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

  const save = createMutation(() => ({
    mutationFn: (form: AgentEditorState) =>
      form.mode === 'create'
        ? createAgent(form.identifier, form.toDefinition())
        : updateAgent(form.identifier, form.hash ?? '', form.toDefinition()),
    onMutate: () => {
      failure = null;
    },
    onSuccess: (result) => {
      wasWritten();
      router.navigate(agentPath(result.id));
    },
    onError: (error) => failWith(agentFaultOf(error), copy.saveFailed),
  }));

  const removal = createMutation(() => ({
    mutationFn: (hash: string) => deleteAgent(agentId ?? '', hash),
    onMutate: () => {
      failure = null;
    },
    onSuccess: () => {
      wasWritten();
      router.navigate('/agents');
    },
    onError: (error) => failWith(agentFaultOf(error), copy.deleteFailed),
  }));

  const busy = $derived(save.isPending || removal.isPending);

  function submit(): void {
    if (editor !== undefined) save.mutate(editor);
  }

  // ⌘Enter saves from anywhere on the page, a field included (`lib/shortcuts.ts`).
  onMount(() =>
    shortcuts.register({
      keys: ['Enter'],
      modifier: 'mod',
      label: copy.saveAction,
      group: copy.shortcutGroup,
      scope: { route: agentId === undefined ? '/agents/new' : '/agents/:agent/edit' },
      handler: () => {
        if (editor?.canSave === true && !busy) submit();
      },
    }),
  );

  /** Follows the link to the versions in the app's router, unless the click asks for a new tab. */
  function openVersions(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(versionsPath);
  }

  function confirmDelete(): void {
    if (currentHash !== null) removal.mutate(currentHash);
  }

  function cancel(): void {
    router.navigate(agentId === undefined ? '/agents' : agentPath(agentId));
  }

  /** Reads the file again and fills the form from it, which discards whatever was typed. */
  async function reload(): Promise<void> {
    const [catalogResult, detailResult] = await Promise.all([catalog.refetch(), detail.refetch()]);
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
    editor =
      catalogData.models.length > 0 &&
      detailData.state === 'ready' &&
      detailData.definition !== null
        ? AgentEditorState.edit(detailData, catalogData)
        : undefined;
  }

  const condition = $derived.by(() => {
    if (stale) return 'stale';
    if (invalidAgent !== undefined) return 'invalid';
    return 'ready';
  });

  const loadFailed = $derived(catalog.isError || (agentId !== undefined && detail.isError));
  /** The Bureau answered and offers no model, so no agent could be saved. */
  const noProvider = $derived(
    !loadFailed &&
      invalidAgent === undefined &&
      editor === undefined &&
      catalog.data !== undefined &&
      catalog.data.models.length === 0,
  );
  const loading = $derived(
    !loadFailed && !noProvider && editor === undefined && invalidAgent === undefined,
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
      {#if latestVersion !== undefined}
        <span data-testid="agent-saved">
          {copy.saved}
          <RelativeTime date={latestVersion.savedAt} />
          ·
          <a href={router.href(versionsPath)} onclick={openVersions}
            >{copy.version(latestVersion.revision)}</a
          >
        </span>
      {/if}
    {/snippet}
    {#snippet actions()}
      {#if editor !== undefined}
        <Button
          data-changes
          type="submit"
          form={AGENT_EDITOR_FORM_ID}
          variant="primary"
          disabled={!editor.canSave || busy}
        >
          {editor.mode === 'create' ? copy.createAction : copy.saveAction}
        </Button>
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

  {#if filePath !== ''}
    <p class="weft-agent-editor__path">
      <span>{hostPaths.data?.mode === 'remote' ? copy.remote.fileLabel : copy.fileLabel}</span>
      <CodeLocation class="weft-code-location" file={filePath} data-testid="agent-file-path" />
    </p>
  {/if}

  {#if stale}
    <Alert variant="warning">
      <p class="weft-agent-editor__alert-title">{copy.stale.title}</p>
      <p class="weft-agent-editor__alert-body">{copy.stale.description}</p>
      <Button variant="secondary" onclick={() => void reload()}>{copy.stale.action}</Button>
    </Alert>
  {/if}

  {#if failure !== null}
    <Alert variant="danger" dismissible onDismiss={() => (failure = null)}>
      <p class="weft-agent-editor__alert-title">{failure.title}</p>
      <p class="weft-agent-editor__alert-body">{failure.message}</p>
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
  {:else if loading}
    <div role="status" aria-busy="true" aria-label={heading}>
      <Skeleton height="1.5rem" width="40%" />
      <Skeleton height="12rem" />
    </div>
  {:else if editor !== undefined}
    {#key editor}
      <AgentEditorForm
        {editor}
        {busy}
        onSave={submit}
        onCancel={cancel}
        onDelete={() => (confirmingDelete = true)}
      />
    {/key}
  {/if}

  {#if agentId !== undefined && !loadFailed}
    <div class="weft-agent-editor__history">
      <AgentRevisionHistory id={agentId} />
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

<style>
  .weft-agent-editor {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
  }

  /*
   * The form's footer reaches down through the outlet's bottom padding (`--cinder-space-6`) so it
   * can sit on the outlet's edge. What follows the form starts that far lower, which leaves the
   * page's own gap between the footer and the history instead of the history under the footer.
   */
  .weft-agent-editor__history {
    margin-block-start: var(--cinder-space-6);
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
