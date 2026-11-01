<script lang="ts">
  /**
   * Test-only page that connects a notification store to the Bureau the way the shell does, below a
   * query client (`../routes/chat/query-page.test-harness.svelte` supplies it). Never imported by
   * production code.
   */
  import { untrack } from 'svelte';

  import { connectNotificationFeed } from './notification-feed.svelte.ts';
  import type { NotificationStore } from './notifications.svelte.ts';

  interface NotificationFeedHarnessProps {
    store: NotificationStore;
    /** Whether the principal may read schedules. Allowed when omitted. */
    canReadSchedules?: boolean;
  }

  let { store, canReadSchedules = true }: NotificationFeedHarnessProps = $props();

  connectNotificationFeed(
    untrack(() => store),
    { canReadSchedules: () => canReadSchedules },
  );
</script>
