<script lang="ts" module>
  export const title = 'New chat composer';
  export const description =
    'A new chat’s composer is one bordered surface: a ghost agent select with the agent’s avatar at the top, the text, then a control row with attach, a ghost Permissions select and a quiet Send that stays disabled until there is text. The hint sits under the surface.';
</script>

<script lang="ts">
  import { Chat, createConversation } from '@lostgradient/chat';
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
  const PERMISSIONS = [
    { value: 'always', label: 'Always asks', description: 'Every tool call asks first.' },
    {
      value: 'on-changes',
      label: 'On changes asks',
      description: 'Tools set to On changes ask before they run.',
    },
  ];
  let agent = $state('assistant');
  let permissions = $state('on-changes');

  const conversation = createConversation({ id: 'composer-new-chat' });
</script>

<div style="block-size: 20rem;">
  <Chat
    id="composer-new-chat"
    {conversation}
    surfaceMode="transparent"
    composerPlaceholder="Message Assistant…"
  >
    {#snippet composerHeader()}
      <Select
        id="composer-new-chat-agent"
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
    {#snippet composerControls()}
      <Select
        id="composer-new-chat-permissions"
        variant="ghost"
        presentation="listbox"
        size="sm"
        label="Permissions"
        labelVisible={false}
        valuePrefix="Permissions"
        options={PERMISSIONS}
        bind:value={permissions}
      />
    {/snippet}
  </Chat>
</div>
