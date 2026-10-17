<script lang="ts">
  import { ChatConversationList, type ConversationSummary } from '@lostgradient/chat';

  const conversations: ConversationSummary[] = [
    {
      id: 'launch',
      title: 'Launch support',
      status: 'active',
      messageCount: 12,
      unreadCount: 2,
      createdAt: '2026-06-01T08:00:00.000Z',
      updatedAt: '2026-06-01T08:45:00.000Z',
      lastMessageId: 'launch-last',
      lastMessageRole: 'assistant',
      lastMessageText: 'I drafted the launch checklist.',
      lastMessageAt: '2026-06-01T08:45:00.000Z',
      participantNames: ['Ada', 'Grace'],
      agent: { id: 'atlas', name: 'Atlas' },
      activity: 'running',
    },
    {
      id: 'billing',
      title: 'Billing question',
      status: 'active',
      messageCount: 4,
      unreadCount: 0,
      createdAt: '2026-06-01T07:00:00.000Z',
      updatedAt: '2026-06-01T07:20:00.000Z',
      lastMessageId: 'billing-last',
      lastMessageRole: 'user',
      lastMessageText: 'Can you resend the invoice?',
      lastMessageAt: '2026-06-01T07:20:00.000Z',
      participantNames: ['Lin'],
      agent: { id: 'scribe', name: 'Scribe' },
      activity: 'awaiting-input',
    },
    {
      id: 'research',
      title: 'Research notes',
      status: 'active',
      messageCount: 2,
      unreadCount: 0,
      createdAt: '2026-06-01T05:00:00.000Z',
      updatedAt: '2026-06-01T05:10:00.000Z',
      lastMessageId: 'research-last',
      lastMessageRole: 'assistant',
      lastMessageText: 'Nothing new since yesterday.',
      lastMessageAt: '2026-06-01T05:10:00.000Z',
      participantNames: [],
      agent: { id: 'atlas', name: 'Atlas' },
      activity: 'idle',
    },
  ];
</script>

<div style="max-block-size: 20rem;">
  <ChatConversationList
    {conversations}
    activeConversationId="launch"
    onSelectConversation={() => {}}
    hasMore
    onLoadMore={async () => {}}
  />
</div>
