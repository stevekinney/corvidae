<script lang="ts">
  /**
   * The agent a new chat is with, at the top of the composer: a ghost listbox select, so it reads as
   * part of the surface, with the agent's avatar before its name and, in the list, the sentence it
   * is described by. An agent that runs on a model says it needs a provider when none is connected,
   * since it could not answer. The agent is chosen from here until the first message is sent; the
   * session then fixes it.
   */
  import { Avatar, Select } from '@lostgradient/cinder';

  import { CHAT_COPY } from '../../app/copy/chat.ts';
  import { agentLabel } from '../../lib/agent-label.ts';
  import { isOfferedInChat } from '../../lib/agent-visibility.ts';
  import type { AgentSummary } from '../../lib/bureau-client.ts';
  import { agentAvatarName, agentTone } from './session-groups.ts';

  interface AgentSelectProps {
    /** The agents a chat can start with. */
    agents: readonly AgentSummary[];
    /** The agent the chat is with, or `undefined` when the Bureau does not list it. */
    value: string | undefined;
    /** Whether any provider holds a key. `undefined` until the host has answered. */
    providerConnected: boolean | undefined;
    /** Whether the choice is closed: the first message is on its way, and the agent is fixed. */
    disabled?: boolean;
    onChange: (agentName: string) => void;
  }

  let { agents, value, providerConnected, disabled = false, onChange }: AgentSelectProps = $props();

  // A hidden agent (a plugin's `visibility: 'hidden'`) is not offered, unless the chat is already
  // with it, so the select keeps showing the agent it is with.
  const options = $derived(
    agents
      .filter((agent) => isOfferedInChat(agent, value))
      .map((agent) => ({
        value: agent.name,
        label: agentLabel(agent.name, agents),
        // An agent with no description shows its name and, muted beside it, that it has none.
        description: agent.description ?? CHAT_COPY.agentSelect.noDescription,
        ...(providerConnected === false && agent.media !== null
          ? { note: CHAT_COPY.agentSelect.needsProvider }
          : {}),
      })),
  );
  const listed = $derived(value !== undefined && agents.some((agent) => agent.name === value));
</script>

<div class="ib-agent-select">
  <Select
    id="weft-chat-agent"
    tone="accent"
    label={CHAT_COPY.agentLabel}
    labelVisible={false}
    variant="ghost"
    {disabled}
    presentation="listbox"
    size="sm"
    placeholder={CHAT_COPY.agentPlaceholder}
    {options}
    {...listed && value !== undefined ? { value } : {}}
    onValueChange={onChange}
  >
    {#snippet leading(option)}
      <Avatar
        class="ib-agent-select__avatar ib-chat-avatar"
        size="xs"
        name={agentAvatarName(option.label)}
        alt=""
        data-tone={agentTone(option.value)}
      />
    {/snippet}
  </Select>
</div>
