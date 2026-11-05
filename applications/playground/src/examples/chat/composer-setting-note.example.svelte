<script lang="ts" module>
  export const title = 'Composer after a mid-reply setting change';
  export const description =
    'Effort changed from Medium to High while a reply streams: the transcript shows the finished call (“Lookup order 4398 → $27.25, delivered Friday”, 0.4s) under the message and the streaming reply with a caret, the composer shows High and the line under it says when it applies. Stop is shown.';
</script>

<script lang="ts">
  import {
    appendStreamingMessage,
    appendUserMessage,
    Chat,
    ChatComposerSettings,
    createConversation,
    updateStreamingMessage,
    type ChatAdapter,
  } from '@lostgradient/chat';
  import { Meter, Select, ToolCallRail } from '@lostgradient/cinder';

  const MODELS = [
    { value: 'sonnet', label: 'Claude Sonnet 5.5' },
    { value: 'haiku', label: 'Claude Haiku 5' },
  ];
  const EFFORTS = [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
  ];
  const PERMISSIONS = [
    {
      value: 'on-changes',
      label: 'On changes asks',
      description: 'Tools set to On changes ask before they run.',
    },
    {
      value: 'allow-all',
      label: 'Allow all',
      description:
        'Skips the On changes asks for this chat. Tools set to Always still ask; Blocked tools stay blocked.',
    },
  ];
  let model = $state('sonnet');
  let effort = $state('high');
  let permissions = $state('on-changes');

  // An adapter that takes a message while the run is going, so the composer stays live.
  const adapter: ChatAdapter = {
    sendMessage: async () => undefined,
    sendRunInput: async () => undefined,
    stopGenerating: async () => undefined,
  };

  // The reply is a streaming row, so it draws a caret and no line of actions.
  const opened = appendStreamingMessage(
    appendUserMessage(
      createConversation({ id: 'composer-setting-note' }),
      'Also look up order 4398, the same carrier.',
    ),
    'assistant',
  );
  const conversation = updateStreamingMessage(
    opened.conversation,
    opened.messageId,
    'Order 4398 is $27.25 and was delivered Friday. Checking the carrier’s damage notes',
  );
</script>

<div style="block-size: 26rem;">
  <Chat
    id="composer-setting-note"
    {conversation}
    surfaceMode="transparent"
    variant="transcript"
    capabilities={{ editing: false }}
    composerPlaceholder="Message Tool runner…"
    {adapter}
    streaming
    composerStatus={{ kind: 'note', text: 'Effort High applies from the next step.' }}
  >
    <!-- The call sits under the message that asked for it and above the reply, as the board draws it. -->
    {#snippet row(context, renderDefault)}
      {@render renderDefault()}
      {#if context.message.role === 'user'}
        <ToolCallRail
          calls={[
            {
              id: 'call-1',
              name: 'Lookup order',
              input: '4398',
              result: '$27.25, delivered Friday',
              duration: '0.4s',
              status: 'done',
            },
          ]}
        />
      {/if}
    {/snippet}
    {#snippet composerControls({ folded })}
      <ChatComposerSettings {folded}>
        <Select
          id="composer-setting-note-model"
          variant="ghost"
          presentation="listbox"
          size="sm"
          label="Model"
          labelVisible={false}
          valuePrefix="Model"
          options={MODELS}
          bind:value={model}
        />
        <Select
          id="composer-setting-note-effort"
          variant="ghost"
          presentation="listbox"
          size="sm"
          label="Effort"
          labelVisible={false}
          valuePrefix="Effort"
          options={EFFORTS}
          bind:value={effort}
        />
        <Select
          id="composer-setting-note-permissions"
          variant="ghost"
          presentation="listbox"
          size="sm"
          label="Permissions"
          labelVisible={false}
          valuePrefix="Permissions"
          options={PERMISSIONS}
          bind:value={permissions}
        />
      </ChatComposerSettings>
    {/snippet}
    {#snippet composerActions()}
      <span class="context-meter" title="76K of 200K tokens">
        <Meter size="sm" value={38} ariaLabel="Context 38%" />
        <span aria-hidden="true">38%</span>
      </span>
    {/snippet}
  </Chat>
</div>

<style>
  .context-meter {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
  }

  .context-meter :global(.cinder-meter) {
    inline-size: 2.25rem;
  }

  /* A phone-width composer keeps the figure and drops the bar, so the row never overlaps. */
  @container (max-inline-size: 24rem) {
    .context-meter :global(.cinder-meter) {
      display: none;
    }
  }
</style>
