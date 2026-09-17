<script lang="ts" module>
  import type { ChatAdapter, ChatReadReceiptEvent } from './chat-adapter.ts';
  import type { ConversationHistory, Message } from '../conversation-model.ts';

  export type AdapterSwitchFixtureProps = {
    initial: ConversationHistory;
    adapter: ChatAdapter;
    onpushmessage?: (message: Message) => void;
    ontypingchange?: (isTyping: boolean) => void;
    onreadreceipt?: (event: ChatReadReceiptEvent) => void;
    onerror?: (error: unknown) => void;
  };
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import Chat from '../chat.svelte';

  let {
    initial,
    adapter,
    onpushmessage = () => {},
    ontypingchange = () => {},
    onreadreceipt = () => {},
    onerror = (error) => {
      throw error;
    },
  }: AdapterSwitchFixtureProps = $props();

  // Real $state so the test can switch the conversation snapshot and exercise
  // the subscribe `$effect`'s re-subscription on `conversation.id` change.
  let conversation = $state<ConversationHistory>(untrack(() => initial));
  let currentAdapter = $state<ChatAdapter>(untrack(() => adapter));

  export function setConversation(next: ConversationHistory): void {
    conversation = next;
  }

  export function setAdapter(next: ChatAdapter): void {
    currentAdapter = next;
  }

  export function setCallbacks(callbacks: {
    onpushmessage?: (message: Message) => void;
    ontypingchange?: (isTyping: boolean) => void;
    onreadreceipt?: (event: ChatReadReceiptEvent) => void;
  }): void {
    onpushmessage = callbacks.onpushmessage ?? (() => {});
    ontypingchange = callbacks.ontypingchange ?? (() => {});
    onreadreceipt = callbacks.onreadreceipt ?? (() => {});
  }
</script>

<svelte:boundary {onerror}>
  <div style="height: 20rem;">
    <Chat
      id="switch-chat"
      {conversation}
      adapter={currentAdapter}
      {onpushmessage}
      {ontypingchange}
      {onreadreceipt}
    />
  </div>
  {#snippet failed(error)}
    <div data-boundary-error>{error}</div>
  {/snippet}
</svelte:boundary>
