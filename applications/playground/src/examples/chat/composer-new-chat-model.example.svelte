<script lang="ts" module>
  export const title = 'New chat composer with a model agent';
  export const description =
    'With a model agent and a provider connected the control row shows ghost selects Model Claude Sonnet 5.5, Effort Medium and Permissions On changes asks, plus Send; the agent select reads Tool runner with its TR avatar.';
</script>

<script lang="ts">
  import { Chat, ChatComposerSettings, createConversation } from '@lostgradient/chat';
  import { Avatar, Select } from '@lostgradient/cinder';

  const AGENTS = [
    {
      value: 'assistant',
      label: 'Assistant',
      description: 'Answers every message with the same scripted reply.',
    },
    {
      value: 'tool-runner',
      label: 'Tool runner',
      description: 'Looks an order up, then asks for approval to refund it.',
    },
  ];
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
    { value: 'always', label: 'Always asks', description: 'Every tool call asks first.' },
    {
      value: 'on-changes',
      label: 'On changes asks',
      description: 'Tools set to On changes ask before they run.',
    },
  ];
  let agent = $state('tool-runner');
  let model = $state('sonnet');
  let effort = $state('medium');
  let permissions = $state('on-changes');

  const conversation = createConversation({ id: 'composer-new-chat-model' });
</script>

<div style="block-size: 20rem;">
  <Chat
    id="composer-new-chat-model"
    {conversation}
    surfaceMode="transparent"
    composerPlaceholder="Message Tool runner…"
  >
    {#snippet composerHeader()}
      <Select
        id="composer-new-chat-model-agent"
        variant="ghost"
        presentation="listbox"
        size="sm"
        label="Agent"
        labelVisible={false}
        options={AGENTS}
        bind:value={agent}
      >
        {#snippet leading(option)}
          <Avatar size="xs" name={option.label} alt="" />
        {/snippet}
      </Select>
    {/snippet}
    {#snippet composerControls({ folded })}
      <ChatComposerSettings {folded}>
        <Select
          id="composer-new-chat-model-model"
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
          id="composer-new-chat-model-effort"
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
          id="composer-new-chat-model-permissions"
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
  </Chat>
</div>
