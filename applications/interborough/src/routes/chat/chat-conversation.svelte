<script lang="ts">
  /**
   * The conversation: the session's title and agent once, the approvals the run is waiting on, and
   * `@lostgradient/chat`'s surface over the session's controller (`chat-session.svelte.ts`). The
   * controller owns what is sent and when, so a message typed while the run is going is a
   * follow-up and a decision on an approval continues the run. A question the run is waiting on a
   * person to answer is shown above the transcript, and the next message answers it.
   *
   * What a person may attach comes from the selected agent's model (`bureau.agents.list`'s `media`):
   * the file picker is on for an agent whose model takes media and off for one that names no model,
   * and off while a run streams or waits on the person's answer, because a follow-up and an answer
   * carry text only. Files upload as they are attached (`../../lib/chat-attachments.ts`), and the
   * assets a row carries, returned by the agent or attached by the person, are shown under it.
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
  import {
    attachmentSettings,
    chatAttachmentErrorMessage,
    createAttachmentUpload,
  } from '../../lib/chat-attachments.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import ApprovalAlert from './approval-alert.svelte';
  import ChatAssets from './chat-assets.svelte';
  import { assetsOf, hasContent, withoutAssetParts } from './chat-assets.ts';
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

  // What the selected agent's model lets a person attach. An agent the Bureau has not listed yet,
  // or one that names no model, takes no attachment.
  const settings = $derived(
    attachmentSettings(agents.data?.find((entry) => entry.name === agent)?.media),
  );
  const upload = $derived(settings === null ? undefined : createAttachmentUpload(settings));
  // A follow-up and an answer to the run's question carry text only, so a file attached then
  // would be dropped without a word. The picker is off for both, and while the page is still
  // finding out whether the session has a run going, which would make the next message a
  // follow-up.
  const attachable = $derived(
    settings !== null &&
      !session.attaching &&
      !session.streaming &&
      session.humanRequests.length === 0,
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
    // Only the end of a run asks again. Reading the query here would make each answer ask again.
    if (!choosing && !session.streaming) untrack(() => void context.refetch());
  });
  const displayTitle = $derived(context.data?.title ?? title ?? CHAT_COPY.untitled);

  function chooseAgent(value: string): void {
    agent = value;
    router.navigate(`/chat/new?agent=${encodeURIComponent(value)}`, { replace: true });
  }

  // Chat lays out the conversation without the Bureau's files in it; they are shown under their
  // rows (`chat-assets.svelte`).
  const shown = $derived(withoutAssetParts(session.conversation));

  let deciding = $state(false);

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
    // A new chat has no thread yet, so there is nothing to attach to or to read back.
    if (!untrack(() => isNew)) void session.attach();
    return () => session.dispose();
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

  <!-- The run reports a question as it parks, a moment before the turn that carried it is over; a
       message sent in between would be a follow-up, so the question waits for the turn's end. -->
  {#each session.streaming ? [] : session.humanRequests as request (request.interruptId)}
    <Alert variant="info" class="weft-chat-approval" data-interrupt={request.interruptId}>
      <p class="weft-chat-approval__title">{CHAT_COPY.humanRequestTitle}</p>
      <p class="weft-chat-approval__message">
        {request.message === '' ? CHAT_COPY.humanRequestFallback : request.message}
      </p>
      <p class="weft-chat-approval__message">{CHAT_COPY.humanRequestHint}</p>
    </Alert>
  {/each}

  {#if session.failure !== undefined}
    <Alert variant="danger" dismissible onDismiss={() => session.dismissFailure()}>
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
      conversation={shown}
      adapter={session.adapter}
      streaming={session.streaming}
      capabilities={{ attachments: attachable, editing: false, quote: false }}
      uploadAttachment={upload}
      acceptedTypes={settings?.acceptedTypes ?? []}
      maxFileSize={settings?.maxFileSize}
      formatAttachmentError={chatAttachmentErrorMessage}
    >
      {#snippet row({ message }, renderDefault)}
        {@const assets = assetsOf(session.conversation.messages[message.id] ?? message)}
        <!-- A message of only files has no bubble to show. A row with no file is Chat's own. -->
        {#if assets.length === 0 || hasContent(message)}
          {@render renderDefault()}
        {/if}
        <ChatAssets {assets} role={message.role === 'user' ? 'user' : 'assistant'} />
      {/snippet}
      {#snippet messagePart(part, renderDefault)}
        {#if part.type !== 'tool-approval'}
          {@render renderDefault(part)}
        {/if}
      {/snippet}
    </Chat>
  </div>
</section>
