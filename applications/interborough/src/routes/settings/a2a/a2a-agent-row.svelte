<script lang="ts">
  /**
   * One agent that opts in to A2A: its name (a link to the agent's page), where its Agent Card is
   * served, with a button that copies the address, whether a caller needs the operator's key, and
   * a link to the editor, where the opt-in is changed. The card is read from the host, which is
   * the only place that knows the public origin, if the operator set one. A card that cannot be
   * read says so and offers another try; it never hides the agent.
   */
  import { Badge, Button, CopyButton, Skeleton, StackedListItem } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { A2A_COPY } from '../../../app/copy.ts';
  import { getAgentCard } from '../../../lib/a2a-card.ts';
  import { agentEditPath, agentPath } from '../../../lib/agent-paths.ts';
  import type { AgentSummary } from '../../../lib/bureau-client.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { router } from '../../../lib/router.svelte.ts';

  interface Props {
    agent: AgentSummary;
  }

  let { agent }: Props = $props();

  const card = createQuery(
    () => ({
      queryKey: queryKeys.a2aCard(agent.name),
      queryFn: ({ signal }) => getAgentCard(agent.name, { signal }),
      retry: false,
    }),
    undefined,
  );

  function go(event: MouseEvent, href: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(href);
  }
</script>

<StackedListItem data-agent={agent.name}>
  {#snippet title()}
    <span class="ib-a2a-row__title">
      <a
        class="ib-a2a-row__name"
        href={router.href(agentPath(agent.name))}
        onclick={(event) => go(event, agentPath(agent.name))}>{agent.displayName}</a
      >
      {#if agent.displayName !== agent.name}
        <code class="ib-identifier">{agent.name}</code>
      {/if}
      {#if agent.kind === 'code'}
        <Badge variant="neutral" size="sm">{A2A_COPY.fromCode}</Badge>
      {/if}
      {#if card.data?.needsKey}
        <Badge variant="info" size="sm">{A2A_COPY.needsKey}</Badge>
      {/if}
    </span>
  {/snippet}
  {#snippet description()}
    {#if card.data !== undefined}
      <span class="ib-a2a-row__card" data-testid="a2a-card">
        <code class="ib-a2a-row__address" aria-label={A2A_COPY.cardLabel}>{card.data.cardUrl}</code>
        <CopyButton
          value={card.data.cardUrl}
          label={A2A_COPY.copyCard}
          copiedLabel={A2A_COPY.copiedCard}
          iconOnly
        />
      </span>
    {:else if card.isError}
      <span class="ib-a2a-row__card" data-testid="a2a-card-unavailable">
        <Badge variant="warning" size="sm">{A2A_COPY.cardUnavailable}</Badge>
        <Button variant="ghost" size="sm" onclick={() => void card.refetch()}
          >{A2A_COPY.cardRetry}</Button
        >
      </span>
    {:else}
      <span
        class="ib-a2a-row__card"
        role="status"
        aria-busy="true"
        aria-label={A2A_COPY.cardLoading}
      >
        <Skeleton height="1rem" width="16rem" />
      </span>
    {/if}
  {/snippet}
  {#snippet trailing()}
    {#if agent.kind === 'file'}
      <Button
        href={router.href(agentEditPath(agent.name))}
        variant="ghost"
        size="sm"
        aria-label={A2A_COPY.editAgent(agent.displayName)}
        onclick={(event) => go(event, agentEditPath(agent.name))}>{A2A_COPY.editAction}</Button
      >
    {/if}
  {/snippet}
</StackedListItem>

<style>
  .ib-a2a-row__title {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    align-items: baseline;
    min-inline-size: 0;
    overflow-wrap: anywhere;
  }

  .ib-a2a-row__name {
    font-weight: 600;
  }

  .ib-a2a-row__card {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    align-items: center;
    min-inline-size: 0;
  }

  .ib-a2a-row__address {
    min-inline-size: 0;
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }
</style>
