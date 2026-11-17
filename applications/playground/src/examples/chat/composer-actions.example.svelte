<script lang="ts" module>
  export const title = 'Composer actions';
  export const description =
    'Render host-owned controls, here a model Select, in the composer footer beside Send with the composerActions snippet.';
</script>

<script lang="ts">
  import {
    Chat,
    appendAssistantMessage,
    appendUserMessage,
    createConversation,
    type ChatSubmitEvent,
  } from '@lostgradient/chat';
  import { Select } from '@lostgradient/cinder';

  const models = [
    { value: 'fast', label: 'Fast' },
    { value: 'balanced', label: 'Balanced' },
    { value: 'deep', label: 'Deep' },
  ];

  let model = $state('balanced');
  let conversation = $state(
    appendAssistantMessage(
      appendUserMessage(
        createConversation({ id: 'composer-actions' }),
        'Which model answers next?',
      ),
      'Whichever the picker beside Send names. Change it, then send.',
    ),
  );

  function handleSubmit(event: ChatSubmitEvent): void {
    conversation = appendAssistantMessage(
      appendUserMessage(conversation, event.message.content),
      `Answered by the ${model} model.`,
    );
  }
</script>

<div style="height: 30rem;">
  <Chat
    id="composer-actions"
    {conversation}
    capabilities={{ attachments: false }}
    onSubmit={handleSubmit}
  >
    {#snippet composerActions()}
      <Select
        id="composer-actions-model"
        bind:value={model}
        options={models}
        label="Model"
        labelVisible={false}
      />
    {/snippet}
  </Chat>
</div>
