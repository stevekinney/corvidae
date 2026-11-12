<script lang="ts">
  /**
   * `/workflows/:workflow/edit` (board PageWorkflowBuilder, "Edit workflow" and its states): the
   * builder over an existing workflow's file, saved through `bureau.workflows.update`. The heading
   * names the workflow by its title, or by its identifier when the file has none, and the ID is a
   * read-only line. The text shows the file's `name`, which is its identifier, and the update does
   * not send it, because the Bureau's update schema rejects a key it does not know.
   *
   * While the draft differs from the file, the page asks `bureau.workflows.impact` what saving it
   * would do (again each time the draft settles, and against each new hash a save names) and says
   * it above the footer while that answer is for the text and the file a save would write: the
   * version it makes, in one line for a compatible change, and for a breaking one what changed and
   * what happens to running work. The footer then reads "Save as version …", and "Saving version …"
   * while it writes. While it writes, the form is read-only, Cancel is off and Save reads Saving. A
   * file the Bureau cannot write shows its words above the footer and keeps everything typed; Save
   * is the retry.
   *
   * Every write names the hash the form is written against: the file's when it was filled. The page
   * reads the file again when the window takes focus, and a write the Bureau refuses as stale reads
   * it too. A file on disk that no longer has that hash is "This file changed on disk." under the
   * tabs, and nothing is written until the person chooses: Reload fills the form from the file, and
   * Keep mine keeps the form and writes against the new hash, over the file. A file that is gone is
   * the view frame's not-found state, so the page asks the frame to look again.
   *
   * A file the Bureau cannot use opens on the JSON tab with where it stops being a workflow above
   * it, so it can be fixed here; one with no hash or no text has nothing to write against, so it has
   * no editor. Text that is not a JSON object is not sent: Save takes the person to the line to fix.
   * While the file loads, the heading and the tabs show at once, skeleton fields after 300 ms, and
   * Save is off. Offline, the page's banner says the edits are kept and Save is off. A save lands
   * on the workflow's page.
   */
  import {
    Alert,
    Banner,
    Button,
    Callout,
    CodeLocation,
    PageHeader,
    Skeleton,
    Tabs,
  } from '@lostgradient/cinder';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { onMount, untrack } from 'svelte';

  import {
    CONNECTION_MAX_ATTEMPTS,
    connectionBannerPreset,
    getConnection,
  } from '../../app/connection.svelte.ts';
  import { RETRY_LABEL } from '../../app/copy/views.ts';
  import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
  import { restartActivity } from '../../app/restart/host-restart-flow.svelte.ts';
  import { agentFaultOf, type AgentFault } from '../../lib/agent-definitions.ts';
  import { getHostPaths, workflowFilePath } from '../../lib/host-paths.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { queryKeys, workflowViewInstance } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { shortcuts } from '../../lib/shortcuts.ts';
  import type { CatalogRow } from '../../lib/workflow-catalog.ts';
  import {
    getWorkflowFile,
    getWorkflowImpact,
    isApplyFailure,
    updateDefinitionFromText,
    updateWorkflowFile,
    type WorkflowFileDetail,
  } from '../../lib/workflow-files.ts';
  import { workflowTypePath } from '../../lib/workflow-type-paths.ts';
  import FileProblem from './file-problem.svelte';
  import WorkflowBuilder from './workflow-builder.svelte';
  import { impactNotice } from './workflow-impact.ts';
  import { locateJsonProblem } from './workflow-source.ts';

  const copy = WORKFLOW_COPY;
  const editor = copy.editor;
  const queryClient = useQueryClient();
  const connection = getConnection();

  // One page belongs to one type: the outlet mounts a new page when the path changes.
  const type = untrack(() => router.current.params['workflow'] ?? '');

  /** How long the draft must stay still before the page asks what saving it would do. */
  const IMPACT_DELAY_MS = 300;

  /**
   * The file is read again when the window takes focus, to see whether it changed on disk; that
   * read never refills the form, which is filled once and again only on Reload.
   */
  const read = createQuery(() => ({
    queryKey: queryKeys.workflowCatalog.file(type),
    queryFn: ({ signal }) => getWorkflowFile(type, { signal }),
    refetchOnWindowFocus: 'always' as const,
    refetchOnReconnect: false,
    gcTime: 0,
    retry: false,
  }));

  const hostPaths = createQuery(() => ({
    queryKey: queryKeys.hostPaths(),
    queryFn: ({ signal }) => getHostPaths({ signal }),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    gcTime: 0,
    retry: false,
  }));

  /** The title the Workflows list already read, so the heading names it before the file arrives. */
  const listedTitle = untrack(
    () =>
      queryClient
        .getQueryData<readonly CatalogRow[]>(queryKeys.workflowCatalog.list())
        ?.find((row) => row.name === type)?.file?.title ?? null,
  );

  /** The file the form was filled from, and its text as typed. */
  let loaded = $state<WorkflowFileDetail>();
  let text = $state('');
  /** The hash a save is written against: the filled file's, or the one on disk after Keep mine. */
  let base = $state<string | null>(null);
  let failure = $state<{ readonly title: string; readonly message: string } | null>(null);
  /** The Bureau saved the file and the engine could not follow, so what is on disk is the save. */
  let unapplied = $state(false);
  /** The builder, which takes the person to the line the JSON stops being JSON on. */
  let builder = $state<{ focusProblem: () => Promise<void> }>();
  /** The tab the loading form shows, before the builder takes over. */
  let loadingTab = $state<'builder' | 'json'>('builder');

  // The page draws the connection banner itself, in the edit form's own words (row 66c).
  $effect(() => connection.claimBanner());

  function fill(file: WorkflowFileDetail): void {
    loaded = file;
    text = file.text ?? '';
    base = file.hash;
  }

  // Fills the form once, when the file has arrived. Reload fills it again.
  $effect(() => {
    const file = read.data;
    untrack(() => {
      if (loaded === undefined && file !== undefined) fill(file);
    });
  });

  const editable = $derived(loaded !== undefined && loaded.hash !== null && loaded.text !== null);
  const filePath = $derived(
    workflowFilePath(hostPaths.data?.workflowDirectory ?? copy.fallbackDirectory, type),
  );

  /** The workflow's name as the heading says it: its title, else its identifier. */
  const name = $derived.by(() => {
    const own = (loaded === undefined ? (listedTitle ?? '') : (loaded.title ?? '')).trim();
    return own === '' ? type : own;
  });

  /**
   * The file on disk no longer has the hash the form writes against: it changed after the form was
   * filled. Nothing is written until Reload or Keep mine.
   */
  const changedOnDisk = $derived(
    loaded !== undefined && read.data !== undefined && read.data.hash !== base,
  );

  /** The draft once it has stayed still for {@link IMPACT_DELAY_MS}. */
  let settled = $state('');
  $effect(() => {
    const next = text;
    // poll-reason: timer
    const timer = setTimeout(() => {
      settled = next;
    }, IMPACT_DELAY_MS);
    return () => clearTimeout(timer);
  });

  /** The settled draft as a definition, when it differs from the file and is a JSON object. */
  const draft = $derived.by(() => {
    if (loaded === undefined || settled === (loaded.text ?? '')) return undefined;
    const parsed = updateDefinitionFromText(settled);
    return parsed.ok ? parsed.definition : undefined;
  });

  /**
   * What saving the draft would do, over the file with the hash a save is written against: Keep
   * mine and every Reload ask again. A draft the Bureau cannot load has no answer, and no notice;
   * nothing is asked while the file on disk is not the one a save writes over.
   */
  const impact = createQuery(() => ({
    queryKey: queryKeys.workflowCatalog.impact(type, base, settled),
    queryFn: ({ signal }) => getWorkflowImpact(type, draft ?? {}, { signal }),
    enabled: editable && draft !== undefined && !changedOnDisk,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    gcTime: 0,
    retry: false,
  }));

  /**
   * The notice, only while the answer is for the draft a save would write: none while the person is
   * still typing (the text has not settled) or while the file changed on disk.
   */
  const saveImpact = $derived(
    draft !== undefined && text === settled && !changedOnDisk && impact.data !== undefined
      ? impactNotice(impact.data)
      : undefined,
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

  /** Reads the file again, which says "This file changed on disk." when its hash moved on. */
  async function lookAgain(): Promise<void> {
    const result = await read.refetch();
    if (result.isError) failWith(agentFaultOf(result.error), copy.loadFailed.title);
  }

  function failWith(fault: AgentFault, title: string): void {
    switch (fault.kind) {
      case 'stale':
        // The file changed after the form was filled: reading it again shows the notice.
        unapplied = false;
        void lookAgain();
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
      failWith(agentFaultOf(error), editor.saveFailed(name));
    },
  }));

  function submit(): void {
    if (base === null || save.isPending || changedOnDisk) return;
    const parsed = updateDefinitionFromText(text);
    if (!parsed.ok) {
      // The JSON tab marks the line to fix, and the footer says it; Save takes the person there.
      void builder?.focusProblem();
      return;
    }
    save.mutate({ expectedHash: base, definition: parsed.definition });
  }

  /**
   * The save reached the file and the engine could not apply it: the file has new text and a new
   * hash, so the form takes both, and a retry names the hash that is there now.
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

  /** Reload: fills the form from the file on disk, which discards whatever was typed. */
  async function reload(): Promise<void> {
    const result = await read.refetch();
    if (result.isError) {
      failWith(agentFaultOf(result.error), copy.loadFailed.title);
      return;
    }
    unapplied = false;
    failure = null;
    if (result.data !== undefined) fill(result.data);
  }

  /** Keep mine: keeps the form, and the next save writes over the file that is on disk now. */
  function keepMine(): void {
    if (read.data !== undefined) base = read.data.hash;
  }

  // ⌘Enter saves from anywhere on the page, a field included (`lib/shortcuts.ts`).
  onMount(() =>
    shortcuts.register({
      keys: ['Enter'],
      modifier: 'mod',
      label: editor.saveAction,
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

  /** What the footer says in place of the read-back: the version a save makes, or is making. */
  const footerStatus = $derived.by((): string | undefined => {
    if (save.isPending) return editor.savingVersion(saveImpact?.version ?? null);
    return saveImpact === undefined ? undefined : editor.saveAs(saveImpact.version);
  });

  /**
   * Where a file the Bureau cannot load stops being a workflow: "line 12 expected a comma" for JSON
   * missing a comma, else the Bureau's own words.
   */
  const invalidReason = $derived.by((): string | undefined => {
    if (loaded === undefined || loaded.state !== 'invalid') return undefined;
    const located = locateJsonProblem(loaded.text ?? '');
    if (located !== null && located.kind === 'comma') {
      return editor.invalid.atLine(located.stoppedAt, editor.invalid.expectedComma);
    }
    return (loaded.problem?.message ?? '').replace(/\.$/, '');
  });

  const condition = $derived.by(() => {
    if (loaded === undefined) return 'loading';
    if (changedOnDisk) return 'stale';
    if (unapplied) return 'unapplied';
    if (loaded.state === 'invalid') return 'invalid';
    return 'ready';
  });
</script>

{#snippet changedNotice()}
  <Callout variant="warning" semantic="note" data-testid="workflow-editor-changed">
    <p class="weft-workflow-editor__notice-text">{editor.changedOnDisk.title}</p>
    {#snippet action()}
      <Button variant="secondary" size="sm" onclick={() => void reload()}
        >{editor.changedOnDisk.reload}</Button
      >
      <Button variant="ghost" size="sm" onclick={keepMine}>{editor.changedOnDisk.keepMine}</Button>
    {/snippet}
  </Callout>
{/snippet}

{#snippet impactSnippet()}
  {#if saveImpact !== undefined}
    <Callout variant={saveImpact.tone} semantic="note" data-testid="workflow-editor-impact">
      <p class="weft-workflow-editor__notice-lead">{saveImpact.lead}</p>
      {#if saveImpact.details.length > 0}
        <p class="weft-workflow-editor__notice-text">{saveImpact.details.join(' ')}</p>
      {/if}
    </Callout>
  {/if}
{/snippet}

<div class="weft-workflow-editor" data-page="workflow-editor" data-condition={condition}>
  {#if connection.unreachable && !restartActivity.active}
    <!-- While the host restarts, the restart dialog is the one account of it. -->
    <Banner
      preset={connectionBannerPreset(connection)}
      consequence={connection.browserOffline
        ? editor.offlineConsequence
        : editor.unreachableConsequence}
      retryInSeconds={connection.retryInSeconds}
      attempt={connection.browserOffline || connection.attempt === 0
        ? undefined
        : connection.attempt}
      maxAttempts={CONNECTION_MAX_ATTEMPTS}
      onRetry={() => void connection.retryNow()}
    />
  {/if}

  <PageHeader title={editor.heading(name)} headingLevel={1} />
  <p class="weft-workflow-editor__path">
    <span>{hostPaths.data?.mode === 'remote' ? copy.remote.fileLabel : copy.fileLabel}</span>
    <CodeLocation class="weft-code-location" file={filePath} data-testid="workflow-file-path" />
  </p>

  {#if unapplied}
    <Alert variant="warning">
      <p class="weft-workflow-editor__alert-title">{copy.applyFailed.title}</p>
      <p class="weft-workflow-editor__alert-body">{copy.applyFailed.description}</p>
    </Alert>
  {/if}

  {#if read.isError && loaded === undefined}
    <Alert variant="danger">
      <p class="weft-workflow-editor__alert-title">{copy.loadFailed.title}</p>
      <p class="weft-workflow-editor__alert-body">{copy.loadFailed.description}</p>
      <Button variant="secondary" onclick={() => void read.refetch()}>{RETRY_LABEL}</Button>
    </Alert>
  {:else if loaded === undefined}
    <!-- The heading and the tabs show at once; the fields after 300 ms; Save is off (row 65u). -->
    <Tabs bind:value={loadingTab}>
      <Tabs.List label={copy.builder.tabsLabel}>
        <Tabs.Trigger value="builder">{copy.builder.builderTab}</Tabs.Trigger>
        <Tabs.Trigger value="json">{copy.builder.jsonTab}</Tabs.Trigger>
      </Tabs.List>
      {#each ['builder', 'json'] as panel (panel)}
        <Tabs.Panel value={panel}>
          <Skeleton
            variant="form"
            rows={4}
            delay={300}
            stillLoadingAfter={10_000}
            stillLoadingLabel={editor.stillLoading(name)}
            onCancel={cancel}
            label={editor.heading(name)}
          />
        </Tabs.Panel>
      {/each}
    </Tabs>
    <footer class="weft-workflow-editor__footer">
      <Button variant="secondary" size="sm" onclick={cancel}>{editor.cancelAction}</Button>
      <Button variant="primary" size="sm" disabled>{editor.saveAction}</Button>
    </footer>
  {:else}
    {#if loaded.state === 'invalid' && editable && invalidReason !== undefined}
      <!-- A file that can't load opens on the JSON tab, where it is fixed (row 66e). -->
      <Alert variant="danger">
        <p data-testid="workflow-problem">
          {editor.invalid.sentence(`${type}.json`, invalidReason)}
          {editor.invalid.fix}
        </p>
        {#if loaded.problem !== null && loaded.problem.issues !== null && loaded.problem.issues.length > 0}
          <ul class="weft-workflow-editor__issues" data-testid="workflow-issues">
            {#each keyedByOccurrence(loaded.problem.issues, (issue) => `${issue.path}:${issue.message}`) as { key, item: issue } (key)}
              <li><code>{issue.path}</code>: {issue.message}</li>
            {/each}
          </ul>
        {/if}
      </Alert>
    {:else if !editable}
      <Alert variant="danger">
        <p class="weft-workflow-editor__alert-title">{editor.unreadable.title}</p>
        <p class="weft-workflow-editor__alert-body">{editor.unreadable.description}</p>
        {#if loaded.problem !== null}
          <FileProblem problem={loaded.problem} />
        {/if}
        <Button variant="secondary" onclick={() => void reload()}
          >{editor.changedOnDisk.reload}</Button
        >
      </Alert>
      {#if failure !== null}
        <!-- With no builder, there is no footer to say a failed Reload above. -->
        <Alert variant="danger">
          <p class="weft-workflow-editor__alert-title">{failure.title}</p>
          <p class="weft-workflow-editor__alert-body">{failure.message}</p>
        </Alert>
      {/if}
    {/if}
    {#if editable}
      <form class="weft-workflow-editor__form" onsubmit={(event) => event.preventDefault()}>
        <WorkflowBuilder
          bind:this={builder}
          {text}
          mode="edit"
          error=""
          saving={save.isPending}
          {failure}
          initialTab={loaded.state === 'invalid' ? 'json' : loadingTab}
          jsonId="workflow-editor-text"
          jsonLabel={editor.textLabel}
          jsonDescription={editor.textDescription}
          backHref={workflowTypePath(type)}
          {...footerStatus === undefined ? {} : { status: footerStatus }}
          {...changedOnDisk ? { notice: changedNotice } : {}}
          {...saveImpact === undefined ? {} : { aboveFooter: impactSnippet }}
          onTextChange={(next) => {
            text = next;
          }}
        >
          {#snippet actions()}
            <Button variant="secondary" size="sm" disabled={save.isPending} onclick={cancel}
              >{editor.cancelAction}</Button
            >
            <Button
              data-changes
              type="button"
              onclick={() => submit()}
              variant="primary"
              size="sm"
              disabled={save.isPending}
              >{save.isPending ? editor.savingAction : editor.saveAction}</Button
            >
          {/snippet}
        </WorkflowBuilder>
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

  .weft-workflow-editor__footer {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    justify-content: flex-end;
    padding-top: var(--cinder-space-3);
    border-top: 1px solid var(--cinder-border);
  }

  .weft-workflow-editor__alert-title,
  .weft-workflow-editor__notice-lead {
    margin: 0;
    font-weight: 600;
  }

  .weft-workflow-editor__alert-body {
    margin: 4px 0 8px;
  }

  .weft-workflow-editor__notice-text {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .weft-workflow-editor__issues {
    margin: 4px 0 0;
    padding-inline-start: var(--cinder-space-6);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }
</style>
