<script lang="ts">
  /**
   * The tabs of what the System page held (plan §9.7, T7.2–T7.6), URL-owned via `?tab=` (plan §4:
   * "URL owns filter/pagination/tab state"). The System page was split by audience: Health carries
   * the metrics, alerts, lease and recovery (and Realms when the engine runs them), and Settings ›
   * API reference carries the workflow types, discovery documents, operations and scopes. Each page
   * renders this component with the tabs it owns and the path they live at. Each tab is named in
   * words (COR-1658) while its `?tab=` value stays what it was, so an address that links to one
   * keeps working: `registry` is "Workflow types" and `health` is "Health".
   */
  import { Tabs } from '@lostgradient/cinder';

  import { router } from '../../lib/router.svelte.ts';
  import AlertsTab from './alerts-tab.svelte';
  import DiscoveryTab from './discovery-tab.svelte';
  import HealthTab from './health-tab.svelte';
  import MetricsTab from './metrics-tab.svelte';
  import OperationsTab from './operations-tab.svelte';
  import RealmsTab from './realms-tab.svelte';
  import RegistryTab from './registry-tab.svelte';
  import ScopePanel from './scope-panel.svelte';
  import { SYSTEM_TABS, type SystemTabValue } from './system-tabs.ts';

  interface Props {
    /** The tabs this page carries, in order. The first is the one an unknown `?tab=` opens. */
    tabs: readonly SystemTabValue[];
    /** The page's path, where a tab change navigates. */
    path: string;
    /** The tab list's accessible name. */
    label: string;
  }

  let { tabs, path, label }: Props = $props();

  function currentTab(): SystemTabValue {
    const requested = router.search.get('tab');
    const found = tabs.find((tab) => tab === requested);
    return found ?? tabs[0] ?? 'registry';
  }

  // `Tabs.value` is a `$bindable` prop — `bind:value` gives the child full
  // local control over the active tab (required for its own click/keyboard
  // handling to actually take effect; a one-way `value={expression}` prop
  // is read once and never re-driven by user interaction, verified
  // empirically against `tabs.svelte`'s `commitValue` usage). `activeTab`
  // starts from the URL and this `$effect` re-syncs it whenever the URL
  // changes from OUTSIDE this component (e.g. a deep link, browser back) —
  // `onValueChange` below is the other direction, URL following the tab.
  let activeTab = $state<SystemTabValue>(currentTab());

  $effect(() => {
    const fromUrl = currentTab();
    if (fromUrl !== activeTab) activeTab = fromUrl;
  });

  function onTabChange(next: string): void {
    const params = new URLSearchParams(router.search);
    params.set('tab', next);
    router.navigate(`${path}?${params.toString()}`);
  }
</script>

<div class="weft-system-route">
  <Tabs bind:value={activeTab} onValueChange={onTabChange}>
    <Tabs.List {label}>
      {#each tabs as value (value)}
        <Tabs.Trigger {value}>{SYSTEM_TABS[value]}</Tabs.Trigger>
      {/each}
    </Tabs.List>

    {#if tabs.includes('registry')}<Tabs.Panel value="registry"><RegistryTab /></Tabs.Panel>{/if}
    {#if tabs.includes('realms')}<Tabs.Panel value="realms"><RealmsTab /></Tabs.Panel>{/if}
    {#if tabs.includes('metrics')}<Tabs.Panel value="metrics"><MetricsTab /></Tabs.Panel>{/if}
    {#if tabs.includes('discovery')}<Tabs.Panel value="discovery"><DiscoveryTab /></Tabs.Panel>{/if}
    {#if tabs.includes('operations')}
      <Tabs.Panel value="operations"><OperationsTab /></Tabs.Panel>
    {/if}
    {#if tabs.includes('health')}<Tabs.Panel value="health"><HealthTab /></Tabs.Panel>{/if}
    {#if tabs.includes('alerts')}<Tabs.Panel value="alerts"><AlertsTab /></Tabs.Panel>{/if}
    {#if tabs.includes('scopes')}<Tabs.Panel value="scopes"><ScopePanel /></Tabs.Panel>{/if}
  </Tabs>
</div>
