<script lang="ts">
  /**
   * The route for `/agents/new` (no `id`) and `/agents/:agent/edit`. The outlet keys a route by its
   * path, so each address mounts a page of its own.
   */
  import { router } from '../../lib/router.svelte.ts';
  import AgentEditorPage from './agent-editor-page.svelte';

  const id = $derived(router.current.params['agent']);
</script>

<AgentEditorPage {id} />
