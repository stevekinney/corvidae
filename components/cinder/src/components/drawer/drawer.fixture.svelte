<script lang="ts">
  import { untrack } from 'svelte';
  import { Button } from '../button/index.ts';
  import { Drawer } from './index.ts';

  type FixtureProps = {
    open?: boolean;
    modal?: boolean;
  };

  let { open = true, modal = true }: FixtureProps = $props();
  let drawerOpen = $state(untrack(() => open));
</script>

<div class="drawer-fixture">
  <p>The page behind the drawer stays readable and interactive when the drawer is not modal.</p>

  <Drawer bind:open={drawerOpen} {modal} title="Run details" size="sm">
    <p>Status, owner, and the latest checkpoint for this run.</p>

    {#snippet footer()}
      <Button variant="secondary" label="Close" onclick={() => (drawerOpen = false)} />
    {/snippet}
  </Drawer>
</div>

<style>
  .drawer-fixture {
    min-block-size: 20rem;
    padding: 1rem;
  }
</style>
