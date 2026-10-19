<script lang="ts">
  /**
   * The conversation: the session's title and agent once, the approvals the run is waiting on, and
   * `@lostgradient/chat`'s surface over the session's controller (`chat-session.svelte.ts`). The
   * controller owns what is sent and when, so a message typed while the run is going is a
   * follow-up and a decision on an approval continues the run.
   */
  import { onMount, untrack } from 'svelte';

  import { Alert } from '@lostgradient/cinder';
  import { Chat } from '@lostgradient/chat';

  import { CHAT_COPY } from '../../app/copy.ts';
  import ApprovalAlert from './approval-alert.svelte';
  import { ChatSessionState } from './chat-session.svelte.ts';

  interface ChatConversationProps {
    sessionId: string;
    title: string | null;
    agentName: string;
  }

  let { sessionId, title, agentName }: ChatConversationProps = $props();

  const session = new ChatSessionState({
    sessionId: untrack(() => sessionId),
    agentName: () => agentName,
  });

  let deciding = $state(false);
  let failureDismissed = $state(false);

  /** Each approval the conversation waits on, with the name of the tool it is for. */
  const approvals = $derived(
    session.approvals.map(({ message, result }) => {
      const call = Object.values(session.conversation.messages).find(
        (row) => row.toolCall?.id === result.callId,
      );
      return {
        toolCallId: result.callId,
        toolName: call?.toolCall?.name ?? 'a tool',
        message:
          result.action.type === 'approval' && result.action.message !== undefined
            ? result.action.message
            : typeof message.content === 'string' && message.content !== ''
              ? message.content
              : undefined,
      };
    }),
  );

  async function decide(toolCallId: string, decision: 'approve' | 'deny'): Promise<void> {
    deciding = true;
    try {
      await session.controller.adapter.resolveToolApproval?.(toolCallId, {
        decision,
        remember: false,
      });
    } catch {
      // The controller reported it, and the approval is still pending for another try.
    } finally {
      deciding = false;
    }
  }

  onMount(() => {
    void session.attach();
    return () => session.dispose();
  });

  $effect(() => {
    // A new failure is shown even after an earlier one was dismissed.
    if (session.failure !== undefined) failureDismissed = false;
  });
</script>

<section class="weft-chat-route" aria-label={CHAT_COPY.regionLabel} data-session={sessionId}>
  <header class="weft-chat-header">
    <h1 class="weft-chat-header__title">{title ?? CHAT_COPY.untitled}</h1>
    <p class="weft-chat-header__agent">{agentName}</p>
  </header>

  <!-- A decision continues the run, which the controller refuses while another turn is going. -->
  <ApprovalAlert {approvals} deciding={deciding || session.streaming} onDecide={decide} />

  {#if session.failure !== undefined && !failureDismissed}
    <Alert variant="danger" dismissible onDismiss={() => (failureDismissed = true)}>
      <p class="weft-chat-approval__title">{CHAT_COPY.failureTitle}</p>
      <p class="weft-chat-approval__message">{session.failure}</p>
    </Alert>
  {/if}

  <div class="weft-chat-surface">
    <Chat
      id={`chat-${sessionId}`}
      conversation={session.conversation}
      adapter={session.controller.adapter}
      streaming={session.streaming}
      capabilities={{ attachments: false, editing: false, quote: false }}
    >
      {#snippet messagePart(part, renderDefault)}
        {#if part.type !== 'tool-approval'}
          {@render renderDefault(part)}
        {/if}
      {/snippet}
    </Chat>
  </div>
</section>
