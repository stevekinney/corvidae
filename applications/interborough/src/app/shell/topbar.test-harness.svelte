<script lang="ts">
  /**
   * Test-only page that renders the top bar under the shell's navigation state, which the menu
   * button reads. Never imported by production code.
   */
  import { untrack } from 'svelte';

  import type { LayoutPreferences } from '../layout-preferences.svelte.ts';
  import type { NotificationStore } from '../notifications.svelte.ts';
  import type { ThemeStore } from '../theme.svelte.ts';
  import { provideShellNavigation, type ShellNavigation } from './shell-navigation.svelte.ts';
  import Topbar from './topbar.svelte';

  interface TopbarHarnessProps {
    navigation: ShellNavigation;
    notifications: NotificationStore;
    theme: ThemeStore;
    layout: LayoutPreferences;
  }

  let { navigation, notifications, theme, layout }: TopbarHarnessProps = $props();

  provideShellNavigation(untrack(() => navigation));
  let paletteOpen = $state(false);
</script>

<Topbar {notifications} {theme} {layout} bind:paletteOpen />
<output data-testid="palette-open">{paletteOpen}</output>
