<script lang="ts">
  /**
   * What an agent is, for the person choosing who to talk to: its name (and its identifier in
   * monospace beside it when they differ), what it does, its model and tools
   * (`routes/agents/agent-facts.svelte`, which the agents list shows too), and up to three prompts
   * it suggests. A prompt is a button that puts its words in the composer for the person to send or
   * change; it does not send them. The prompts are the agent's own (`examples` in the agent's file
   * or in `createAgent`), so an agent that suggests none shows none.
   */
  import { Button, Card } from '@lostgradient/cinder';

  import { CHAT_COPY } from '../../app/copy.ts';
  import type { AgentSummary } from '../../lib/bureau-client.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import AgentFacts from '../agents/agent-facts.svelte';
  import { examplePrompts } from './new-chat.ts';

  interface AgentCardProps {
    agent: AgentSummary;
    onExample: (prompt: string) => void;
  }

  let { agent, onExample }: AgentCardProps = $props();

  const prompts = $derived(keyedByOccurrence(examplePrompts(agent), (prompt) => prompt));
</script>

<Card class="ib-agent-card" data-agent={agent.name} data-testid="agent-card">
  {#snippet header()}
    <h2 class="ib-agent-card__name">
      {#if agent.displayName === agent.name}
        <code class="ib-identifier">{agent.name}</code>
      {:else}
        {agent.displayName}
        <code class="ib-identifier ib-agent-card__id">{agent.name}</code>
      {/if}
    </h2>
  {/snippet}
  {#if agent.description}
    <p class="ib-agent-card__description">{agent.description}</p>
  {/if}
  <AgentFacts {agent} />
  {#if prompts.length > 0}
    <div
      class="ib-agent-card__prompts"
      role="group"
      aria-label={CHAT_COPY.newChatWelcome.promptsLabel}
    >
      <span class="ib-agent-card__try" aria-hidden="true">{CHAT_COPY.newChatWelcome.try}</span>
      {#each prompts as { key, item: prompt } (key)}
        <Button type="button" variant="secondary" size="sm" onclick={() => onExample(prompt)}
          >{prompt}</Button
        >
      {/each}
    </div>
  {/if}
</Card>
