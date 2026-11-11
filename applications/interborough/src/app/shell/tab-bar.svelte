<script lang="ts">
  /**
   * The phone's bottom tab bar (COR-2315): under 700px there is no sidebar, and this bar holds the
   * four places a thumb goes most (Home, Chat, Reviews and Runs, `TAB_BAR_VIEWS`) and a More tab
   * that opens the navigation drawer, which has every destination. Each tab is an icon over its
   * label; the current tab is an accent-coloured icon and label with no fill, which is Cinder's
   * bottom `NavigationBar`. It draws nothing at any other width, and nothing without the shell,
   * which owns the state that says which form the navigation takes (`./shell-navigation.svelte.ts`).
   */
  import { NavigationBar, NavigationItem } from '@lostgradient/cinder';
  import { Ellipsis } from '@lucide/svelte';

  import { router } from '../../lib/router.svelte.ts';
  import { NAVIGATION_COPY, VIEW_COPY } from '../copy.ts';
  import { DESTINATIONS, isActiveDestinationPath, TAB_BAR_VIEWS } from './destinations.ts';
  import { getShellNavigation } from './shell-navigation.svelte.ts';

  const shell = getShellNavigation();

  const tabs = TAB_BAR_VIEWS.map((view) => {
    const destination = DESTINATIONS.find((candidate) => candidate.view === view);
    if (destination === undefined) throw new Error(`The tab bar names no destination ${view}.`);
    return destination;
  });

  /** A tab opens its page without leaving the application, unless the click asks for a new tab. */
  function onTabClick(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
    shell?.close();
  }
</script>

{#if shell?.mode === 'drawer'}
  <NavigationBar placement="bottom" label={NAVIGATION_COPY.tabBar} class="weft-shell-tab-bar">
    {#snippet items({ variant })}
      {#each tabs as destination (destination.path)}
        {@const Icon = destination.icon}
        {@const label = VIEW_COPY[destination.view].label}
        <NavigationItem
          {variant}
          href={router.href(destination.path)}
          active={isActiveDestinationPath(router.pathname, destination.path)}
          onclick={(event) => onTabClick(event, destination.path)}
        >
          {#snippet icon()}<Icon aria-hidden="true" />{/snippet}
          {label}
        </NavigationItem>
      {/each}
      <NavigationItem
        {variant}
        aria-haspopup="dialog"
        aria-expanded={shell.drawerOpen}
        onclick={() => (shell.drawerOpen = !shell.drawerOpen)}
      >
        {#snippet icon()}<Ellipsis aria-hidden="true" />{/snippet}
        {NAVIGATION_COPY.moreTab}
      </NavigationItem>
    {/snippet}
  </NavigationBar>
{/if}
