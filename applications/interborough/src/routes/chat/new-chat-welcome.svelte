<script lang="ts">
  /**
   * What a new chat shows where the transcript will be: the card of the agent the chat is with
   * (`agent-card.svelte`), and, until the person has chosen an agent themselves, the other agents
   * as cards to choose from, so a fresh host says what each agent does. With no agent selected
   * (one the Bureau does not list), every agent is a card. Choosing a card selects the agent, as
   * the Agent list above the composer does.
   */
  import { Card } from '@lostgradient/cinder';

  import { CHAT_COPY } from '../../app/copy.ts';
  import type { AgentSummary } from '../../lib/bureau-client.ts';
  import AgentCard from './agent-card.svelte';

  interface NewChatWelcomeProps {
    /** The agents a chat can start with. */
    agents: readonly AgentSummary[];
    /** The agent the chat is with, or `undefined` when the Bureau does not list it. */
    selected: string | undefined;
    /** Whether the person has chosen the agent (the address names it) rather than received the default. */
    chosen: boolean;
    onChoose: (agentName: string) => void;
    onExample: (prompt: string) => void;
  }

  let { agents, selected, chosen, onChoose, onExample }: NewChatWelcomeProps = $props();

  const current = $derived(agents.find((agent) => agent.name === selected));
  const others = $derived(chosen ? [] : agents.filter((agent) => agent.name !== selected));
</script>

<div class="ib-new-chat" data-testid="new-chat-welcome">
  {#if current}
    <AgentCard agent={current} {onExample} />
  {/if}
  {#if others.length > 0}
    <section class="ib-new-chat__others" aria-labelledby="ib-new-chat-others">
      <h2 id="ib-new-chat-others" class="ib-new-chat__heading">
        {current ? CHAT_COPY.newChatWelcome.otherAgents : CHAT_COPY.newChatWelcome.chooseAgent}
      </h2>
      <ul class="ib-new-chat__grid">
        {#each others as agent (agent.name)}
          <li>
            <Card
              class="ib-agent-choice"
              data-agent={agent.name}
              onclick={() => onChoose(agent.name)}
            >
              <span class="ib-agent-choice__name">
                {#if agent.displayName === agent.name}
                  <code class="ib-identifier">{agent.name}</code>
                {:else}
                  {agent.displayName}
                  <code class="ib-identifier ib-agent-choice__id">{agent.name}</code>
                {/if}
              </span>
              {#if agent.description}
                <span class="ib-agent-choice__description">{agent.description}</span>
              {/if}
            </Card>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>
