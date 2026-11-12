<script lang="ts">
  /**
   * What a new chat shows where the transcript will be, centred over the composer: the avatar of the
   * agent the chat is with, a greeting that asks what it should do and is the page's one title (the
   * breadcrumb names the page, so there is no separate heading), and the sentence the agent is
   * described by. With no agent selected, the greeting asks to choose one for screen readers only: a
   * chat started from Workflows when no agent can create workflows draws no title, and the agent
   * pill beside the composer is the way on. A chat started from Workflows leaves the sentence out,
   * and its chip above the composer is the only sign of where it came from. The prompts and the
   * other agents sit under the composer (`new-chat-choices.svelte`).
   */
  import { Avatar, Text, VisuallyHidden } from '@lostgradient/cinder';

  import { CHAT_COPY } from '../../app/copy/chat.ts';
  import type { AgentSummary } from '../../lib/bureau-client.ts';
  import { agentLabel } from '../../lib/agent-label.ts';
  import { agentAvatarName, agentTone } from './session-groups.ts';

  interface NewChatWelcomeProps {
    /** The agents a chat can start with. */
    agents: readonly AgentSummary[];
    /** The agent the chat is with, or `undefined` when there is none. */
    selected: string | undefined;
    /** Whether the agent's sentence is drawn under the greeting. Default `true`. */
    sentence?: boolean;
  }

  let { agents, selected, sentence = true }: NewChatWelcomeProps = $props();

  const current = $derived(agents.find((agent) => agent.name === selected));
</script>

<div class="ib-new-chat" data-testid="new-chat-welcome" data-agent={current?.name}>
  {#if current}
    <Avatar
      class="ib-new-chat__avatar ib-chat-avatar"
      size="md"
      name={agentAvatarName(agentLabel(current.name, agents))}
      alt=""
      data-tone={agentTone(current.name)}
    />
    <Text variant="h1" class="ib-new-chat__greeting"
      >{CHAT_COPY.newChatWelcome.greeting(agentLabel(current.name, agents))}</Text
    >
    {#if sentence && current.description}
      <Text class="ib-new-chat__description">{current.description}</Text>
    {/if}
  {:else}
    <VisuallyHidden as="h1">{CHAT_COPY.newChatWelcome.chooseAgent}</VisuallyHidden>
  {/if}
</div>
