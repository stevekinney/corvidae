<script lang="ts">
  /**
   * System route (plan §9.7, T7.2–T7.6; design `Weft UI.dc.html`
   * "System" tab bar). Eight tabs, URL-owned via `?tab=` (plan §4: "URL owns
   * filter/pagination/tab state"). Each tab is named in words (COR-1658) while its `?tab=` value
   * stays what it was, so an address that links to one keeps working: `registry` is "Workflow
   * types" and `health` is "Health".
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

  const SYSTEM_TABS = [
    { value: 'registry', label: 'Workflow types' },
    { value: 'realms', label: 'Realms' },
    { value: 'metrics', label: 'Metrics' },
    { value: 'discovery', label: 'Discovery' },
    { value: 'operations', label: 'Operations' },
    { value: 'health', label: 'Health' },
    { value: 'alerts', label: 'Alerts' },
    { value: 'scopes', label: 'Scopes' },
  ] as const;

  type SystemTabValue = (typeof SYSTEM_TABS)[number]['value'];

  function isSystemTabValue(value: string): value is SystemTabValue {
    return SYSTEM_TABS.some((tab) => tab.value === value);
  }

  function currentTab(): SystemTabValue {
    const requested = router.search.get('tab');
    return requested && isSystemTabValue(requested) ? requested : 'registry';
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
    router.navigate(`/system?${params.toString()}`);
  }
</script>

<div class="weft-system-route">
  <h1 class="weft-system-route__title">System</h1>

  <Tabs bind:value={activeTab} onValueChange={onTabChange}>
    <Tabs.List label="System sections">
      {#each SYSTEM_TABS as tab (tab.value)}
        <Tabs.Trigger value={tab.value}>{tab.label}</Tabs.Trigger>
      {/each}
    </Tabs.List>

    <Tabs.Panel value="registry"><RegistryTab /></Tabs.Panel>
    <Tabs.Panel value="realms"><RealmsTab /></Tabs.Panel>
    <Tabs.Panel value="metrics"><MetricsTab /></Tabs.Panel>
    <Tabs.Panel value="discovery"><DiscoveryTab /></Tabs.Panel>
    <Tabs.Panel value="operations"><OperationsTab /></Tabs.Panel>
    <Tabs.Panel value="health"><HealthTab /></Tabs.Panel>
    <Tabs.Panel value="alerts"><AlertsTab /></Tabs.Panel>
    <Tabs.Panel value="scopes"><ScopePanel /></Tabs.Panel>
  </Tabs>
</div>

<style>
  .weft-system-route__title {
    margin: 0 0 12px;
    font-size: var(--cinder-text-xl);
    font-weight: 600;
  }
</style>
