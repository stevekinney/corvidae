<script lang="ts">
  /**
   * The Access tab of an agent's page: which tools the agent may call and when each asks you first
   * (never, on changes, always, blocked), the skills the host found (read-only, with whether their
   * source is trusted), the plugin guardrails it runs besides the default ones, and its spend and
   * tool budgets. It saves the lot as one write that names the hash of the file the page read, so
   * a file that changed since is refused instead of overwritten, and the page says so with a reload.
   *
   * A chat's permission mode only tightens what is set here. An agent defined in code has no file
   * to write, so it shows the tools it states for itself and says the rest cannot be changed.
   */
  import {
    Alert,
    Badge,
    Button,
    EmptyState,
    Input,
    SectionHeading,
    Skeleton,
    Textarea,
  } from '@lostgradient/cinder';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { AGENT_EDITOR_COPY, AGENT_PAGE_COPY, RETRY_LABEL } from '../../app/copy.ts';
  import {
    agentFaultOf,
    getAgentCatalog,
    updateAgent,
    type AgentDetail,
    type AgentFault,
  } from '../../lib/agent-definitions.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { AgentAccessState } from './agent-access-state.svelte.ts';
  import AgentAccessSkills from './agent-access-skills.svelte';
  import AgentAccessToolRow from './agent-access-tool-row.svelte';

  interface Props {
    /** The agent's identifier. */
    id: string;
    /** The agent as the Bureau shows it, once read. */
    detail: AgentDetail | undefined;
    failed: boolean;
    onRetry: () => void;
  }

  let { id, detail, failed, onRetry }: Props = $props();

  const copy = AGENT_PAGE_COPY.access;
  const limits = AGENT_EDITOR_COPY.limits;
  const queryClient = useQueryClient();

  const catalog = createQuery(
    () => ({
      queryKey: queryKeys.agents.catalog(),
      queryFn: ({ signal }) => getAgentCatalog({ signal }),
      retry: false,
    }),
    undefined,
  );

  // The form is rebuilt from the file when the file's hash changes: after a save, which reads the
  // new hash back, and after a stale write is reloaded. A refetch that returns the same file keeps
  // what the person has typed.
  let form = $state<AgentAccessState | undefined>();
  $effect(() => {
    const loaded = detail;
    const offered = catalog.data;
    if (loaded === undefined || offered === undefined) return;
    untrack(() => {
      if (form === undefined || form.hash !== loaded.hash) {
        form = AgentAccessState.from(loaded, offered);
      }
    });
  });
  const isFile = $derived(detail?.source === 'file');
  const builtInTools = $derived(detail?.codeDefinition?.tools ?? []);

  let problem = $state<string | null>(null);

  function refuse(fault: AgentFault): void {
    switch (fault.kind) {
      case 'stale':
        problem = copy.stale;
        void queryClient.invalidateQueries({ queryKey: queryKeys.agents.definition(id) });
        return;
      case 'forbidden':
        problem = copy.forbidden;
        return;
      case 'rejected':
      case 'other':
        problem = fault.message;
        return;
      case 'not-found':
      case 'identifier-taken':
        problem = copy.saveFailed;
        return;
    }
  }

  const save = createMutation(() => ({
    mutationFn: (state: AgentAccessState) => updateAgent(id, state.hash, state.toDefinition()),
    onMutate: () => {
      problem = null;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.definition(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.definitions() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.versions(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.revisions(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list() });
    },
    onError: (error) => refuse(agentFaultOf(error)),
  }));

  function submit(event: SubmitEvent, state: AgentAccessState): void {
    event.preventDefault();
    if (state.canSave && !save.isPending) save.mutate(state);
  }
</script>

{#snippet editor(state: AgentAccessState)}
  <form
    class="ib-agent-access__form"
    aria-label={copy.heading}
    onsubmit={(event) => submit(event, state)}
  >
    <section class="ib-agent-section" aria-label={copy.toolsHeading}>
      <SectionHeading level={2} title={copy.toolsHeading} description={copy.toolsDescription}>
        {#snippet actions()}
          <span class="ib-agent-note" data-testid="agent-access-count"
            >{copy.toolCount(state.allowedCount, state.offeredCount)}</span
          >
        {/snippet}
      </SectionHeading>
      {#if state.rows.length === 0}
        <EmptyState
          kind="first-use"
          size="compact"
          headingLevel={3}
          title={copy.noToolsTitle}
          description={copy.noToolsDescription}
        />
      {:else}
        <ul class="ib-access-list" aria-label={copy.toolsListLabel}>
          {#each state.rows as tool (tool.name)}
            <AgentAccessToolRow
              {tool}
              allowed={state.isAllowed(tool.name)}
              approval={state.approvalOf(tool.name)}
              onAllow={(next) => state.setAllowed(tool.name, next)}
              onApproval={(next) => state.setApproval(tool.name, next)}
            />
          {/each}
        </ul>
      {/if}
    </section>

    <AgentAccessSkills />

    <section class="ib-agent-section" aria-label={copy.guardrailsHeading}>
      <SectionHeading
        level={2}
        title={copy.guardrailsHeading}
        description={copy.guardrailsDescription}
      />
      <Textarea
        id="access-guardrails"
        label={limits.guardrailsLabel}
        description={limits.guardrailsDescription}
        rows={2}
        error={state.limitErrors.guardrails ?? ''}
        bind:value={state.guardrails}
      />
    </section>

    <section class="ib-agent-section" aria-label={copy.budgetsHeading}>
      <SectionHeading level={2} title={copy.budgetsHeading} description={copy.budgetsDescription} />
      <div class="ib-access-budgets">
        <Input
          id="access-spend-per-run"
          label={limits.spendPerRunLabel}
          description={limits.spendPerRunDescription}
          inputmode="decimal"
          error={state.limitErrors.spendPerRun ?? ''}
          bind:value={state.spendPerRun}
        />
        <Input
          id="access-spend-per-chat"
          label={limits.spendPerChatLabel}
          description={limits.spendPerChatDescription}
          inputmode="decimal"
          error={state.limitErrors.spendPerChat ?? ''}
          bind:value={state.spendPerChat}
        />
        <Input
          id="access-tool-calls"
          label={limits.toolCallsLabel}
          description={limits.toolCallsDescription}
          inputmode="numeric"
          error={state.limitErrors.toolCalls ?? ''}
          bind:value={state.toolCalls}
        />
        <Input
          id="access-tool-seconds"
          label={limits.toolSecondsLabel}
          description={limits.toolSecondsDescription}
          inputmode="decimal"
          error={state.limitErrors.toolSeconds ?? ''}
          bind:value={state.toolSeconds}
        />
      </div>
    </section>

    <div class="ib-agent-access__actions">
      <Button
        data-changes
        type="submit"
        variant="primary"
        disabled={!state.canSave || save.isPending}>{copy.saveAction}</Button
      >
    </div>
  </form>
{/snippet}

<div class="ib-agent-access" data-testid="agent-access">
  {#if failed || catalog.isError}
    <Alert variant="danger">
      <p>{copy.loadFailed}</p>
      <Button
        variant="secondary"
        size="sm"
        onclick={() => {
          onRetry();
          void catalog.refetch();
        }}>{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if isFile && detail?.definition === null}
    <Alert variant="warning">
      <p>{copy.invalid}</p>
    </Alert>
  {:else if detail === undefined || (isFile && form === undefined)}
    <div role="status" aria-busy="true" aria-label={copy.heading}>
      <Skeleton height="8rem" />
    </div>
  {:else if !isFile}
    <section class="ib-agent-section" aria-label={copy.heading}>
      <SectionHeading level={2} title={copy.toolsHeading} />
      <p class="ib-agent-note" data-testid="agent-built-in">{copy.builtIn}</p>
      {#if builtInTools.length === 0}
        <EmptyState
          kind="first-use"
          size="compact"
          headingLevel={3}
          title={copy.noToolsTitle}
          description={copy.noToolsDescription}
        />
      {:else}
        <ul class="ib-agent-chips" aria-label={copy.toolsListLabel}>
          {#each keyedByOccurrence(builtInTools, (tool) => tool) as { key, item: tool } (key)}
            <li><Badge variant="neutral" size="sm" monospace>{tool}</Badge></li>
          {/each}
        </ul>
      {/if}
    </section>
    <AgentAccessSkills />
  {:else if form !== undefined}
    {#if problem !== null}
      <Alert variant="danger" dismissible onDismiss={() => (problem = null)}>
        <p>{problem}</p>
      </Alert>
    {/if}
    {@render editor(form)}
  {/if}
</div>
