<script lang="ts">
  /**
   * The route for `/hooks`, `/hooks/new` and `/hooks/:hook`. The outlet keys a route by its path, so
   * each address mounts a page of its own, and the pattern says which: the list, or the editor that
   * makes a hook or changes one.
   */
  import { router } from '../../lib/router.svelte.ts';
  import HookEditor from './hook-editor.svelte';
  import HookList from './hook-list.svelte';

  const pattern = $derived(router.current.route?.pattern);
</script>

{#if pattern === '/hooks/new' || pattern === '/hooks/:hook'}
  <HookEditor />
{:else}
  <HookList />
{/if}
