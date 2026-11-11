<script lang="ts" module>
  export const title = 'Agent, activity, and paging';
  export const description =
    'Rows show the agent they are with and whether it is running or waiting on the user; the list loads more sessions as the user scrolls to its end.';
</script>

<script lang="ts">
  import { ChatConversationList, type ConversationSummary } from '@lostgradient/chat';

  const firstPage: ConversationSummary[] = [
    {
      id: 'migration',
      title: 'Migrate the billing job',
      status: 'active',
      messageCount: 18,
      unreadCount: 0,
      createdAt: '2026-06-01T08:00:00.000Z',
      updatedAt: '2026-06-01T08:45:00.000Z',
      lastMessageText: 'Running the dry run against staging.',
      lastMessageAt: '2026-06-01T08:45:00.000Z',
      participantNames: [],
      agent: { id: 'atlas', name: 'Atlas' },
      activity: 'running',
    },
    {
      id: 'review',
      title: 'Review the release notes',
      status: 'active',
      messageCount: 6,
      unreadCount: 1,
      createdAt: '2026-06-01T07:00:00.000Z',
      updatedAt: '2026-06-01T07:20:00.000Z',
      lastMessageText: 'Which of these should lead the post?',
      lastMessageAt: '2026-06-01T07:20:00.000Z',
      participantNames: [],
      agent: { id: 'scribe', name: 'Scribe' },
      activity: 'awaiting-input',
    },
    {
      id: 'triage',
      title: 'Triage overnight alerts',
      status: 'active',
      messageCount: 4,
      unreadCount: 0,
      createdAt: '2026-06-01T05:00:00.000Z',
      updatedAt: '2026-06-01T05:10:00.000Z',
      lastMessageText: 'Nothing needs paging.',
      lastMessageAt: '2026-06-01T05:10:00.000Z',
      participantNames: [],
      agent: { id: 'atlas', name: 'Atlas' },
      activity: 'idle',
    },
  ];

  let conversations = $state<ConversationSummary[]>(firstPage);
  let hasMore = $state(true);
  let loading = $state(false);

  async function loadNextPage(): Promise<void> {
    loading = true;
    await new Promise((resolve) => setTimeout(resolve, 400));
    conversations = [
      ...conversations,
      {
        id: 'older',
        title: 'Plan the quarter',
        status: 'active',
        messageCount: 9,
        unreadCount: 0,
        createdAt: '2026-05-30T09:00:00.000Z',
        updatedAt: '2026-05-30T09:30:00.000Z',
        lastMessageText: 'Here is the draft plan.',
        lastMessageAt: '2026-05-30T09:30:00.000Z',
        participantNames: [],
        agent: { id: 'scribe', name: 'Scribe' },
      },
    ];
    hasMore = false;
    loading = false;
  }
</script>

<div style="max-height: 18rem; display: grid;">
  <ChatConversationList
    {conversations}
    activeConversationId="migration"
    onSelectConversation={() => {}}
    {hasMore}
    {loading}
    onLoadMore={loadNextPage}
    buttonLabel="Show older sessions"
  />
</div>
