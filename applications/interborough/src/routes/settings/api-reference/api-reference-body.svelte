<script lang="ts">
  /**
   * The body of Settings › API reference (board PageSettingsSections, "API reference"; rows 50n to
   * 50t, 50y and 51e): the restart notice every section shares, and one Cinder tabs row that holds
   * the Operations, Discovery documents, Your scopes and Workflow sources tabs. The tabs are one
   * row under the heading, not a third navigation column, and the open one is the `group` search
   * parameter, so a tab is linked to and survives a reload. There is no key management: Interborough
   * is single-user for now.
   *
   * Each tab reads for itself, so the row stays live while one is loading, and one that fails does
   * not take the others with it.
   */
  import { CopyableValue, Tabs } from '@lostgradient/cinder';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { API_REFERENCE_COPY } from '../../../app/copy/api-reference.ts';
  import type { SettingsSchema, SettingsSnapshot } from '../../../lib/bureau-settings.ts';
  import { getClient } from '../../../lib/client.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import { discoveryOrigin } from '../../system/discovery-client.ts';
  import SettingsRestartNotice from '../settings-restart-notice.svelte';
  import { SettingsSession } from '../settings-session.svelte.ts';
  import {
    API_REFERENCE_GROUPS,
    groupFromSearch,
    groupLabel,
    groupPath,
    type ApiReferenceGroup,
  } from './api-reference-groups.ts';
  import DiscoveryPanel from './discovery-panel.svelte';
  import OperationsPanel from './operations-panel.svelte';
  import ScopesPanel from './scopes-panel.svelte';
  import SourcesPanel from './sources-panel.svelte';

  interface Props {
    schema: SettingsSchema;
    snapshot: SettingsSnapshot;
  }

  let { schema, snapshot }: Props = $props();

  // Where the API is: the origin this page was served from, plus `/api`.
  const apiAddress = `${discoveryOrigin(getClient())}/api`;

  const queryClient = useQueryClient();
  // The page edits no setting, but its restart notice counts, reverts and restarts the ones saved elsewhere.
  const session = new SettingsSession({
    schema: untrack(() => schema),
    snapshot: () => snapshot,
    queryClient,
  });

  const current = $derived(groupFromSearch(router.search));
  // `Tabs.value` is bindable and the URL owns the tab, so it starts from the URL and follows it.
  let active = $state<ApiReferenceGroup>(groupFromSearch(router.search));
  $effect(() => {
    if (current !== active) active = current;
  });

  function onTabChange(next: string): void {
    const group = API_REFERENCE_GROUPS.find((candidate) => candidate === next);
    if (group !== undefined && group !== current) router.navigate(groupPath(group));
  }
</script>

<SettingsRestartNotice
  keys={session.restartKeys}
  {snapshot}
  flow={session.restartFlow}
  revert={session.revert}
  saving={session.autosave.busy}
/>

<div class="ib-api-reference">
  <p class="ib-api-reference__address" data-testid="api-address">
    {API_REFERENCE_COPY.address.lead}
    <CopyableValue
      value={apiAddress}
      label={API_REFERENCE_COPY.address.copy}
      copiedLabel={API_REFERENCE_COPY.address.copied}
      data-testid="api-address-value"
    />
  </p>
  <Tabs
    bind:value={active}
    onValueChange={onTabChange}
    collapseLabel={API_REFERENCE_COPY.tabsLabel}
  >
    <Tabs.List label={API_REFERENCE_COPY.tabsLabel}>
      {#each API_REFERENCE_GROUPS as group (group)}
        <Tabs.Trigger value={group} data-group={group}>{groupLabel(group)}</Tabs.Trigger>
      {/each}
    </Tabs.List>
    <Tabs.Panel value="operations"><OperationsPanel /></Tabs.Panel>
    <Tabs.Panel value="discovery"><DiscoveryPanel /></Tabs.Panel>
    <Tabs.Panel value="scopes"><ScopesPanel /></Tabs.Panel>
    <Tabs.Panel value="sources"><SourcesPanel /></Tabs.Panel>
  </Tabs>
</div>

<style>
  .ib-api-reference {
    grid-area: content;
    max-inline-size: var(--ib-settings-content-width);
    min-inline-size: 0;
  }

  .ib-api-reference__address {
    margin: 0 0 var(--cinder-space-4);
    font-size: var(--cinder-text-sm);
    line-height: var(--cinder-leading-normal);
    color: var(--cinder-text-muted);
  }
</style>
