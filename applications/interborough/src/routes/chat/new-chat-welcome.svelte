<script lang="ts">
  /**
   * What a new chat shows where the transcript will be, centred over the composer: the avatar of the
   * agent the chat is with, a greeting that asks what it should do and is the page's one title (the
   * breadcrumb names the page, so there is no separate heading), and the sentence the agent is
   * described by. With no agent selected (one the Bureau does not list), the greeting asks to choose
   * one. The prompts and the other agents sit under the composer (`new-chat-choices.svelte`).
   */
  import { Avatar, Text } from '@lostgradient/cinder';

  import { CHAT_COPY } from '../../app/copy.ts';
  import type { AgentSummary } from '../../lib/bureau-client.ts';
  import { agentLabel } from '../../lib/agent-label.ts';
  import { agentAvatarName, agentTone } from './session-groups.ts';

  interface NewChatWelcomeProps {
    /** The agents a chat can start with. */
    agents: readonly AgentSummary[];
    /** The agent the chat is with, or `undefined` when the Bureau does not list it. */
    selected: string | undefined;
  }

  let { agents, selected }: NewChatWelcomeProps = $props();

  const current = $derived(agents.find((agent) => agent.name === selected));
</script>

<div class="ib-new-chat" data-testid="new-chat-welcome" data-agent={current?.name}>
  {#if current}
    <Avatar
      class="ib-new-chat__avatar ib-chat-avatar"
      size="md"
      name={agentAvatarName(current.name)}
      alt=""
      data-tone={agentTone(current.name)}
    />
    <Text variant="h1" class="ib-new-chat__greeting"
      >{CHAT_COPY.newChatWelcome.greeting(agentLabel(current.name, agents))}</Text
    >
    {#if current.description}
      <Text class="ib-new-chat__description">{current.description}</Text>
    {/if}
  {:else}
    <Text variant="h1" class="ib-new-chat__greeting">{CHAT_COPY.newChatWelcome.chooseAgent}</Text>
  {/if}
</div>
