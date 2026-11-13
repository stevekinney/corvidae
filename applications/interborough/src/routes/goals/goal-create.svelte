<script lang="ts">
  /**
   * `/goals/new`: the page that creates a goal (COR-2017, rows 68b to 68s). A goal runs an agent on a
   * prompt until its check passes, so the form asks for the prompt, the check, the agent (chosen from
   * the agents the Bureau lists, Assistant to begin with, which needs no provider) and the most
   * attempts it may make (`goal-form.svelte`; `goal-form-state.svelte.ts` says what the Bureau is
   * sent). A goal that is made takes the person to its own page.
   *
   * Start again opens this page with `?from=<goal>`: the goal is read and its agent, check and
   * attempt limit fill the form, with its name as the first line of the prompt (the goal's view
   * never carries more of the prompt). A goal that cannot be read opens the form empty.
   *
   * The Bureau decides whether the check exists: one it lacks is `Unprocessable`, which the page
   * says above the buttons, keeping what was typed. A goal the Bureau committed but could not start
   * a controller for stays pending until recovery, so the page stays to say so. It is read-only from
   * then on, because a second submit repeats the idempotency key, comes back `existing`, and would
   * leave as if the goal had started.
   */
  import { Button, EmptyState, PageHeader, Skeleton } from '@lostgradient/cinder';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { tick, untrack } from 'svelte';

  import { AGENT_EDITOR_COPY } from '../../app/copy/agents.ts';
  import { GOALS_COPY } from '../../app/copy/goals.ts';
  import { listAgents } from '../../lib/bureau-client.ts';
  import { createGoal, getGoal, type GoalCreated } from '../../lib/bureau-goals.ts';
  import { getProviders } from '../../lib/host-providers.ts';
  import { goalPath } from '../../lib/identifier-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { createFailure } from './goal-form-failure.ts';
  import {
    defaultAgentName,
    GOAL_FIELD_IDS,
    GoalFormState,
    needsProvider,
    scriptedAgent,
    type GoalField,
  } from './goal-form-state.svelte.ts';
  import GoalForm from './goal-form.svelte';

  const copy = GOALS_COPY.form;
  const LIST_PATH = '/goals';
  /** How long a read is let to finish before its placeholders are drawn (Cinder's loading rule). */
  const LOADING_DELAY_MILLISECONDS = 300;
  const queryClient = useQueryClient();
  const form = new GoalFormState('create');

  /** The agents a goal may run. A goal can only run one the Bureau lists, so the field is a picker. */
  const agentsQuery = createQuery(
    () => ({
      queryKey: queryKeys.agents.list(),
      queryFn: ({ signal }) => listAgents({ signal }),
      retry: false,
    }),
    undefined,
  );
  const agents = $derived(agentsQuery.data);

  /** Whether a provider holds a key, once the host has said. */
  const providers = createQuery(
    () => ({
      queryKey: queryKeys.hostProviders(),
      queryFn: ({ signal }) => getProviders({ signal }),
      retry: false,
    }),
    undefined,
  );
  const providerConnected = $derived(
    providers.data === undefined
      ? undefined
      : providers.data.providers.some((provider) => provider.connected),
  );

  const scripted = $derived.by(() => {
    const found = scriptedAgent(agents ?? []);
    return found === undefined ? undefined : { name: found.name, label: found.displayName };
  });

  // Start again names the goal it opens from, which is read once and fills the form.
  const from = $derived(router.search.get('from') ?? '');
  const source = createQuery(
    () => ({
      queryKey: queryKeys.goals.detail(from),
      queryFn: ({ signal }: { signal: AbortSignal }) => getGoal(from, { signal }),
      enabled: from !== '',
      retry: false,
    }),
    undefined,
  );
  const reading = $derived(from !== '' && source.isPending);

  let prefilled = false;
  // Before the form is drawn, so it never shows empty and then fills.
  $effect.pre(() => {
    const found = source.data;
    if (found === undefined || prefilled) return;
    prefilled = true;
    untrack(() => form.prefill(found));
  });
  // A new goal starts with the agent that needs no provider, unless Start again chose one.
  $effect.pre(() => {
    const listed = agents;
    if (listed === undefined || reading) return;
    untrack(() => {
      if (form.agentName === '') form.agentName = defaultAgentName(listed);
    });
  });

  /** The goal the Bureau committed but could not start a controller for. */
  let notStarted = $state<GoalCreated>();

  const creation = createMutation(() => ({
    mutationFn: () => createGoal(form.toInput()),
    // The fault is said on the page, beside what was typed, so it is not also a toast.
    onError: () => undefined,
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.goals.list() });
      if (created.controller?.status === 'start-failed') {
        notStarted = created;
        return;
      }
      router.navigate(goalPath(created.goal.goalRunId));
    },
  }));

  const failure = $derived(creation.error === null ? undefined : createFailure(creation.error));
  const submitting = $derived(creation.isPending);
  const cancelPath = $derived(
    notStarted === undefined ? LIST_PATH : goalPath(notStarted.goal.goalRunId),
  );

  /** Moves focus to the field, once the messages a submit shows are on the page. */
  async function focusField(field: GoalField): Promise<void> {
    await tick();
    document.getElementById(GOAL_FIELD_IDS[field])?.focus();
  }

  /**
   * Create goal stays live whatever the form holds, apart from a model agent with no provider: a
   * submit that finds a problem says it at the field and focuses the first, and sends nothing.
   */
  function submit(): void {
    if (submitting || notStarted !== undefined) return;
    if (needsProvider(agents, form.agentName, providerConnected)) return;
    const problem = form.attempt();
    if (problem !== undefined) {
      void focusField(problem);
      return;
    }
    creation.mutate();
  }

  function leave(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

{#if reading}
  <section class="ib-goal-form-loading" aria-label={copy.title} data-page="goal-new">
    <PageHeader title={copy.title} headingLevel={1} description={copy.description} />
    <Skeleton variant="form" rows={4} label={copy.loading} delay={LOADING_DELAY_MILLISECONDS} />
  </section>
{:else if agentsQuery.isSuccess && agents?.length === 0}
  <section class="ib-goal-form-loading" aria-label={copy.title} data-page="goal-new">
    <PageHeader title={copy.title} headingLevel={1} description={copy.description} />
    <EmptyState
      kind="first-use"
      title={copy.noAgents.title}
      description={copy.noAgents.description}
      headingLevel={2}
    >
      {#snippet action()}
        <Button
          href={router.href('/agents/new')}
          variant="primary"
          size="sm"
          onclick={(event) => leave(event, '/agents/new')}>{AGENT_EDITOR_COPY.newAction}</Button
        >
      {/snippet}
    </EmptyState>
  </section>
{:else}
  <GoalForm
    {form}
    mode="create"
    {agents}
    agentsFailed={agentsQuery.isError}
    {providerConnected}
    {scripted}
    busy={submitting}
    {notStarted}
    {failure}
    {cancelPath}
    onSubmit={submit}
    onUseAgent={(name) => (form.agentName = name)}
  />
{/if}

<style>
  .ib-goal-form-loading {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
  }
</style>
