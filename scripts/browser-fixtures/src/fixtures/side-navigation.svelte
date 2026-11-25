<script lang="ts">
  import { GitBranch, NavigationItem, Pencil, SideNavigation } from '@lostgradient/cinder';

  type FixtureProps = {
    active?: string;
    projectsExpanded?: boolean;
  };

  let { active = 'phoenix', projectsExpanded = true }: FixtureProps = $props();

  // COR-2665: disabled rows that say why on a second line, drawn only behind a query parameter so
  // the default fixture, its baselines and its axe sweep stay as they are.
  const disabledRows = new URLSearchParams(globalThis.location.search).get('disabled') === '1';
</script>

{#if disabledRows}
  <div id="example-mount-disabled" class="side-navigation-fixture">
    <SideNavigation ariaLabel="Temporal pages">
      <SideNavigation.Item href="/workflows" label="Workflows">Workflows</SideNavigation.Item>
      <SideNavigation.Item disabled label="Task queue" disabledReason="Open a task queue first">
        Task queue
      </SideNavigation.Item>
      <SideNavigation.Item disabled label="Schedules">Schedules</SideNavigation.Item>
      <SideNavigation.Item href="/deployments" label="Deployments">
        {#snippet icon()}<GitBranch aria-hidden="true" size={16} />{/snippet}
        Deployments
      </SideNavigation.Item>
      <SideNavigation.Item
        disabled
        label="Workers"
        disabledReason="Open a task queue to see the workers polling it"
      >
        {#snippet icon()}<Pencil aria-hidden="true" size={16} />{/snippet}
        Workers
      </SideNavigation.Item>
    </SideNavigation>
    <SideNavigation ariaLabel="Shared reason">
      <SideNavigation.Group label="Connection" disabledReason="Choose a connection first">
        <SideNavigation.Item disabled label="Namespaces">Namespaces</SideNavigation.Item>
        <SideNavigation.Item disabled label="Workflows">Workflows</SideNavigation.Item>
      </SideNavigation.Group>
    </SideNavigation>
  </div>
{/if}

<div id="example-mount-basic" class="side-navigation-fixture">
  <SideNavigation ariaLabel="Workspace">
    <SideNavigation.Item href="/dashboard" active={active === 'dashboard'}>
      Dashboard
    </SideNavigation.Item>
    <SideNavigation.Group label="Projects" bind:expanded={projectsExpanded}>
      <SideNavigation.Item href="/projects/phoenix" active={active === 'phoenix'}>
        Phoenix
      </SideNavigation.Item>
      <SideNavigation.Item href="/projects/atlas" active={active === 'atlas'}>
        Atlas
      </SideNavigation.Item>
      {#if projectsExpanded}
        <SideNavigation.Item href="/projects/beacon" active={active === 'beacon'}>
          Beacon
        </SideNavigation.Item>
      {/if}
    </SideNavigation.Group>
    <SideNavigation.Group label="Settings">
      <SideNavigation.Item href="/settings/team">Team</SideNavigation.Item>
      <SideNavigation.Item href="/settings/billing" hidden>Billing</SideNavigation.Item>
    </SideNavigation.Group>
  </SideNavigation>

  <nav aria-label="Standalone entries">
    <NavigationItem href="/standalone/first">Standalone first</NavigationItem>
    {#if projectsExpanded}
      <NavigationItem href="/standalone/second">Standalone second</NavigationItem>
    {/if}
    <NavigationItem href="/standalone/hidden" hidden>Standalone hidden</NavigationItem>
  </nav>
</div>

<style>
  .side-navigation-fixture {
    inline-size: 18rem;
  }
</style>
