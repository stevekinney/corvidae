<script lang="ts" module>
  export const title = 'Chat composer';
  export const description =
    'The chat composer under a short transcript, so the send, disabled and stop states of its action button can be compared across theme changes.';
</script>

<script lang="ts">
  import {
    Chat,
    appendAssistantMessage,
    appendUserMessage,
    createConversation,
  } from '@lostgradient/chat';
  import { onMount } from 'svelte';

  type FixtureProps = {
    /** Renders the stop state of the action button. */
    streaming?: boolean;
    /** Renders an empty composer and a composer holding a draft, one above the other. */
    drafts?: boolean;
  };

  let { streaming = false, drafts = false }: FixtureProps = $props();

  const conversation = appendAssistantMessage(
    appendUserMessage(
      createConversation({ id: 'composer-fixture' }),
      'Can you summarize this plan?',
    ),
    'The plan is ready to implement.',
  );

  // The fixture sweep refuses an interaction fixture while Chat's hidden quote popover and send
  // tooltip are unpositioned, so the draft is typed here, once, instead of by an interaction step.
  onMount(() => {
    if (!drafts) return;
    const editor = document.querySelector<HTMLTextAreaElement>(
      '#fixture-composer-draft-chat textarea',
    );
    if (editor === null) return;
    editor.value = 'Summarize the plan';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
</script>

{#if drafts}
  <div class="chat-composer-fixture" data-testid="composer-empty">
    <Chat id="fixture-composer-empty-chat" {conversation} capabilities={{ attachments: false }} />
  </div>
  <div class="chat-composer-fixture" data-testid="composer-draft">
    <Chat id="fixture-composer-draft-chat" {conversation} capabilities={{ attachments: false }} />
  </div>
{:else}
  <div class="chat-composer-fixture">
    <Chat
      id="fixture-composer-chat"
      {conversation}
      {streaming}
      capabilities={{ attachments: false }}
    />
  </div>
{/if}

<style>
  .chat-composer-fixture {
    block-size: 18rem;
  }
</style>
