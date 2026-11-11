<script lang="ts">
  /**
   * `/goals/:goal/edit`: the page that changes a goal (COR-2017, rows 68o and 68p). It is New goal
   * with the goal's own agent, check and attempt limit in the fields (`goal-form.svelte`), the
   * heading "Edit goal", and a Save that starts no attempt (`bureau.goals.update`). The change
   * applies to attempts the goal has not yet made; an attempt already made keeps the check it ran
   * against. Edit is offered on every goal's page, and a goal that has ended or been asked to stop is
   * refused by the Bureau, which the page says above the buttons.
   *
   * The goal's view never carries its prompt, so the prompt starts empty and an empty prompt keeps
   * the one the goal has. Save names only what changed, against the revision the form was opened on:
   * a goal that moved since is refused and nothing is written. A save with nothing changed sends
   * nothing and goes back to the goal.
   *
   * The form is built once from the goal as it was first read and is not built again when a refetch
   * brings a newer one, so a refetch never discards what was typed.
   */
  import { ErrorState, PageHeader, Skeleton } from '@lostgradient/cinder';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { tick, untrack } from 'svelte';

  import { usePageLabel } from '../../app/breadcrumbs.svelte.ts';
  import { GOALS_COPY, RETRY_LABEL } from '../../app/copy.ts';
  import { listAgents } from '../../lib/bureau-client.ts';
  import { getGoal, updateGoal, type GoalChange } from '../../lib/bureau-goals.ts';
  import { goalPath } from '../../lib/identifier-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { saveFailure } from './goal-form-failure.ts';
  import { GOAL_FIELD_IDS, GoalFormState, type GoalField } from './goal-form-state.svelte.ts';
  import GoalForm from './goal-form.svelte';

  const copy = GOALS_COPY.form;
  /** How long a read is let to finish before its placeholders are drawn (Cinder's loading rule). */
  const LOADING_DELAY_MILLISECONDS = 300;
  const queryClient = useQueryClient();
  const form = new GoalFormState('edit');

  const goalRunId = $derived(router.current.params['goal'] ?? '');
  const goal = createQuery(
    () => ({
      queryKey: queryKeys.goals.detail(goalRunId),
      queryFn: ({ signal }: { signal: AbortSignal }) => getGoal(goalRunId, { signal }),
      retry: false,
    }),
    undefined,
  );
  const agentsQuery = createQuery(
    () => ({
      queryKey: queryKeys.agents.list(),
      queryFn: ({ signal }) => listAgents({ signal }),
      retry: false,
    }),
    undefined,
  );

  const name = $derived.by(() => {
    const found = goal.data;
    if (found === undefined) return undefined;
    const trimmed = found.identity.name.trim();
    return trimmed === '' ? found.goalRunId : trimmed;
  });
  // The crumb between Goals and Edit is the goal's name.
  usePageLabel(() => ({ path: goalPath(goalRunId), label: name }));

  /** The revision the form was opened on, which a save is made against. */
  let openedRevision: number | undefined;
  // Before the form is drawn, so it never shows empty and then fills.
  $effect.pre(() => {
    const found = goal.data;
    if (found === undefined || openedRevision !== undefined) return;
    openedRevision = found.revision;
    untrack(() => form.prefill(found));
  });

  const saving = createMutation(() => ({
    mutationFn: (request: { readonly revision: number; readonly change: GoalChange }) =>
      updateGoal(goalRunId, request.revision, request.change),
    // The fault is said on the page, beside what was typed, so it is not also a toast.
    onError: () => undefined,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.goals.list() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.goals.detail(goalRunId) });
      router.navigate(goalPath(goalRunId));
    },
  }));

  const failure = $derived(saving.error === null ? undefined : saveFailure(saving.error));
  const busy = $derived(saving.isPending);

  /** Moves focus to the field, once the messages a submit shows are on the page. */
  async function focusField(field: GoalField): Promise<void> {
    await tick();
    document.getElementById(GOAL_FIELD_IDS[field])?.focus();
  }

  /** Save stays live whatever the form holds: a problem is said at its field, and nothing is sent. */
  function submit(): void {
    if (busy || openedRevision === undefined) return;
    const problem = form.attempt();
    if (problem !== undefined) {
      void focusField(problem);
      return;
    }
    // What is sent is read once, before anything is awaited.
    const change = form.toChange();
    if (Object.keys(change).length === 0) {
      router.navigate(goalPath(goalRunId));
      return;
    }
    saving.mutate({ revision: openedRevision, change });
  }
</script>

{#if goal.data !== undefined}
  <GoalForm
    {form}
    mode="edit"
    agents={agentsQuery.data}
    agentsFailed={agentsQuery.isError}
    providerConnected={undefined}
    scripted={undefined}
    {busy}
    {failure}
    cancelPath={goalPath(goalRunId)}
    onSubmit={submit}
    onUseAgent={() => undefined}
  />
{:else}
  <section class="ib-goal-form-loading" aria-label={copy.edit.title} data-page="goal-edit">
    <PageHeader
      title={copy.edit.title}
      headingLevel={1}
      description={copy.edit.description}
      error={goal.isError}
    />
    {#if goal.isError}
      <ErrorState
        bordered
        headingLevel={2}
        title={GOALS_COPY.detail.loadFailed.title}
        description={GOALS_COPY.detail.loadFailed.description}
        retryLabel={RETRY_LABEL}
        onRetry={() => void goal.refetch()}
      />
    {:else}
      <Skeleton variant="form" rows={4} label={copy.loading} delay={LOADING_DELAY_MILLISECONDS} />
    {/if}
  </section>
{/if}

<style>
  .ib-goal-form-loading {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
  }
</style>
