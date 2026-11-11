<script lang="ts">
  /**
   * `/runs/new`, step one of starting a run: choose the workflow to run, then go to its run setup
   * page (`/workflows/:workflow/run`), where its input and the time are set. The picker starts
   * nothing itself. Its one field lists the workflows a person built (`runnable-workflows.ts`),
   * those that are paused or cannot load shown off with their reason, and says so when there are
   * none, with a way to make one. Continue with nothing picked stays enabled: it focuses the field
   * and says what is missing under it.
   */
  import { Alert, Button, EmptyState, PageHeader, Select, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';
  import { GitBranch } from '@lucide/svelte';

  import { RETRY_LABEL, WORKFLOW_COPY } from '../../../app/copy.ts';
  import { getClient } from '../../../lib/client.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import { CATALOG_STALE_TIME_MS, loadCatalog } from '../../../lib/workflow-catalog.ts';
  import { workflowNewPath, workflowRunSetupPath } from '../../../lib/workflow-type-paths.ts';
  import { startChoices } from './runnable-workflows.ts';

  const FIELD_ID = 'run-picker-workflow';

  const copy = WORKFLOW_COPY.runPicker;
  const client = getClient();

  const catalog = createQuery(() => ({
    queryKey: queryKeys.workflowCatalog.list(),
    queryFn: ({ signal }) => loadCatalog(client, { signal }),
    staleTime: CATALOG_STALE_TIME_MS,
    // A failure is said at once, with Try again, as the frame's own probe of this list does.
    retry: false,
  }));

  let chosen = $state('');
  let error = $state<string | undefined>(undefined);
  const choices = $derived(catalog.data === undefined ? [] : startChoices(catalog.data));
  const options = $derived([
    { value: '', label: copy.fieldPlaceholder },
    ...choices.map((choice) => ({
      value: choice.name,
      label:
        choice.reason === null
          ? choice.name
          : `${choice.name} (${choice.reason === 'paused' ? copy.pausedReason : copy.invalidReason})`,
      disabled: choice.reason !== null,
    })),
  ]);

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }

  /** Goes to the chosen workflow's setup page, or focuses the field and says what is missing. */
  function proceed(): void {
    if (chosen === '') {
      error = copy.pickError;
      document.getElementById(FIELD_ID)?.focus();
      return;
    }
    router.navigate(workflowRunSetupPath(chosen));
  }
</script>

<article class="ib-run-picker" data-page="run-picker">
  <PageHeader headingLevel={1} title={copy.title} description={copy.description} />

  {#if catalog.isError}
    <Alert variant="danger">
      <p class="ib-run-picker__alert-title">{copy.loadFailedTitle}</p>
      <p class="ib-run-picker__alert-message">{copy.loadFailedDescription}</p>
      <Button variant="secondary" size="sm" onclick={() => void catalog.refetch()}
        >{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if catalog.isPending}
    <div role="status" aria-busy="true" aria-label={copy.title}>
      <Skeleton height="4rem" />
    </div>
  {:else if choices.length === 0}
    <EmptyState
      kind="first-use"
      title={copy.emptyTitle}
      description={copy.emptyDescription}
      headingLevel={2}
    >
      {#snippet icon()}<GitBranch size={24} aria-hidden="true" />{/snippet}
      {#snippet action()}
        <Button
          variant="primary"
          href={router.href(workflowNewPath())}
          onclick={(event) => go(event, workflowNewPath())}>{copy.emptyAction}</Button
        >
      {/snippet}
    </EmptyState>
  {:else}
    <div class="ib-run-picker__field">
      <Select
        id={FIELD_ID}
        label={copy.fieldLabel}
        required
        {options}
        {error}
        bind:value={chosen}
        onValueChange={() => (error = undefined)}
      />
    </div>
    <div class="ib-run-picker__actions">
      <Button
        variant="secondary"
        href={router.href('/runs')}
        onclick={(event) => go(event, '/runs')}>{copy.cancel}</Button
      >
      <Button variant="primary" onclick={proceed}>{copy.continue}</Button>
    </div>
  {/if}
</article>

<style>
  .ib-run-picker {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-6);
    min-width: 0;
  }

  .ib-run-picker__field {
    max-inline-size: 24rem;
  }

  .ib-run-picker__actions {
    display: flex;
    gap: var(--cinder-space-2);
  }

  .ib-run-picker__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .ib-run-picker__alert-message {
    margin: var(--cinder-space-1) 0 var(--cinder-space-2);
  }
</style>
