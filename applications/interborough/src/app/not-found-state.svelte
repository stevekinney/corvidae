<script lang="ts">
  /**
   * The not-found page (design rows 12x and 12y): Cinder's not-found empty state (a neutral disc
   * with a search glyph), a title that names the missing thing, the shared sentence, and two
   * secondary buttons, one back to the list the thing belonged to and one that opens search. There
   * is no primary button. The breadcrumb reads the missing thing as "Not found" in words, so the
   * trail is Runs › Not found.
   */
  import { Button, EmptyState } from '@lostgradient/cinder';

  import { router } from '../lib/router.svelte.ts';
  import { usePageLabel } from './breadcrumbs.svelte.ts';
  import { NOT_FOUND_COPY } from './copy.ts';
  import { getSearchOpener } from './shell/search-opener.ts';
  import { viewParent } from './view-parent.ts';
  import type { ViewName } from './views.ts';

  interface NotFoundStateProps {
    /** Names the missing thing: "This run doesn’t exist". */
    title: string;
    /** Says why it may be gone. The shared sentence when omitted. */
    description?: string;
    /** The view the missing thing belonged to, which "Back to …" returns to. Home when omitted. */
    view?: ViewName;
  }

  let {
    title,
    description = NOT_FOUND_COPY.description,
    view = 'home',
  }: NotFoundStateProps = $props();

  const parent = $derived(viewParent(view));
  const openSearch = getSearchOpener();

  usePageLabel(() => ({ path: router.pathname, label: NOT_FOUND_COPY.breadcrumb }));

  function goBack(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(parent.path);
  }
</script>

<EmptyState class="weft-view__empty" kind="not-found" {title} {description} headingLevel={1}>
  {#snippet action()}
    <Button variant="secondary" href={router.href(parent.path)} onclick={goBack}>
      {NOT_FOUND_COPY.back(parent.label)}
    </Button>
    <Button variant="secondary" onclick={() => openSearch?.()}>{NOT_FOUND_COPY.search}</Button>
  {/snippet}
</EmptyState>
