<script lang="ts">
  /**
   * Test-only page that renders an open chat under the shell's top bar, which is where the chat's
   * breadcrumb and its details popover are drawn: both come from the page through the breadcrumb
   * registry. Never imported by production code.
   */
  import { untrack } from 'svelte';

  import { QueryClientProvider } from '@tanstack/svelte-query';

  import { LayoutPreferences } from '../../app/layout-preferences.svelte.ts';
  import { memoryStore } from '../../app/notification-store.test-support.ts';
  import {
    provideShellNavigation,
    ShellNavigation,
  } from '../../app/shell/shell-navigation.svelte.ts';
  import Topbar from '../../app/shell/topbar.svelte';
  import { ThemeStore } from '../../app/theme.svelte.ts';
  import { createQueryClient } from '../../lib/query.ts';
  import ChatConversation from './chat-conversation.svelte';

  interface ChatPageHarnessProps {
    sessionId: string;
    title: string | null;
    agentName: string;
    isNew?: boolean;
  }

  let { sessionId, title, agentName, isNew = false }: ChatPageHarnessProps = $props();

  const layout = new LayoutPreferences(window.localStorage);
  provideShellNavigation(new ShellNavigation(layout));
  const theme = new ThemeStore(document.documentElement, window.localStorage);
  const notifications = memoryStore();
  const client = untrack(() => createQueryClient());
  let paletteOpen = $state(false);
</script>

<QueryClientProvider {client}>
  <Topbar {notifications} {theme} {layout} bind:paletteOpen />
  <ChatConversation {sessionId} {title} {agentName} {isNew} />
</QueryClientProvider>
