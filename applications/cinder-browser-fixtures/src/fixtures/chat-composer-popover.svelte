<script lang="ts">
  import {
    ChatComposerPopover,
    type ChatComposerPopoverSelection,
    Chat,
    createConversation,
  } from '@repo/chat';

  type SlashCommand = {
    value: string;
    label: string;
    description: string;
    insert: string;
    keywords?: string[];
  };

  const commands: SlashCommand[] = [
    {
      value: 'help',
      label: 'Help',
      description: 'Show available assistant commands',
      insert: '/help ',
      keywords: ['docs', 'support'],
    },
    {
      value: 'new',
      label: 'New conversation',
      description: 'Start a fresh thread',
      insert: '/new ',
      keywords: ['reset', 'fresh'],
    },
    {
      value: 'tools',
      label: 'Tools',
      description: 'Open tool controls',
      insert: '/tools ',
      keywords: ['integrations', 'actions'],
    },
    {
      value: 'stop',
      label: 'Stop',
      description: 'Stop the current response',
      insert: '/stop',
      keywords: ['cancel', 'halt'],
    },
  ];

  let value = $state('');
  let selectedCommand = $state('None');
  let chat: ReturnType<typeof Chat> | undefined;
  const conversation = createConversation({ id: 'composer-popover-example' });

  function handleSelect(selection: ChatComposerPopoverSelection<SlashCommand>) {
    chat?.insertAtRange(selection.range, selection.item.insert);
    selectedCommand = selection.item.label;
  }
</script>

<ChatComposerPopover id="slash-command" bind:value items={commands} onSelect={handleSelect}>
  {#snippet composer(composerProps)}
    <div style="height: 28rem;">
      <Chat
        bind:this={chat}
        id="chat"
        {conversation}
        capabilities={{ attachments: false }}
        composerRole={composerProps.composerRole}
        composerAriaExpanded={composerProps.composerAriaExpanded}
        composerAriaControls={composerProps.composerAriaControls}
        composerAriaActiveDescendant={composerProps.composerAriaActiveDescendant}
        composerAriaAutocomplete={composerProps.composerAriaAutocomplete}
        oncomposerinput={composerProps.oncomposerinput}
        oncomposerkeydown={composerProps.oncomposerkeydown}
        oncomposerselectionchange={composerProps.oncomposerselectionchange}
        oncomposerblur={composerProps.oncomposerblur}
      />
    </div>
  {/snippet}
</ChatComposerPopover>

<p>Selected: {selectedCommand}</p>
