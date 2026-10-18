<script lang="ts">
  /**
   * The route for a view a later issue builds. The view frame decides a placeholder view is empty
   * whenever the service behind it answers (`app/view-frame.svelte`), so this content shows only if
   * a probe ever reports something to list before the view exists.
   */
  import { VIEW_COPY } from '../../app/copy.ts';
  import { router } from '../../lib/router.svelte.ts';

  const view = $derived(router.current.route?.view);
  const label = $derived(view === undefined ? 'This view' : VIEW_COPY[view].label);
</script>

<h1 class="weft-view__loading-title">{label}</h1>
<p>{label} is not built yet.</p>
