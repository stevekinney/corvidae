<script lang="ts" module>
  export const title = 'Counts, dot and icon rail';
  export const description =
    'A row can carry a count pill or a status dot, and its accessible name carries the count ("Health, 3 need attention") so colour is never the only signal. Collapsed to an icon rail, the label leaves the screen, stays in the name, and appears in a tooltip.';
</script>

<script lang="ts">
  import { Activity, ClipboardCheck, House } from '@lucide/svelte';
  import { Sidebar, SideNavigation } from '@lostgradient/cinder';
</script>

{#snippet rows()}
  <SideNavigation ariaLabel="Views">
    <SideNavigation.Item href="#home" label="Home">
      {#snippet icon()}<House size={16} />{/snippet}
      Home
    </SideNavigation.Item>
    <SideNavigation.Item href="#reviews" label="Reviews" count={2} countLabel="need you" active>
      {#snippet icon()}<ClipboardCheck size={16} />{/snippet}
      Reviews
    </SideNavigation.Item>
    <SideNavigation.Item
      href="#health"
      label="Health"
      count={3}
      countLabel="need attention"
      dot="warning"
    >
      {#snippet icon()}<Activity size={16} />{/snippet}
      Health
    </SideNavigation.Item>
  </SideNavigation>
{/snippet}

<div style="display: flex; gap: var(--cinder-space-6); align-items: flex-start;">
  <div style="inline-size: 14rem;">
    <Sidebar label="Workspace">
      {#snippet navigation()}{@render rows()}{/snippet}
    </Sidebar>
  </div>
  <div style="inline-size: 4rem;">
    <Sidebar label="Workspace rail" collapsed>
      {#snippet navigation()}{@render rows()}{/snippet}
    </Sidebar>
  </div>
</div>
