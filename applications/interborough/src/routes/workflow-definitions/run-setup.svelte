<script lang="ts">
  /**
   * `/workflows/:workflow/run`: set up one run of the workflow in the path. The workflow is fixed
   * by the address and never chosen again here; the title names it, then Input and When are two
   * plain sections, and a footer holds the summary, Cancel and the primary action
   * (`run-setup-form.svelte`).
   *
   * The heading comes from the route at once, and the form stands in every state: a skeleton while
   * the workflow is read, the Input section's own error block when it cannot be, and the form once
   * it can. What stops a run is detected on load, not at submit, and said in an alert above Input
   * while Start run is off with the reason beside it: a paused file (with Resume), a file the
   * Bureau cannot read (with Open Code), and a step whose agent needs a model while no provider is
   * connected. Once the form shows, it stays: a reload that finds the workflow paused must not
   * discard what was typed. Only the types the Bureau starts itself have nothing to set up here.
   */
  import { Alert, Button, EmptyState, PageHeader } from '@lostgradient/cinder';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { Ban } from '@lucide/svelte';
  import { untrack } from 'svelte';

  import { usePageLabel } from '../../app/breadcrumbs.svelte.ts';
  import { WORKFLOW_COPY } from '../../app/copy.ts';
  import { readScheduleAttention } from '../../lib/bureau-attention.ts';
  import { getClient } from '../../lib/client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { resolveWorkflow } from '../../lib/workflow-catalog.ts';
  import { resumeWorkflowFile } from '../../lib/workflow-files.ts';
  import { workflowRunSetupPath, workflowTypePath } from '../../lib/workflow-type-paths.ts';
  import { loadModelAgents } from '../schedules/schedule-row-context.ts';
  import {
    agentNames,
    runSetupIdentity,
    runSetupTarget,
    runSetupTrigger,
    stepAgentsOf,
    type RunSetupTarget,
    type StartBlock,
  } from './run-setup-model.ts';
  import RunSetupForm from './run-setup-form.svelte';
  import { locateJsonProblem, problemSentence } from './workflow-source.ts';

  const copy = WORKFLOW_COPY.runSetup;
  const client = getClient();
  const queryClient = useQueryClient();

  /** Settings › Models, where a provider is connected. */
  const MODELS_PATH = '/settings/models';

  // One page belongs to one type: the outlet mounts a new page when the path changes.
  const type = untrack(() => router.current.params['workflow'] ?? '');
  const workflowPath = workflowTypePath(type);
  /** The workflow's Code tab, which marks the line a file that cannot load stops on. */
  const codePath = `${workflowPath}?tab=code`;

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

  /** The form once it has shown, ready or paused, which a later answer does not take away. */
  let shown = $state<Extract<RunSetupTarget, { status: 'ready' | 'paused' }>>();
  $effect(() => {
    const next = target;
    if (untrack(() => shown) !== undefined) return;
    if (next?.status === 'ready' || next?.status === 'paused') shown = next;
  });

  /** The file the Bureau holds for the type, or `undefined` for a type code registered. */
  const file = $derived(
    resolution.data?.kind === 'agent-authored' ? resolution.data.file : undefined,
  );

  /** What the heading calls the workflow, which the route supplies at once and the file's title replaces. */
  const identity = $derived(runSetupIdentity(type, resolution.data ?? undefined));
  const trigger = $derived(runSetupTrigger(resolution.data ?? undefined));
  /** The When choice, which the form holds and the heading and the breadcrumb follow. */
  let whenChoice = $state('now');
  const scheduling = $derived(target?.status !== 'engine' && whenChoice === 'schedule');
  // The trail reads "Workflows › Release notes › Run", and "› Schedule" while On a schedule is chosen.
  usePageLabel(() => ({
    path: workflowPath,
    label: resolution.data === undefined || resolution.data === null ? undefined : identity.name,
  }));
  usePageLabel(() => ({
    path: workflowRunSetupPath(type),
    label: scheduling ? copy.scheduleCrumb : undefined,
  }));

  /**
   * A file the Bureau cannot read, as the alert at the top says it: the file's name, then the line
   * the problem is on when the page can place it and what is wrong there.
   */
  const unreadable = $derived.by(() => {
    if (file === undefined || file.state !== 'invalid') return undefined;
    const fileName = `${type}.json`;
    if (file.problem === null) return { fileName, rest: '.' };
    const located =
      file.problem.code === 'invalid-json' && file.text !== null
        ? locateJsonProblem(file.text)
        : null;
    // The sentence opens with the file's name, which the alert draws in monospace on its own.
    return {
      fileName,
      rest: problemSentence(fileName, file.problem, located).slice(fileName.length),
    };
  });

  /** The agents the file's steps run, for whether one needs a model while no provider is connected. */
  const agents = $derived(file?.state === 'ready' ? stepAgentsOf(file.steps) : []);
  /**
   * The named agents that need a model while no provider is connected (the builder's read, so one
   * answers the other). A read that fails says nothing: a run is never said to be blocked on a guess.
   */
  const providerless = createQuery(() => ({
    queryKey: queryKeys.workflows.builderBlockedAgents(agents),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const [attention, models] = await Promise.all([
        readScheduleAttention({ signal }),
        loadModelAgents(agents, { signal }),
      ]);
      return attention.noProvider ? [...models] : [];
    },
    enabled: agents.length > 0,
    retry: false,
  }));
  const blockedAgents = $derived(agents.length === 0 ? [] : (providerless.data ?? []));

  /** What the Input section holds: the form once it has shown, or why there is none yet. */
  const inputMode = $derived.by((): 'ready' | 'loading' | 'failed' | 'unreadable' => {
    if (shown !== undefined) return 'ready';
    if (target?.status === 'invalid') return 'unreadable';
    return resolution.isError ? 'failed' : 'loading';
  });
  /** Why Start run is off, which the form says beside it. */
  const block = $derived.by((): StartBlock | undefined => {
    if (inputMode === 'loading') return 'loading';
    if (inputMode === 'failed') return 'unloaded';
    if (target?.status === 'invalid') return 'invalid';
    // A paused file refuses a start, but a schedule of its own is the owner's choice
    // (`scheduleTargetOf`), so Create schedule stays on.
    if (target?.status === 'paused' && !scheduling) return 'paused';
    if (blockedAgents.length > 0) return 'provider';
    return undefined;
  });

  /** Resumes a paused file; the read is asked again, and the alert and the reason go with it. */
  const resume = createMutation(() => ({
    mutationFn: (hash: string) => resumeWorkflowFile(type, hash),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflowCatalog.detail(type) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflowCatalog.list() });
    },
  }));

  function resumeFile(): void {
    const hash = file?.hash;
    if (hash === null || hash === undefined || resume.isPending) return;
    resume.mutate(hash);
  }

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
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

