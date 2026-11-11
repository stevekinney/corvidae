<script lang="ts">
  /**
   * Test-only page that renders the phone's tab bar under the shell's navigation state, which says
   * whether it is on screen and which the More tab opens the drawer through. Never imported by
   * production code.
   */
  import { untrack } from 'svelte';

  import { provideShellNavigation, type ShellNavigation } from './shell-navigation.svelte.ts';
  import TabBar from './tab-bar.svelte';

  interface TabBarHarnessProps {
    navigation: ShellNavigation;
  }

  let { navigation }: TabBarHarnessProps = $props();

  provideShellNavigation(untrack(() => navigation));
</script>

<TabBar />
