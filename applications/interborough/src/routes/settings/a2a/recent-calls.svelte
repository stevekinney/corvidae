<script lang="ts">
  /**
   * The Recent calls part of Settings › A2A (board PageSettingsSections, "A2A · /settings/a2a"):
   * the remote calls that started a task, newest first, each with when it came, who made it and
   * which agent answered. They are read from the audit trail, where the Bureau keeps one
   * `a2a.call` record per call (`../../../lib/a2a-calls.ts`). With none, a compact empty state says
   * what will appear here. It is an operator table (board ListPatterns, "Option A, for operator
   * tables only").
   */
  import {
    EmptyState,
    ErrorState,
    FormSection,
    RelativeTime,
    Skeleton,
    Table,
  } from '@lostgradient/cinder';
  import { Activity } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';

  import { A2A_COPY } from '../../../app/copy.ts';
  import { getRecentCalls } from '../../../lib/a2a-calls.ts';
  import { agentLabel } from '../../../lib/agent-label.ts';
  import type { AgentSummary } from '../../../lib/bureau-client.ts';
  import { queryKeys } from '../../../lib/query.ts';

  interface Props {
    /** The agents the host lists, which name an agent a call reached by its display name. */
    agents: readonly AgentSummary[];
  }

  let { agents }: Props = $props();

  const copy = A2A_COPY.recent;

  const calls = createQuery(
    () => ({
      queryKey: queryKeys.a2aCalls(),
      queryFn: ({ signal }) => getRecentCalls({ signal }),
      retry: false,
    }),
    undefined,
  );

  /** An agent's name as the Agents list reads it, or the name the call used when the agent is no longer listed. */
  const agentName = (name: string): string => agentLabel(name, agents);
</script>

<div class="ib-a2a-calls" data-section="recent-calls">
  <FormSection grouped heading={copy.heading}>
    {#if calls.data === undefined && calls.isError}
      <ErrorState
        headingLevel={3}
        title={copy.loadFailed.title}
        description={copy.loadFailed.description}
        retryLabel={copy.retry}
        onRetry={() => void calls.refetch()}
        data-testid="a2a-calls-failed"
      />
    {:else if calls.data === undefined}
      <div role="status" aria-busy="true" aria-label={copy.loading}>
        <Skeleton height="1.25rem" width="60%" />
        <Skeleton height="1.25rem" />
      </div>
    {:else if calls.data.length === 0}
      <EmptyState
        kind="first-use"
        size="compact"
        headingLevel={3}
        title={copy.empty.title}
        description={copy.empty.description}
        data-testid="a2a-calls-empty"
      >
        {#snippet icon()}<Activity size={16} aria-hidden="true" />{/snippet}
      </EmptyState>
    {/if}
  </FormSection>
  {#if calls.data !== undefined && calls.data.length > 0}
    <Table caption={copy.tableLabel} density="comfortable" data-testid="a2a-calls">
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>{copy.columns.when}</Table.HeaderCell>
          <Table.HeaderCell>{copy.columns.caller}</Table.HeaderCell>
          <Table.HeaderCell>{copy.columns.agent}</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each calls.data as call (call.taskId)}
          <Table.Row data-task={call.taskId}>
            <Table.Cell><RelativeTime date={call.at} /></Table.Cell>
            <Table.Cell>
              {#if call.callerName !== undefined}
                <span>{call.callerName}</span>
                {#if call.principal !== undefined}
                  <code class="ib-identifier">{call.principal}</code>
                {/if}
              {:else}
                <code class="ib-identifier">{call.principal ?? ''}</code>
              {/if}
            </Table.Cell>
            <Table.Cell>{agentName(call.agent)}</Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table>
  {/if}
</div>

<style>
  .ib-a2a-calls {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-inline-size: 0;
  }
</style>
