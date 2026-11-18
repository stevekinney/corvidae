<script lang="ts" module>
  export const title = 'Trailing actions that collapse on a phone';
  export const description =
    'Text actions at the end of a row are secondary buttons on a tablet or desktop and one More actions menu below 640px. A disabled action stays focusable and keeps its reason.';
</script>

<script lang="ts">
  import { DataList, StackedListItem } from '@lostgradient/cinder';

  const agents = [
    {
      name: 'Assistant',
      chats: '12 chats, Answers questions and does general work',
      canChat: true,
    },
    {
      name: 'Release helper',
      chats: '0 chats, Held back while its plugin is disabled',
      canChat: false,
    },
  ];
</script>

<DataList items={agents} key={(agent) => agent.name}>
  {#snippet children(agent)}
    <StackedListItem
      actions={[
        { label: 'Memory', href: '#memory' },
        {
          label: 'New chat',
          href: '#new-chat',
          disabled: !agent.canChat,
          disabledReason: 'Connect a provider to start a chat',
        },
      ]}
    >
      {#snippet title()}{agent.name}{/snippet}
      {#snippet meta()}{agent.chats}{/snippet}
    </StackedListItem>
  {/snippet}
</DataList>
