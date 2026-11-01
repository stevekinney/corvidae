<script lang="ts">
  /**
   * `/settings/a2a`: what an A2A client can reach on this host. The agents that opt in, each with
   * the address of its Agent Card (`a2a-agent-row.svelte`), above the push-notification settings,
   * which are Bureau settings and are edited and saved like the rest of Settings
   * (`../settings-frame.svelte`). An agent opts in from its editor, so each row links there: the
   * opt-in is the agent's file, and has one place to change.
   */
  import {
    Alert,
    Button,
    DataList,
    EmptyState,
    SectionHeading,
    Skeleton,
  } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { A2A_COPY, RETRY_LABEL, SETTINGS_SECTION_COPY } from '../../../app/copy.ts';
  import { listAgents } from '../../../lib/bureau-client.ts';
  import { keyedByOccurrence } from '../../../lib/list-keys.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import SettingsFrame from '../settings-frame.svelte';
  import A2aAgentRow from './a2a-agent-row.svelte';

  const agents = createQuery(
    () => ({
      queryKey: queryKeys.agents.list(),
      queryFn: ({ signal }) => listAgents({ signal }),
      retry: false,
    }),
    undefined,
  );

  const reachable = $derived(
    keyedByOccurrence(
      (agents.data ?? []).filter((agent) => agent.a2a),
      (agent) => agent.name,
    ),
  );

  function open(event: MouseEvent, href: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(href);
  }
</script>

<SettingsFrame
  section="a2a"
  title={SETTINGS_SECTION_COPY.a2a}
  intro={A2A_COPY.intro}
  page="settings-a2a"
>
  {#snippet before()}
    <section class="ib-a2a__agents" aria-label={A2A_COPY.agentsHeading} data-testid="a2a-agents">
      <SectionHeading
        level={2}
        title={A2A_COPY.agentsHeading}
        description={A2A_COPY.agentsDescription}
      />
      {#if agents.isError && agents.data === undefined}
        <Alert variant="danger" data-testid="a2a-agents-failed">
          <p class="ib-a2a__alert-title">{A2A_COPY.loadFailed.title}</p>
          <p class="ib-a2a__alert-body">{A2A_COPY.loadFailed.description}</p>
          <Button variant="secondary" size="sm" onclick={() => void agents.refetch()}
            >{RETRY_LABEL}</Button
          >
        </Alert>
      {:else if agents.data === undefined}
        <div role="status" aria-busy="true" aria-label={A2A_COPY.loading}>
          <Skeleton height="1.5rem" width="40%" />
          <Skeleton height="4rem" />
        </div>
      {:else if reachable.length === 0}
        <EmptyState
          kind="first-use"
          size="compact"
          headingLevel={3}
          title={A2A_COPY.empty.title}
          description={A2A_COPY.empty.description}
          data-testid="a2a-empty"
        >
          {#snippet action()}
            <Button
              variant="secondary"
              href={router.href(A2A_COPY.empty.action.href)}
              onclick={(event) => open(event, A2A_COPY.empty.action.href)}
              >{A2A_COPY.empty.action.label}</Button
            >
          {/snippet}
        </EmptyState>
      {:else}
        <DataList
          items={[...reachable]}
          key={(entry) => entry.key}
          density="condensed"
          aria-label={A2A_COPY.listLabel}
        >
          {#snippet children({ item: agent })}
            <A2aAgentRow {agent} />
          {/snippet}
        </DataList>
      {/if}
    </section>
  {/snippet}
</SettingsFrame>

<style>
  .ib-a2a__agents {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-inline-size: 0;
  }

  .ib-a2a__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .ib-a2a__alert-body {
    margin: var(--cinder-space-1) 0 var(--cinder-space-2);
  }
</style>
