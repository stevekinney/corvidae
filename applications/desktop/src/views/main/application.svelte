<script lang="ts">
  import {
    Chat,
    createChatSessionController,
    createConversationHistory,
    type ChatAdapterErrorEvent,
    type ConversationHistory,
  } from '@lostgradient/chat';
  // The workspace Cinder exports one entry point, not per-component subpaths,
  // and that entry also loads the base cascade as a side effect.
  import { Badge } from '@lostgradient/cinder';
  import { untrack } from 'svelte';

  import { createChatTransport } from '../chat-transport.ts';
  import { toBannerFailure, type BannerFailure } from './chat-failure.ts';

  import type { ChatStreamSubscribers } from '../renderer-rpc.ts';
  import type { ApplicationRendererRpc } from '../../shared/rpc-contract.ts';

  type Props = {
    rpc: ApplicationRendererRpc;
    subscribeToChatStream: (subscribers: ChatStreamSubscribers) => () => void;
  };

  let { rpc, subscribeToChatStream }: Props = $props();

  /*
   * Both props are fixed at module load in `main.ts` and never change, so
   * reading them once is correct. `untrack` states that intent explicitly —
   * reading a prop into a plain `const` otherwise trips
   * `state_referenced_locally`, which exists to catch accidental captures.
   */
  const transport = untrack(() => createChatTransport({ rpc, subscribe: subscribeToChatStream }));

  let conversation = $state<ConversationHistory>(createConversationHistory({ id: 'chat' }));
  let failure = $state<BannerFailure | null>(null);
  let streaming = $state(false);

  const session = createChatSessionController({
    getConversation: () => $state.snapshot(conversation),
    setConversation: (next) => (conversation = next),
    transport,
    hooks: {
      onStreamingChange: (value) => {
        streaming = value;
        if (value) failure = null;
      },
      onError: (cause) => (failure = toBannerFailure(cause)),
    },
  });

  const adapter = session.adapter;

  function handleAdapterError(event: ChatAdapterErrorEvent): void {
    failure = toBannerFailure(event.error);
  }
</script>

<main class="shell" data-testid="renderer-shell">
  <header class="titlebar">
    <h1>Chat Room</h1>
    <Badge variant={streaming ? 'info' : 'neutral'}>
      {streaming ? 'Responding' : 'Ready'}
    </Badge>
  </header>

  <!--
    Rendered unconditionally so assistive technology observes the live region
    before it has content. A region that appears already populated is announced
    inconsistently.
  -->
  <p
    class="failure"
    role="alert"
    data-testid="chat-error"
    data-retryable={failure?.retryable === undefined ? undefined : String(failure.retryable)}
    data-empty={failure ? undefined : 'true'}
  >
    {#if failure}
      {failure.message}
      <!--
        The classification, rendered rather than flattened away. A reader
        should be able to tell from the banner whether pressing Retry is worth
        anything, without guessing from the wording.
      -->
      {#if failure.retryable === true}
        <span data-testid="chat-error-disposition"> — you can try that again.</span>
      {:else if failure.retryable === false}
        <span data-testid="chat-error-disposition"> — retrying will not help.</span>
      {/if}
    {/if}
  </p>

  <div class="conversation">
    <Chat
      id="desktop-chat"
      {conversation}
      {adapter}
      {streaming}
      scrollFadeVisible
      onAdapterError={handleAdapterError}
    />
  </div>
</main>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    block-size: 100dvh;
    min-block-size: 0;
  }

  .titlebar {
    display: flex;
    gap: var(--cinder-space-3);
    align-items: center;
    padding-block: var(--cinder-space-3);
    padding-inline: var(--cinder-space-4);
    border-block-end: 1px solid var(--cinder-border-muted);
  }

  .titlebar h1 {
    flex: 1;
    margin: 0;
    font-size: var(--cinder-text-lg);
  }

  .failure {
    margin: 0;
    color: var(--cinder-status-danger-solid);
    padding-inline: var(--cinder-space-4);
  }

  .failure[data-empty='true'] {
    padding-block: 0;
  }

  .failure:not([data-empty='true']) {
    padding-block: var(--cinder-space-2);
  }

  .conversation {
    flex: 1;
    min-block-size: 0;
  }
</style>
