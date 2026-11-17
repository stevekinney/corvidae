<script lang="ts">
  import MenuBar from './menu-bar.svelte';
  import LocaleProvider from '@lostgradient/locale-provider/components/locale-provider/locale-provider.svelte';
  import type { TextDirection } from '@lostgradient/foundation/_internal/locale-context.ts';
  import { fileEditViewMenus } from './menu-bar-test-data.ts';

  let { providerDirection }: { providerDirection?: TextDirection } = $props();
</script>

{#if providerDirection}
  <LocaleProvider direction={providerDirection}>
    <MenuBar menus={fileEditViewMenus()} label="Application menu" />
  </LocaleProvider>
{:else}
  <MenuBar menus={fileEditViewMenus()} label="Application menu" />
{/if}
