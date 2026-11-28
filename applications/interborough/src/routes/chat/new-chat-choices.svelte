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
  import { ChevronDown } from '@lucide/svelte';

  import { CHAT_COPY } from '../../app/copy/chat.ts';
  import { agentLabel } from '../../lib/agent-label.ts';
  import { isOfferedInChat } from '../../lib/agent-visibility.ts';
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
  // A hidden agent is not offered here either; the selected agent is left out because it is shown.
  const others = $derived(
    agents.filter((agent) => agent.name !== selected && isOfferedInChat(agent)),
  );
  const prompts = $derived(
    keyedByOccurrence(
      blocked || current === undefined ? [] : examplePrompts(current),
      (prompt) => prompt,
    ),
  );

  // The agents sit in the chat's scroll box above a docked composer, so on a short or busy phone
  // (offline adds a banner and a drawer) the last of them is under the box's end with nothing to say
  // so: the edge fade is polish over blank space between rows, and an overlay scroll bar is hidden.
  // While the last agent is not whole in view a button says the list continues and takes it there.
  let more = $state(false);

  const lastAgentIn = (container: Element): HTMLElement | undefined =>
    Array.from(container.querySelectorAll<HTMLElement>('[data-agent]')).at(-1);

  /** The nearest ancestor that scrolls, which the last agent is measured against. */
  function scrollBoxOf(node: HTMLElement): HTMLElement | null {
    for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
      const overflow = getComputedStyle(parent).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') return parent;
    }
    return null;
  }

  function watchEnd(container: HTMLElement) {
    if (typeof IntersectionObserver === 'undefined') return;
    $effect(() => {
      // Watch the last agent again when the agents change.
      void others.length;
      const last = lastAgentIn(container);
      if (last === undefined) {
        more = false;
        return;
      }
      const observer = new IntersectionObserver(
        (entries) => {
          const entry = entries.at(-1);
          if (entry !== undefined) more = entry.intersectionRatio < 0.99;
        },
        { root: scrollBoxOf(container), threshold: [0, 0.25, 0.5, 0.75, 1] },
      );
      observer.observe(last);
      return () => {
        observer.disconnect();
        more = false;
      };
    });
  }

  function showLastAgent(event: MouseEvent) {
    const container = (event.currentTarget as HTMLElement).closest('.ib-new-chat-choices');
    if (container !== null) lastAgentIn(container)?.scrollIntoView({ block: 'nearest' });
  }
</script>

<div class="ib-new-chat-choices" data-testid="new-chat-choices" {@attach watchEnd}>
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
  {#if more}
    <!-- Pinned to the scroll box's end while the last agent is under it; the wrapper has no height,
         so the button never moves the agents. -->
    <div class="ib-new-chat-choices__more">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        class="ib-new-chat-choices__more-button"
        onclick={showLastAgent}
      >
        {#snippet leadingIcon()}<ChevronDown aria-hidden="true" />{/snippet}
        {CHAT_COPY.newChatWelcome.moreAgents}
      </Button>
    </div>
  {/if}
</div>
