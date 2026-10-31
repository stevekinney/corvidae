<script lang="ts">
  /**
   * `/workflows/:workflow/edit`: an agent-authored workflow's file as JSON, in Cinder's editor, saved
   * through `bureau.workflows.update`. The text shows the file's `name`, which is its identifier,
   * and the update does not send it, because the Bureau's update schema rejects a key it does not
   * know. Text that is not JSON, and a document the Bureau refuses, show the error and save nothing.
   *
   * A write names the hash the page read, so a file that changed on disk since is refused instead of
   * overwritten: the page says the workflow changed outside Interborough, with a reload that
   * discards unsaved edits. A file that is gone is the view frame's not-found state, so the page
   * asks the frame to look again. A file the Bureau cannot use opens in the editor with its problem
   * above it, so it can be fixed here; one with no hash has nothing to write against, so it has no
   * editor. A save lands on the workflow's page.
   */
  import { Alert, Button, CodeLocation, Skeleton } from '@lostgradient/cinder';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { onMount, untrack } from 'svelte';

  import { RETRY_LABEL, WORKFLOW_COPY } from '../../app/copy.ts';
  import { agentFaultOf, type AgentFault } from '../../lib/agent-definitions.ts';
  import { getHostPaths, workflowFilePath } from '../../lib/host-paths.ts';
  import { queryKeys, workflowViewInstance } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { shortcuts } from '../../lib/shortcuts.ts';
  import { workflowTypePath } from '../../lib/workflow-type-paths.ts';
  import {
    getWorkflowFile,
    isApplyFailure,
    updateDefinitionFromText,
    updateWorkflowFile,
    type WorkflowFileDetail,
  } from '../../lib/workflow-files.ts';
  import FileProblem from './file-problem.svelte';
  import WorkflowBuilder from './workflow-builder.svelte';

  const copy = WORKFLOW_COPY;
  const queryClient = useQueryClient();

  // One page belongs to one type: the outlet mounts a new page when the path changes.
  const type = untrack(() => router.current.params['workflow'] ?? '');

  // What the page reads once and then holds. A background refetch must not replace text the person
  // is typing, so nothing here refetches on its own and the editor is filled once.
  const stable = {
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    gcTime: 0,
    retry: false,
  } as const;

  const read = createQuery(() => ({
    ...stable,
    queryKey: queryKeys.workflowCatalog.file(type),
    queryFn: ({ signal }) => getWorkflowFile(type, { signal }),
  }));

  const hostPaths = createQuery(() => ({
    ...stable,
    queryKey: queryKeys.hostPaths(),
    queryFn: ({ signal }) => getHostPaths({ signal }),
  }));

  /** The file the editor was filled from, and its text as typed. */
  let loaded = $state<WorkflowFileDetail>();
  let text = $state('');
  /** A write was refused because the file changed on disk after the editor was filled. */
  let stale = $state(false);
  /** Why the text cannot be saved, or the Bureau's words for a document it refused. */
  let validation = $state('');
  let failure = $state<{ readonly title: string; readonly message: string } | null>(null);
  /** The Bureau saved the file and the engine could not follow, so what is on disk is the save. */
  let unapplied = $state(false);

  function fill(file: WorkflowFileDetail): void {
    loaded = file;
    text = file.text ?? '';
    validation = '';
  }

  // Fills the editor once, when the file has arrived. A reload fills it again.
  $effect(() => {
    const file = read.data;
    untrack(() => {
      if (loaded === undefined && file !== undefined) fill(file);
    });
  });

  const hash = $derived(loaded?.hash ?? null);
  const editable = $derived(loaded !== undefined && hash !== null && loaded.text !== null);
  const filePath = $derived(
    workflowFilePath(hostPaths.data?.workflowDirectory ?? copy.fallbackDirectory, type),
  );

  /** A file that is gone: the frame owns that state, so it is asked to look again. */
  function workflowIsGone(): void {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.view(
        'workflows',
        workflowViewInstance('/workflows/:workflow/edit', type),
      ),
    });
  }

  function failWith(fault: AgentFault, title: string): void {
    switch (fault.kind) {
      case 'stale':
        // The editor's picture of the file is out of date, so what it said about it no longer holds.
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

  const save = createMutation(() => ({
    mutationFn: ({
      expectedHash,
      definition,
    }: {
      expectedHash: string;
      definition: Record<string, unknown>;
    }) => updateWorkflowFile(type, expectedHash, definition),
    onMutate: () => {
      failure = null;
    },
    onSuccess: () => {
      unapplied = false;
      void queryClient.invalidateQueries({ queryKey: ['workflow-catalog'] });
      router.navigate(workflowTypePath(type));
    },
    onError: (error) => {
      if (isApplyFailure(error)) {
        void adoptWhatIsOnDisk();
        return;
      }
      failWith(agentFaultOf(error), copy.editor.saveFailed);
    },
  }));

  function submit(event?: SubmitEvent): void {
    event?.preventDefault();
    if (hash === null || save.isPending) return;
    const parsed = updateDefinitionFromText(text);
    if (!parsed.ok) {
      validation = parsed.reason === 'not-json' ? copy.editor.notJson : copy.editor.notObject;
      return;
    }
    validation = '';
    save.mutate({ expectedHash: hash, definition: parsed.definition });
  }

  /**
   * The save reached the file and the engine could not apply it: the file has new text and a new
   * hash, so the editor takes both, and a retry names the hash that is there now.
   */
  async function adoptWhatIsOnDisk(): Promise<void> {
    void queryClient.invalidateQueries({ queryKey: queryKeys.workflowCatalog.list() });
    const result = await read.refetch();
    if (result.isError) {
      failWith(agentFaultOf(result.error), copy.loadFailed.title);
      return;
    }
    if (result.data !== undefined) fill(result.data);
    unapplied = true;
  }

  /** Reads the file again and fills the editor from it, which discards whatever was typed. */
  async function reload(): Promise<void> {
    const result = await read.refetch();
    if (result.isError) {
      failWith(agentFaultOf(result.error), copy.loadFailed.title);
      return;
    }
    stale = false;
    unapplied = false;
    failure = null;
    if (result.data !== undefined) fill(result.data);
  }

  // ⌘Enter saves from anywhere on the page, a field included (`lib/shortcuts.ts`).
  onMount(() =>
    shortcuts.register({
      keys: ['Enter'],
      modifier: 'mod',
      label: copy.editor.saveAction,
      group: copy.builder.shortcutGroup,
      scope: { route: '/workflows/:workflow/edit' },
      handler: () => {
        if (editable) submit();
      },
    }),
  );

  function cancel(): void {
    router.navigate(workflowTypePath(type));
  }

  const condition = $derived.by(() => {
    if (stale) return 'stale';
    if (unapplied) return 'unapplied';
    if (loaded?.state === 'invalid') return 'invalid';
    return 'ready';
  });
</script>

<div class="weft-workflow-editor" data-page="workflow-editor" data-condition={condition}>
  <h1 class="weft-workflow-editor__title">{copy.editor.heading(type)}</h1>
  <p class="weft-workflow-editor__path">
    <span>{hostPaths.data?.mode === 'remote' ? copy.remote.fileLabel : copy.fileLabel}</span>
    <CodeLocation class="weft-code-location" file={filePath} data-testid="workflow-file-path" />
  </p>

  {#if stale}
    <Alert variant="warning">
      <p class="weft-workflow-editor__alert-title">{copy.stale.title}</p>
      <p class="weft-workflow-editor__alert-body">{copy.stale.description}</p>
      <Button variant="secondary" onclick={() => void reload()}>{copy.stale.action}</Button>
    </Alert>
  {/if}

  {#if unapplied}
    <Alert variant="warning">
      <p class="weft-workflow-editor__alert-title">{copy.applyFailed.title}</p>
      <p class="weft-workflow-editor__alert-body">{copy.applyFailed.description}</p>
    </Alert>
  {/if}

  {#if failure !== null}
    <Alert variant="danger" dismissible onDismiss={() => (failure = null)}>
      <p class="weft-workflow-editor__alert-title">{failure.title}</p>
      <p class="weft-workflow-editor__alert-body">{failure.message}</p>
    </Alert>
  {/if}

  {#if read.isError}
    <Alert variant="danger">
      <p class="weft-workflow-editor__alert-title">{copy.loadFailed.title}</p>
      <p class="weft-workflow-editor__alert-body">{copy.loadFailed.description}</p>
      <Button variant="secondary" onclick={() => void read.refetch()}>{RETRY_LABEL}</Button>
    </Alert>
  {:else if loaded === undefined}
    <div role="status" aria-busy="true" aria-label={copy.editor.heading(type)}>
      <Skeleton height="1.5rem" width="40%" />
      <Skeleton height="12rem" />
    </div>
  {:else}
    {#if loaded.state === 'invalid'}
      <Alert variant="danger">
        <p class="weft-workflow-editor__alert-title">
          {editable ? copy.editor.invalid.title : copy.editor.unreadable.title}
        </p>
        <p class="weft-workflow-editor__alert-body">
          {editable ? copy.editor.invalid.description : copy.editor.unreadable.description}
        </p>
        {#if loaded.problem !== null}
          <FileProblem problem={loaded.problem} />
        {/if}
        <Button variant="secondary" onclick={() => void reload()}
          >{copy.editor.invalid.action}</Button
        >
      </Alert>
    {/if}
    {#if editable}
      <form class="weft-workflow-editor__form" onsubmit={submit}>
        <WorkflowBuilder
          {text}
          mode="edit"
          error={validation}
          jsonId="workflow-editor-text"
          jsonLabel={copy.editor.textLabel}
          jsonDescription={copy.editor.textDescription}
          onTextChange={(next) => {
            text = next;
            validation = '';
          }}
        />
        <div class="weft-workflow-editor__actions">
          <Button data-changes type="submit" variant="primary" disabled={save.isPending}
            >{copy.editor.saveAction}</Button
          >
          <Button variant="secondary" disabled={save.isPending} onclick={cancel}
            >{copy.editor.cancelAction}</Button
          >
        </div>
      </form>
    {/if}
  {/if}
</div>

<style>
  .weft-workflow-editor {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .weft-workflow-editor__title {
    margin: 0;
    font-size: var(--cinder-text-xl);
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .weft-workflow-editor__path {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: baseline;
    margin: 0;
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-muted);
    overflow-wrap: anywhere;
  }

  .weft-workflow-editor__form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .weft-workflow-editor__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .weft-workflow-editor__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .weft-workflow-editor__alert-body {
    margin: 4px 0 8px;
  }
</style>
