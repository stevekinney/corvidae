<script lang="ts">
  /**
   * The conversation: the session's title and agent once, the approvals the run is waiting on, and
   * `@lostgradient/chat`'s surface over the session's controller (`chat-session.svelte.ts`). The
   * controller owns what is sent and when, so a message typed while the run is going is a
   * follow-up and a decision on an approval continues the run.
   *
   * A new chat (`isNew`, at `/chat/new`) has no session yet. The client names the thread, the agent
   * is chosen above the composer, and the first message starts the run. When the run has started
   * the address becomes `/chat/:sessionId` by replacing the history entry, with this page kept
   * mounted (`router.navigate`'s `keep`), and the agent is fixed from then on.
   */
  import { onMount, untrack } from 'svelte';

  import { Alert, Combobox } from '@lostgradient/cinder';
  import { Chat } from '@lostgradient/chat';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { CHAT_COPY } from '../../app/copy.ts';
  import { getContext, listAgents, type AgentSummary } from '../../lib/bureau-client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import ApprovalAlert from './approval-alert.svelte';
  import { ChatSessionState } from './chat-session.svelte.ts';

  interface ChatConversationProps {
    sessionId: string;
    title: string | null;
    agentName: string;
    /** Whether this is a chat that has no session until its first run starts. */
    isNew?: boolean;
  }

  let { sessionId, title, agentName, isNew = false }: ChatConversationProps = $props();

  const queryClient = useQueryClient();
  // The agent is chosen until the run starts, and fixed once the session exists.
  let agent = $state(untrack(() => agentName));
  let choosing = $state(untrack(() => isNew));

  const session = new ChatSessionState({
    sessionId: untrack(() => sessionId),
    agentName: () => agent,
    onRunStarted: () => {
      if (!choosing) return;
      choosing = false;
      // The session exists now. Its address replaces the new chat's, so Back returns to where the
      // person came from, and this page stays mounted so the run carries on.
      router.navigate(`/chat/${encodeURIComponent(sessionId)}`, { replace: true, keep: true });
      void queryClient.invalidateQueries({ queryKey: ['contexts'] });
    },
  });

  const agents = createQuery(
    () => ({
      queryKey: queryKeys.agents.list(),
      queryFn: ({ signal }) => listAgents({ signal }),
      enabled: choosing,
    }),
    undefined,
  );
  const choices = $derived(
    (agents.data ?? [])
      .filter((entry: AgentSummary) => entry.publishState === 'published')
      .map((entry: AgentSummary) => ({
        value: entry.name,
        label: entry.displayName,
        ...(entry.description === null ? {} : { description: entry.description }),
      })),
  );

  // Once the session exists its title comes from the Bureau, and it is read again when a run ends.
  const context = createQuery(
    () => ({
      queryKey: queryKeys.contexts.detail(sessionId),
      queryFn: ({ signal }) => getContext(sessionId, { signal }),
      enabled: !choosing,
      retry: false,
    }),
    undefined,
  );
  $effect(() => {
    if (!choosing && !session.streaming) void context.refetch();
  });
  const displayTitle = $derived(context.data?.title ?? title ?? CHAT_COPY.untitled);

  function chooseAgent(value: string): void {
    agent = value;
    router.navigate(`/chat/new?agent=${encodeURIComponent(value)}`, { replace: true });
  }

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
    <h1 class="weft-chat-header__title">{displayTitle}</h1>
    {#if !choosing}
      <p class="weft-chat-header__agent">{agent}</p>
    {/if}
  </header>

  <!-- A decision continues the run, which the controller refuses while another turn is going. -->
  <ApprovalAlert {approvals} deciding={deciding || session.streaming} onDecide={decide} />

  {#if session.failure !== undefined && !failureDismissed}
    <Alert variant="danger" dismissible onDismiss={() => (failureDismissed = true)}>
      <p class="weft-chat-approval__title">{CHAT_COPY.failureTitle}</p>
      <p class="weft-chat-approval__message">{session.failure}</p>
    </Alert>
  {/if}

  {#if choosing}
    <div class="weft-chat-agent">
      <Combobox
        id="weft-chat-agent"
        label={CHAT_COPY.agentLabel}
        placeholder={CHAT_COPY.agentPlaceholder}
        options={choices}
        value={agent}
        onValueChange={chooseAgent}
      />
    </div>
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
