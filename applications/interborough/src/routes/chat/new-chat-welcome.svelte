<script lang="ts">
  /**
   * What a new chat shows where the transcript will be, centred over the composer: a greeting that
   * names the agent the chat is with, the prompts that agent suggests (a prompt fills the composer
   * and sends nothing), and, until the person has chosen an agent themselves, the other agents as
   * one row to choose from, so a fresh host says what it can do. With no agent selected (one the
   * Bureau does not list), the row is every agent. The agent is also chosen from the pill inside
   * the composer; choosing here selects the same agent.
   */
  import { Button } from '@lostgradient/cinder';

  import { CHAT_COPY } from '../../app/copy.ts';
  import type { AgentSummary } from '../../lib/bureau-client.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { examplePrompts } from './new-chat.ts';

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
  const prompts = $derived(
    keyedByOccurrence(current === undefined ? [] : examplePrompts(current), (prompt) => prompt),
  );
</script>

<div class="ib-new-chat" data-testid="new-chat-welcome" data-agent={current?.name}>
  {#if current}
    <p class="ib-new-chat__greeting">
      {CHAT_COPY.newChatWelcome.greeting}
      {#if current.displayName === current.name}
        <code class="ib-identifier">{current.name}</code>
      {:else}
        {current.displayName}
        <code class="ib-identifier ib-new-chat__id">{current.name}</code>
      {/if}
    </p>
    {#if current.description}
      <p class="ib-new-chat__description">{current.description}</p>
    {/if}
  {:else}
    <p class="ib-new-chat__greeting">{CHAT_COPY.newChatWelcome.chooseAgent}</p>
  {/if}
  {#if prompts.length > 0}
    <div
      class="ib-new-chat__examples"
      role="group"
      aria-label={CHAT_COPY.newChatWelcome.promptsLabel}
      data-testid="agent-prompts"
    >
      {#each prompts as { key, item: prompt } (key)}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          class="ib-new-chat__prompt"
          onclick={() => onExample(prompt)}>{prompt}</Button
        >
      {/each}
    </div>
  {/if}
  {#if others.length > 0}
    <div
      class="ib-new-chat__agents"
      role="group"
      aria-label={CHAT_COPY.newChatWelcome.otherAgents}
      data-testid="other-agents"
    >
      <span class="ib-new-chat__lead" aria-hidden="true"
        >{CHAT_COPY.newChatWelcome.otherAgents}</span
      >
      {#each others as agent (agent.name)}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          class="ib-new-chat__agent"
          data-agent={agent.name}
          onclick={() => onChoose(agent.name)}>{agent.displayName}</Button
        >
      {/each}
    </div>
  {/if}
</div>
