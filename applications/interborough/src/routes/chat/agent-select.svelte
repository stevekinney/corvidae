<script lang="ts">
  /**
   * The agent a new chat is with, at the top of the composer: a ghost listbox select, so it reads as
   * part of the surface, with the agent's avatar before its name and, in the list, the sentence it
   * is described by. An agent that runs on a model says it needs a provider when none is connected,
   * since it could not answer. The agent is chosen from here until the first message is sent; the
   * session then fixes it.
   */
  import { Avatar, Select } from '@lostgradient/cinder';

  import { CHAT_COPY } from '../../app/copy.ts';
  import { agentLabel } from '../../lib/agent-label.ts';
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

  const options = $derived(
    agents.map((agent) => ({
      value: agent.name,
      label: agentLabel(agent.name, agents),
      ...(agent.description === null ? {} : { description: agent.description }),
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
        name={agentAvatarName(option.value)}
        alt=""
        data-tone={agentTone(option.value)}
      />
    {/snippet}
  </Select>
</div>
