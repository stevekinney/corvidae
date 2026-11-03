<script lang="ts" module>
  export const title = 'Chat list: status on line two';
  export const description =
    'The chat list is a recorded exception because its pane is too narrow for a leading column: line one is the bold title with the time, and line two is the status in a fixed-width column, then a one-line preview, so previews line up.';
</script>

<script lang="ts">
  import {
    DataList,
    StackedListItem,
    StatusDot,
    type StatusDotWordLabel,
  } from '@lostgradient/cinder';

  type Chat = {
    id: string;
    title: string;
    status: StatusDotWordLabel;
    time: string;
    preview: string;
  };

  const chats: Chat[] = [
    {
      id: 'refund',
      title: 'Please refund order 4471, it arrived damaged.',
      status: 'Waiting on you',
      time: '10:42 AM',
      preview: 'I found order 4471 ($42.00). I need your approval to refund it.',
    },
    {
      id: 'hello',
      title: 'Say hello',
      status: 'Done',
      time: '4:12 PM',
      preview: 'Hello! How can I help?',
    },
    {
      id: 'billing',
      title: 'Rename the billing tables',
      status: 'Ended',
      time: '11:05 AM',
      preview: 'The server restarted while this chat was open.',
    },
  ];
</script>

<div style="max-width: 20rem;">
  <DataList items={chats} key={(chat) => chat.id} statusColumn>
    {#snippet children(chat)}
      <StackedListItem
        href={`#${chat.id}`}
        statusPlacement="line-two"
        titleLines={1}
        tooltip={chat.title}
      >
        {#snippet status()}<StatusDot word={chat.status} />{/snippet}
        {#snippet title()}{chat.title}{/snippet}
        {#snippet time()}{chat.time}{/snippet}
        {#snippet meta()}{chat.preview}{/snippet}
      </StackedListItem>
    {/snippet}
  </DataList>
</div>