{#snippet notice()}
  {#if unreadable !== undefined}
    <!-- Red, because a file that can't load is a failure. -->
    <Alert variant="danger" data-testid="run-setup-unreadable">
      <code>{unreadable.fileName}</code>{unreadable.rest}
      {copy.unreadableStartOff}
      {#snippet actions()}
        <Button
          variant="secondary"
          size="sm"
          href={router.href(codePath)}
          onclick={(event: MouseEvent) => go(event, codePath)}>{copy.openCode}</Button
        >
      {/snippet}
    </Alert>
  {:else if target?.status === 'paused'}
    <!-- Not amber: amber is for waiting on you and Needs attention. -->
    <Alert variant="info" data-testid="run-setup-paused">
      {copy.paused(identity.name)}
      {#snippet actions()}
        <Button
          data-changes
          variant="secondary"
          size="sm"
          disabled={resume.isPending || file?.hash === null || file?.hash === undefined}
          onclick={resumeFile}>{copy.resumeAction}</Button
        >
      {/snippet}
    </Alert>
  {/if}
  {#if blockedAgents.length > 0}
    <Alert variant="warning" data-testid="run-setup-no-provider">
      {copy.noProvider(agentNames(blockedAgents))}
      {#snippet actions()}
        <Button
          variant="secondary"
          size="sm"
          href={router.href(MODELS_PATH)}
          onclick={(event: MouseEvent) => go(event, MODELS_PATH)}>{copy.connectProvider}</Button
        >
      {/snippet}
    </Alert>
  {/if}
{/snippet}

<article class="ib-run-setup" data-page="run-setup">
  <PageHeader
    headingLevel={1}
    title={headingText}
    titleText={`${scheduling ? copy.scheduleVerb : copy.runVerb} ${identity.name}`}
    {...identity.description === null ? {} : { description: identity.description }}
  />

  {#if target?.status === 'engine'}
    <EmptyState
      kind="first-use"
      title={copy.blocked.engineTitle}
      description={copy.blocked.engineDescription}
      headingLevel={2}
    >
      {#snippet icon()}<Ban size={24} aria-hidden="true" />{/snippet}
      {#snippet action()}
        <Button
          variant="secondary"
          href={router.href(workflowPath)}
          onclick={(event: MouseEvent) => go(event, workflowPath)}
          >{copy.blocked.openWorkflow}</Button
        >
      {/snippet}
    </EmptyState>
  {:else if resolution.data !== null}
    <!-- A type nothing knows of is the frame's not-found state, so nothing is drawn for it here. -->
    <RunSetupForm
      {type}
      kind={shown?.kind}
      schema={shown?.schema}
      input={inputMode}
      {block}
      {identity}
      {trigger}
      {notice}
      onRetry={() => void resolution.refetch()}
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
</style>
