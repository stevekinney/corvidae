<script lang="ts">
  /**
   * The not-found page (design rows 12x and 12y): Cinder's not-found empty state (a neutral disc
   * with a search glyph), a title that names the missing thing, the shared sentence, and two
   * secondary buttons, one back to the list the thing belonged to and one that opens search. There
   * is no primary button. The breadcrumb reads the missing thing as "Not found" in words, so the
   * trail is Runs › Not found. A view whose missing thing has a natural next step passes `create`
   * and `back` (the chat page, board ChatStates frame g): an accent disc with an inbox, a primary
   * button that starts the thing again and a secondary way back, and no search button.
   */
  import { Button, EmptyState } from '@lostgradient/cinder';
  import { Inbox, SquarePen } from '@lucide/svelte';

  import { router } from '../lib/router.svelte.ts';
  import { usePageLabel } from './breadcrumbs.svelte.ts';
  import { NOT_FOUND_COPY, type ViewLink } from './copy.ts';
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
    /** A primary button that starts the thing again, such as New chat. */
    create?: ViewLink | undefined;
    /** The way back in the view's own words, such as "Back to chats". The view's list when omitted. */
    back?: ViewLink | undefined;
    /** Whether the "Search everything" button is drawn. Defaults to true. */
    search?: boolean;
  }

  let {
    title,
    description = NOT_FOUND_COPY.description,
    view = 'home',
    create,
    back,
    search = true,
  }: NotFoundStateProps = $props();

  const parent = $derived(
    back === undefined ? viewParent(view) : { label: back.label, path: back.href },
  );
  const openSearch = getSearchOpener();

  usePageLabel(() => ({ path: router.pathname, label: NOT_FOUND_COPY.breadcrumb }));

  /** Opens `path` in place, unless the person asked for a new tab or window. */
  function follow(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<EmptyState
  class="weft-view__empty"
  kind={create === undefined ? 'not-found' : 'first-use'}
  {title}
  {description}
  headingLevel={1}
  {...create === undefined ? {} : { icon: disc }}
>
  {#snippet action()}
    {#if create !== undefined}
      <Button
        variant="primary"
        href={router.href(create.href)}
        onclick={(event) => follow(event, create.href)}
      >
        {#snippet leadingIcon()}<SquarePen class="cinder-icon-sm" aria-hidden="true" />{/snippet}
        {create.label}
      </Button>
      <Button
        variant="secondary"
        href={router.href(parent.path)}
        onclick={(event) => follow(event, parent.path)}
      >
        {back?.label ?? NOT_FOUND_COPY.back(parent.label)}
      </Button>
    {:else}
      <Button
        variant="secondary"
        href={router.href(parent.path)}
        onclick={(event) => follow(event, parent.path)}
      >
        {NOT_FOUND_COPY.back(parent.label)}
      </Button>
      {#if search}
        <Button variant="secondary" onclick={() => openSearch?.()}>{NOT_FOUND_COPY.search}</Button>
      {/if}
    {/if}
  {/snippet}
</EmptyState>

{#snippet disc()}
  <Inbox aria-hidden="true" />
{/snippet}
