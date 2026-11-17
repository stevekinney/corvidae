<script lang="ts">
  import { untrack } from 'svelte';
  import { Toggle } from './index.ts';

  type FixtureProps = {
    checked?: boolean;
  };

  let { checked = false }: FixtureProps = $props();
  let enabled = $state(untrack(() => checked));
</script>

<div class="toggle-fixture">
  <Toggle id="visual-fixture-toggle" bind:checked={enabled} label="Email notifications" />
</div>

<style>
  .toggle-fixture {
    min-block-size: 4rem;
  }
</style>
