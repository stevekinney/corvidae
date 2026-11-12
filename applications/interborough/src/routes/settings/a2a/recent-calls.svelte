<script lang="ts">
  /**
   * The Recent calls part of Settings › A2A (board PageSettingsSections, "A2A, /settings/a2a"):
   * the remote calls that started a task, newest first, each with when it came, who made it and
   * which agent answered ("Today, 9:48 AM", Remote agent “planner”, answered by Tool runner).
   * They are read from the audit trail, where the Bureau keeps one `a2a.call` record per call
   * (`../../../lib/a2a-calls.ts`). With none, a compact empty state says what will appear here.
   */
  import {
    EmptyState,
    ErrorState,
    FormSection,
    RelativeTime,
    Skeleton,
  } from '@lostgradient/cinder';
  import { Activity } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';

  import { A2A_COPY } from '../../../app/copy/a2a.ts';
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
    {:else}
      {#each calls.data as call (call.taskId)}
        <div class="ib-a2a-call" data-task={call.taskId} data-testid="a2a-call">
          <RelativeTime date={call.at} format="absolute" class="ib-a2a-call__when" />
          <span class="ib-a2a-call__caller" title={call.principal}>{copy.caller(call)}</span>
          <span class="ib-a2a-call__agent">{copy.answeredBy(agentName(call.agent))}</span>
        </div>
      {/each}
    {/if}
  </FormSection>
</div>

<style>
  .ib-a2a-calls {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-inline-size: 0;
  }

  .ib-a2a-call {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: var(--cinder-space-3);
    row-gap: var(--cinder-space-0-5);
    font-size: var(--cinder-text-sm);
    min-inline-size: 0;
  }

  .ib-a2a-call :global(.ib-a2a-call__when) {
    flex: none;
    inline-size: 11rem;
    color: var(--cinder-text-muted);
  }

  .ib-a2a-call__caller {
    flex: 1 1 10rem;
    min-inline-size: 0;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .ib-a2a-call__agent {
    color: var(--cinder-text-muted);
  }
</style>
