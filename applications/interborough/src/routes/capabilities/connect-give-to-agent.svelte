<script lang="ts">
  /**
   * "Give to an agent", after a source is connected (COR-2022 rows 35c, 35d): a picker titled "Give
   * GitHub's tools to which agent?" that lists the agents that can take new tools, each a bordered
   * row with its name, its identifier small and monospaced, and "Opens its Access tab". Choosing one
   * opens that agent's Access tab, where the new tools are listed and unchecked, so the choice of
   * giving them is the person's. Nothing is given here.
   *
   * An agent can take new tools when the owner's file defines it: one defined in code, or shipped by
   * a plugin, keeps the tools it states (`agent-access.svelte`).
   */
  import { Alert, Button, Modal, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { CAPABILITIES_COPY } from '../../app/copy/capabilities.ts';
  import { pluginOfAgent } from '../../lib/agent-paths.ts';
  import { agentsListQuery } from '../../lib/agent-queries.ts';

  interface Props {
    /** What a person calls the source whose tools are given. */
    sourceName: string;
    /** Whether the picker is showing. */
    open: boolean;
    onClose: () => void;
    /** An agent was chosen: the page opens its Access tab. */
    onChoose: (agent: string) => void;
  }

  let { sourceName, open, onClose, onChoose }: Props = $props();

  const copy = CAPABILITIES_COPY.source.connect.give;

  const agents = createQuery(() => ({ ...agentsListQuery(), enabled: open }), undefined);
  const takers = $derived(
    (agents.data ?? []).filter(
      (agent) => agent.kind === 'file' && pluginOfAgent(agent.name) === null,
    ),
  );
</script>

{#if open}
  <Modal open title={copy.title(sourceName)} onDismiss={onClose}>
    {#snippet children()}
      <div class="ib-connect-give" data-testid="connect-give">
        {#if agents.isPending}
          <div role="status" aria-busy="true" aria-label={copy.loading}>
            <Skeleton height="3rem" />
          </div>
        {:else if agents.isError}
          <Alert variant="warning">{copy.failed}</Alert>
        {:else if takers.length === 0}
          <p class="ib-connect-give__note" data-testid="connect-give-none">{copy.none}</p>
        {:else}
          <ul class="ib-connect-give__agents">
            {#each takers as agent (agent.name)}
              <li>
                <button
                  type="button"
                  class="ib-connect-give__agent"
                  data-give-agent={agent.name}
                  onclick={() => onChoose(agent.name)}
                >
                  <span class="ib-connect-give__name">{agent.displayName}</span>
                  <code class="ib-capability__code ib-capability__identifier">{agent.name}</code>
                  <span class="ib-connect-give__note">{copy.opens}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/snippet}
    {#snippet footer()}
      <Button variant="secondary" onclick={onClose}>{copy.cancel}</Button>
    {/snippet}
  </Modal>
{/if}

<style>
  .ib-connect-give {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .ib-connect-give__agents {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /* Each agent a bordered row: its name, its identifier, and where choosing it leads (row 35c). */
  .ib-connect-give__agent {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--cinder-space-1) var(--cinder-space-2);
    inline-size: 100%;
    padding: var(--cinder-space-2) var(--cinder-space-3);
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
    overflow-wrap: anywhere;
  }

  .ib-connect-give__agent:hover {
    border-color: var(--cinder-border-control);
  }

  .ib-connect-give__agent:focus-visible {
    outline: var(--cinder-ring-width) solid var(--cinder-ring-color);
    outline-offset: 2px;
  }

  .ib-connect-give__name {
    font-weight: var(--cinder-font-medium);
  }

  .ib-connect-give__note {
    margin: 0;
    margin-inline-start: auto;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
</style>
