<script lang="ts">
  /**
   * The navigation between the sections of Settings (`settings-sections.ts`), beside the content as
   * a 170px column from 640px up and a "Section" select above it below that, its "Section" label
   * showing (design rows 05f, 06s, 06u, 47a, 47s). Every section renders it, so the sections read
   * as one page of Settings with several parts.
   */
  import { Select, SideNavigation } from '@lostgradient/cinder';
  import { MediaQuery } from 'svelte/reactivity';

  import { SETTINGS_COPY, SETTINGS_SECTION_COPY } from '../../app/copy/settings.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { SETTINGS_SECTIONS } from './settings-sections.ts';

  /** Whether the column fits beside the content: 640px and wider. */
  const wide = new MediaQuery('(min-width: 40rem)', true);

  let { documentPath }: { documentPath?: string | undefined } = $props();

  function documentRoute(path: string): boolean {
    return (
      documentPath !== undefined ||
      ['/settings/api-keys', '/settings/connected-apps'].includes(path)
    );
  }

  function select(path: string): void {
    if (documentRoute(path)) window.location.assign(path);
    else router.navigate(path);
  }

  const pathname = $derived(documentPath ?? router.pathname);
  const current = $derived(
    SETTINGS_SECTIONS.find((section) => section.path === pathname)?.path ??
      SETTINGS_SECTIONS[0]?.path ??
      '/settings',
  );
</script>

{#if wide.current}
  <SideNavigation ariaLabel={SETTINGS_SECTION_COPY.navigation} class="weft-settings-nav">
    {#each SETTINGS_SECTIONS as section (section.path)}
      <SideNavigation.Item
        href={router.href(section.path)}
        active={pathname === section.path}
        data-velveteen-reload={documentRoute(section.path) ? '' : undefined}
        >{section.label}</SideNavigation.Item
      >
    {/each}
  </SideNavigation>
{:else}
  <div class="weft-settings-section-select">
    <Select
      id="weft-settings-section"
      label={SETTINGS_COPY.sectionSelect}
      value={current}
      options={SETTINGS_SECTIONS.map((section) => ({ value: section.path, label: section.label }))}
      onchange={(event) => select(event.currentTarget.value)}
    />
  </div>
{/if}

<style>
  .weft-settings-section-select {
    min-inline-size: 0;
  }
</style>
