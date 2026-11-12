<script lang="ts">
  /**
   * What a new chat offers under its composer: a "Try" row of the prompts the agent suggests (a
   * prompt fills the composer and sends nothing), and an "Or chat with" row of the other agents with
   * their avatars, so a fresh host says what it can do. Choosing an agent here selects the same
   * agent as the pill inside the composer. The prompts are left out while the composer is blocked,
   * because they would fill a box that cannot send; the other agents stay, since choosing one is the
   * way out. The selected agent is not repeated; with no agent selected, the row is every agent.
   */
  import { Avatar, Button } from '@lostgradient/cinder';

  import { CHAT_COPY } from '../../app/copy/chat.ts';
  import { agentLabel } from '../../lib/agent-label.ts';
  import type { AgentSummary } from '../../lib/bureau-client.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { examplePrompts } from './new-chat.ts';
  import { agentAvatarName, agentTone } from './session-groups.ts';

  interface NewChatChoicesProps {
    /** The agents a chat can start with. */
    agents: readonly AgentSummary[];
    /** The agent the chat is with, or `undefined` when the Bureau does not list it. */
    selected: string | undefined;
    /** Whether the composer is a blocked row, which cannot take a prompt. */
    blocked: boolean;
    onChoose: (agentName: string) => void;
    onExample: (prompt: string) => void;
  }

  let { agents, selected, blocked, onChoose, onExample }: NewChatChoicesProps = $props();

  const current = $derived(agents.find((agent) => agent.name === selected));
  const others = $derived(agents.filter((agent) => agent.name !== selected));
  const prompts = $derived(
    keyedByOccurrence(
      blocked || current === undefined ? [] : examplePrompts(current),
      (prompt) => prompt,
    ),
  );
</script>

<div class="ib-new-chat-choices" data-testid="new-chat-choices">
  {#if prompts.length > 0}
    <div
      class="ib-new-chat-choices__row ib-new-chat-choices__row--prompts"
      role="group"
      aria-label={CHAT_COPY.newChatWelcome.promptsLabel}
      data-testid="agent-prompts"
    >
      <span class="ib-new-chat-choices__lead" aria-hidden="true"
        >{CHAT_COPY.newChatWelcome.promptsLead}</span
      >
      {#each prompts as { key, item: prompt } (key)}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          class="ib-new-chat-choices__prompt"
          onclick={() => onExample(prompt)}>{prompt}</Button
        >
      {/each}
    </div>
  {/if}
  {#if others.length > 0}
    <div
      class="ib-new-chat-choices__row"
      role="group"
      aria-label={CHAT_COPY.newChatWelcome.otherAgents}
      data-testid="other-agents"
    >
      <span class="ib-new-chat-choices__lead" aria-hidden="true"
        >{CHAT_COPY.newChatWelcome.otherAgents}</span
      >
      {#each others as agent (agent.name)}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          class="ib-new-chat-choices__agent"
          data-agent={agent.name}
          onclick={() => onChoose(agent.name)}
        >
          <Avatar
            class="ib-chat-avatar"
            size="xs"
            name={agentAvatarName(agentLabel(agent.name, agents))}
            alt=""
            data-tone={agentTone(agent.name)}
          />
          {agentLabel(agent.name, agents)}
        </Button>
      {/each}
    </div>
  {/if}
</div>
