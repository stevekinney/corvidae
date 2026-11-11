<script lang="ts">
  /**
   * `/workflows/:workflow/run`: set up one run of the workflow in the path. The workflow is fixed
   * by the address and never chosen again here; the title names it, then Input and When are two
   * plain sections, and a footer holds the summary, Cancel and the primary action
   * (`run-setup-form.svelte`).
   *
   * A workflow that cannot be run from here says why and points back at the workflow: the types the
   * Bureau starts itself, and a file that is invalid or paused. Once the form shows, it stays: a
   * reload that finds the workflow paused must not discard what was typed, and the Bureau refuses
   * the start in its own words if it is.
   */
  import { Alert, Button, EmptyState, PageHeader, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';
  import { Ban } from '@lucide/svelte';
  import { untrack } from 'svelte';

  import { usePageLabel } from '../../app/breadcrumbs.svelte.ts';
  import { RETRY_LABEL, WORKFLOW_COPY } from '../../app/copy.ts';
  import { getClient } from '../../lib/client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { resolveWorkflow } from '../../lib/workflow-catalog.ts';
  import { workflowRunSetupPath, workflowTypePath } from '../../lib/workflow-type-paths.ts';
  import {
    runSetupIdentity,
    runSetupTarget,
    runSetupTrigger,
    type RunSetupTarget,
  } from './run-setup-model.ts';
  import RunSetupForm from './run-setup-form.svelte';

  const copy = WORKFLOW_COPY.runSetup;
  const client = getClient();

  // One page belongs to one type: the outlet mounts a new page when the path changes.
  const type = untrack(() => router.current.params['workflow'] ?? '');
  const workflowPath = workflowTypePath(type);

  // The same read as the workflow's own page, so one answers the other from the cache.
  const resolution = createQuery(
    () => ({
      queryKey: queryKeys.workflowCatalog.detail(type),
      queryFn: async ({ signal }) => (await resolveWorkflow(client, type, { signal })) ?? null,
    }),
    undefined,
  );

  const target = $derived(
    resolution.data === undefined || resolution.data === null
      ? undefined
      : runSetupTarget(type, resolution.data),
  );

  /** The form once it has shown, which a later answer does not take away. */
  let shown = $state<Extract<RunSetupTarget, { status: 'ready' }>>();
  $effect(() => {
    const next = target;
    if (untrack(() => shown) === undefined && next?.status === 'ready') shown = next;
  });
  const current = $derived(shown ?? target);

  /** What the heading calls the workflow, which the route supplies at once and the file's title replaces. */
  const identity = $derived(runSetupIdentity(type, resolution.data ?? undefined));
  const trigger = $derived(runSetupTrigger(resolution.data ?? undefined));
  /** The When choice, which the form holds and the heading and the breadcrumb follow. */
  let whenChoice = $state('now');
  const scheduling = $derived(current?.status === 'ready' && whenChoice === 'schedule');
  // The trail reads "Workflows › Release notes › Run", and "› Schedule" while On a schedule is chosen.
  usePageLabel(() => ({
    path: workflowPath,
    label: resolution.data === undefined || resolution.data === null ? undefined : identity.name,
  }));
  usePageLabel(() => ({
    path: workflowRunSetupPath(type),
    label: scheduling ? copy.scheduleCrumb : undefined,
  }));

  const blocked = $derived(
    current === undefined || current.status === 'ready'
      ? undefined
      : (
          {
            engine: {
              title: copy.blocked.engineTitle,
              description: copy.blocked.engineDescription,
            },
            invalid: {
              title: copy.blocked.invalidTitle,
              description: copy.blocked.invalidDescription,
            },
            paused: {
              title: copy.blocked.pausedTitle,
              description: copy.blocked.pausedDescription,
            },
          } as const
        )[current.status],
  );

  function openWorkflow(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(workflowPath);
  }
</script>

{#snippet headingText()}
  {scheduling
    ? copy.scheduleVerb
    : copy.runVerb}{' '}{#if identity.titled}{identity.name}{' '}{/if}<code
    class="ib-identifier"
    data-testid="run-setup-identifier">{type}</code
  >
{/snippet}

<article class="ib-run-setup" data-page="run-setup">
  <PageHeader
    headingLevel={1}
    title={headingText}
    titleText={`${scheduling ? copy.scheduleVerb : copy.runVerb} ${identity.name}`}
    {...identity.description === null ? {} : { description: identity.description }}
  />

  {#if resolution.isError && current === undefined}
    <Alert variant="danger">
      <p class="ib-run-setup__alert-title">{copy.loadFailed.title}</p>
      <p class="ib-run-setup__alert-message">{copy.loadFailed.description}</p>
      <Button variant="secondary" size="sm" onclick={() => void resolution.refetch()}
        >{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if current === undefined}
    <div role="status" aria-busy="true" aria-label={copy.title(type)}>
      <Skeleton height="12rem" />
    </div>
  {:else if blocked !== undefined}
    <EmptyState
      kind="first-use"
      title={blocked.title}
      description={blocked.description}
      headingLevel={2}
    >
      {#snippet icon()}<Ban size={24} aria-hidden="true" />{/snippet}
      {#snippet action()}
        <Button variant="secondary" href={router.href(workflowPath)} onclick={openWorkflow}
          >{copy.blocked.openWorkflow}</Button
        >
      {/snippet}
    </EmptyState>
  {:else if current.status === 'ready'}
    <RunSetupForm
      {type}
      kind={current.kind}
      schema={current.schema}
      {identity}
      {trigger}
      bind:whenChoice
    />
  {/if}
</article>

<style>
  .ib-run-setup {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-6);
    min-width: 0;
  }

  .ib-run-setup__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .ib-run-setup__alert-message {
    margin: var(--cinder-space-1) 0 var(--cinder-space-2);
  }
</style>
