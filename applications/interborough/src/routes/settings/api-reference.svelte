<script lang="ts">
  /**
   * `/settings/api-reference`: what the server exposes and what the caller may do with it, as one
   * page with a side list of four groups: the operations, the discovery documents, the caller's
   * scopes, and the workflow sources (the registered workflow types and the dynamic sources). The
   * open group is the `group` search parameter, so a group is linked to and survives a reload.
   */
  import { SideNavigation, SideNavigationItem } from '@lostgradient/cinder';

  import { API_REFERENCE_COPY, SETTINGS_SECTION_COPY } from '../../app/copy.ts';
  import { router } from '../../lib/router.svelte.ts';
  import DiscoveryTab from '../system/discovery-tab.svelte';
  import OperationsTab from '../system/operations-tab.svelte';
  import RegistryTab from '../system/registry-tab.svelte';
  import ScopePanel from '../system/scope-panel.svelte';
  import {
    API_REFERENCE_GROUPS,
    groupFromSearch,
    groupLabel,
    groupPath,
    type ApiReferenceGroup,
  } from './api-reference-groups.ts';
  import SettingsSectionNav from './settings-section-nav.svelte';

  const current = $derived(groupFromSearch(router.search));

  function open(event: MouseEvent, group: ApiReferenceGroup): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(groupPath(group));
  }
</script>

<section class="weft-settings-section" data-page="settings-api-reference">
  <SettingsSectionNav />
  <h1 class="weft-settings-section__title">{SETTINGS_SECTION_COPY.apiReference}</h1>

  <div class="weft-api-reference">
    <SideNavigation ariaLabel={API_REFERENCE_COPY.groupsLabel} class="weft-api-reference__list">
      {#each API_REFERENCE_GROUPS as group (group)}
        <SideNavigationItem
          href={router.href(groupPath(group))}
          active={group === current}
          data-group={group}
          onclick={(event) => open(event, group)}
        >
          {groupLabel(group)}
        </SideNavigationItem>
      {/each}
    </SideNavigation>

    <div class="weft-api-reference__group" data-group-panel={current}>
      {#if current === 'operations'}
        <OperationsTab />
      {:else if current === 'discovery'}
        <DiscoveryTab />
      {:else if current === 'scopes'}
        <ScopePanel />
      {:else}
        <RegistryTab />
      {/if}
    </div>
  </div>
</section>

<style>
  .weft-settings-section__title {
    margin: 0 0 var(--cinder-space-3);
    font-size: var(--cinder-text-xl);
    font-weight: 600;
  }

  .weft-api-reference {
    display: grid;
    grid-template-columns: minmax(0, 14rem) minmax(0, 1fr);
    gap: var(--cinder-space-6);
    align-items: start;
  }

  .weft-api-reference__group {
    min-width: 0;
  }

  /* Below a tablet the list sits above the group instead of beside it. */
  @media (max-width: 900px) {
    .weft-api-reference {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--cinder-space-4);
    }
  }
</style>
