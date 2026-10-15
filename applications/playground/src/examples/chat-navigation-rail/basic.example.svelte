<script lang="ts" module>
  export const title = 'Transcript navigation rail';
  export const description = 'Scrub or tab between user-authored turns in a longer conversation.';
</script>

<script lang="ts">
  import {
    appendAssistantMessage,
    appendUserMessage,
    ChatNavigationRail,
    createConversation,
    getMessages,
  } from '@lostgradient/chat';

  // Number messages in order and give the transcript a fixed time, rather than random ids and
  // the clock, so every render of this example, including the static export's, is identical.
  let messageCount = 0;
  const environment = {
    randomId: () => `message-${(messageCount += 1)}`,
    now: () => '2026-01-15T09:30:00.000Z',
  };

  let conversation = createConversation({ id: 'navigation-example' });
  conversation = appendUserMessage(
    conversation,
    'Summarize the launch plan.',
    undefined,
    environment,
  );
  conversation = appendAssistantMessage(
    conversation,
    'The launch has three phases.',
    undefined,
    environment,
  );
  conversation = appendUserMessage(
    conversation,
    'What is the riskiest phase?',
    undefined,
    environment,
  );
  conversation = appendAssistantMessage(
    conversation,
    'The staged rollout needs the closest watch.',
    undefined,
    environment,
  );
  const messages = getMessages(conversation);
  let viewport: HTMLDivElement;

  function scrollToMessage(messageId: string): void {
    viewport
      .querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
</script>

<div style="height: 16rem; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1rem;">
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (The transcript viewport needs keyboard scrolling.) -->
  <div
    bind:this={viewport}
    tabindex="0"
    role="region"
    aria-label="Conversation transcript"
    style="overflow: auto; display: grid; gap: 1rem;"
  >
    {#each messages as message (message.id)}
      <article
        data-message-id={message.id}
        style="min-height: 8rem; padding: 1rem; border: 1px solid var(--cinder-border-default); border-radius: var(--cinder-radius-md);"
      >
        <strong>{message.role === 'user' ? 'You' : 'Assistant'}</strong>
        <p>{message.content}</p>
      </article>
    {/each}
  </div>
  <ChatNavigationRail {messages} {scrollToMessage} {viewport} />
</div>
