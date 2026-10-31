<script lang="ts">
  /**
   * The navigation between the sections of Settings (`settings-sections.ts`). Every section renders
   * it above its own heading, so the sections read as one page of Settings with several parts.
   */
  import { Link } from '@lostgradient/cinder';

  import { SETTINGS_SECTION_COPY } from '../../app/copy.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { SETTINGS_SECTIONS } from './settings-sections.ts';

  function open(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<nav class="weft-settings-nav" aria-label={SETTINGS_SECTION_COPY.navigation}>
  {#each SETTINGS_SECTIONS as section (section.path)}
    <Link
      href={router.href(section.path)}
      aria-current={router.pathname === section.path ? 'page' : undefined}
      onclick={(event) => open(event, section.path)}>{section.label}</Link
    >
  {/each}
</nav>

<style>
  .weft-settings-nav {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-4);
    margin-bottom: var(--cinder-space-4);
    font-size: var(--cinder-text-sm);
  }

  .weft-settings-nav :global([aria-current='page']) {
    font-weight: 600;
  }
</style>
