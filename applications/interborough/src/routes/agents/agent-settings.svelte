<script lang="ts">
  /**
   * The Settings tab of an agent's page: the model and the models a chat may switch to, the step
   * limit, Delete, and the saved versions with Restore. It shows what the agent's file says;
   * changing it is the editor's job. Guardrails, spend and tool limits, and tool approvals are on
   * the Access tab. An agent defined in code
   * has no file, so it shows its model and says the rest cannot be changed here, with no Delete and
   * no versions.
   *
   * Delete and Restore name the hash of the file the page read, so a file that changed since is
   * refused instead of overwritten, and the page says so with a reload.
   */
  import {
    Alert,
    Badge,
    Button,
    ConfirmDialog,
    SectionHeading,
    Skeleton,
  } from '@lostgradient/cinder';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';

  import { AGENT_PAGE_COPY, RETRY_LABEL } from '../../app/copy.ts';
  import {
    agentFaultOf,
    deleteAgent,
    type AgentDetail,
    type AgentFault,
  } from '../../lib/agent-definitions.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { pluginOfAgent } from '../../lib/agent-paths.ts';
  import AgentPluginNote from './agent-plugin-note.svelte';
  import AgentVersions from './agent-versions.svelte';
  import { settingsOf } from './agent-settings.ts';

  interface Props {
    /** The agent's identifier. */
    id: string;
    /** The agent as the Bureau shows it, once read. */
    detail: AgentDetail | undefined;
    failed: boolean;
    onRetry: () => void;
  }

  let { id, detail, failed, onRetry }: Props = $props();

  const copy = AGENT_PAGE_COPY.settings;
  const queryClient = useQueryClient();

  const plugin = $derived(pluginOfAgent(id));
  const isFile = $derived(detail?.source === 'file');
  /** A plugin's agent is a file the owner cannot write: no Delete, no saved versions. */
  const writable = $derived(isFile && plugin === null);
  const hash = $derived(detail?.hash ?? null);
  const settings = $derived(detail === undefined ? undefined : settingsOf(detail));

  let confirmingDelete = $state(false);
  let problem = $state<string | null>(null);

  function refuse(fault: AgentFault, failure: string): void {
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
        problem = failure;
        return;
    }
  }

  const removal = createMutation(() => ({
    mutationFn: (expectedHash: string) => deleteAgent(id, expectedHash),
    onMutate: () => {
      problem = null;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.definitions() });
      router.navigate('/agents');
    },
    onError: (error) => refuse(agentFaultOf(error), copy.deleteFailed),
  }));

  function confirmDelete(): void {
    if (hash !== null) removal.mutate(hash);
  }
</script>

<div class="ib-agent-settings" data-testid="agent-settings">
  {#if failed}
    <Alert variant="danger">
      <p>{copy.loadFailed}</p>
      <Button variant="secondary" size="sm" onclick={onRetry}>{RETRY_LABEL}</Button>
    </Alert>
  {:else if settings === undefined || detail === undefined}
    <div role="status" aria-busy="true" aria-label={copy.heading}>
      <Skeleton height="8rem" />
    </div>
  {:else}
    {#if problem !== null}
      <Alert variant="danger" dismissible onDismiss={() => (problem = null)}>
        <p>{problem}</p>
      </Alert>
    {/if}

    <section class="ib-agent-section" aria-label={copy.heading}>
      <SectionHeading level={2} title={copy.heading} />
      {#if plugin !== null}
        <AgentPluginNote {plugin} />
      {:else if !isFile}
        <p class="ib-agent-note" data-testid="agent-built-in">{copy.builtIn}</p>
      {/if}
      <dl class="ib-agent-settings__list">
        <div class="ib-agent-settings__row">
          <dt>{copy.modelLabel}</dt>
          <dd>
            {#if settings.model === null}{copy.notSet}{:else}<code>{settings.model}</code>{/if}
          </dd>
        </div>
        <div class="ib-agent-settings__row">
          <dt>{copy.modelsLabel}</dt>
          <dd>
            {#if settings.models.length === 0}
              {copy.none}
            {:else}
              <ul class="ib-agent-chips" aria-label={copy.modelsLabel}>
                {#each keyedByOccurrence(settings.models, (model) => model) as { key, item: model } (key)}
                  <li><Badge variant="neutral" size="sm" monospace>{model}</Badge></li>
                {/each}
              </ul>
            {/if}
          </dd>
        </div>
        {#if isFile}
          <div class="ib-agent-settings__row">
            <dt>{copy.stepLimitLabel}</dt>
            <dd>{settings.stepLimit ?? copy.none}</dd>
          </div>
        {/if}
      </dl>
      {#if writable}
        <div class="ib-agent-settings__actions">
          <Button
            data-changes
            variant="danger"
            size="sm"
            disabled={hash === null || removal.isPending}
            onclick={() => (confirmingDelete = true)}>{copy.deleteAction}</Button
          >
        </div>
      {/if}
    </section>

    {#if writable}
      <AgentVersions {id} currentHash={hash} />
    {/if}
  {/if}
</div>

<ConfirmDialog
  bind:open={confirmingDelete}
  title={copy.deleteDialog.title}
  description={copy.deleteDialog.description(id)}
  confirmLabel={copy.deleteDialog.confirm}
  destructive
  onConfirm={confirmDelete}
/>
