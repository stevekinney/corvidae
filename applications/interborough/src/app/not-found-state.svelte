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
  import { Button, EmptyState, ErrorState } from '@lostgradient/cinder';
  import { Inbox, SquarePen } from '@lucide/svelte';

  import { router } from '../lib/router.svelte.ts';
  import { usePageLabel } from './breadcrumbs.svelte.ts';
  import { NOT_FOUND_COPY, type ViewLink } from './copy/views.ts';
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
    /**
     * The way back in the view's own words, such as "Back to chats" or "Open Plugins", which is the
     * button's whole label. The view's list when omitted.
     */
    back?: ViewLink | undefined;
    /** Whether the "Search everything" button is drawn. Defaults to true. */
    search?: boolean;
    /** Render the neutral error presentation for a route whose design uses it. */
    neutralError?: boolean;
  }

  let {
    title,
    description = NOT_FOUND_COPY.description,
    view = 'home',
    create,
    back,
    search = true,
    neutralError = false,
  }: NotFoundStateProps = $props();

  const parent = $derived(
    back === undefined ? viewParent(view) : { label: back.label, path: back.href },
  );
  const openSearch = getSearchOpener();

  usePageLabel(() => ({ path: router.pathname, label: NOT_FOUND_COPY.breadcrumb }));
</script>

{#snippet actions()}
  {#if create !== undefined}
    <Button variant="primary" href={router.href(create.href)}>
      {#snippet leadingIcon()}<SquarePen class="cinder-icon-sm" aria-hidden="true" />{/snippet}
      {create.label}
    </Button>
  {/if}
  <Button variant="secondary" href={router.href(parent.path)}>
    {back?.label ?? NOT_FOUND_COPY.back(parent.label)}
  </Button>
  {#if create === undefined && search}
    <Button variant="secondary" onclick={() => openSearch?.()}>{NOT_FOUND_COPY.search}</Button>
  {/if}
{/snippet}

{#if neutralError}
  <ErrorState {title} {description} headingLevel={1} tone="neutral" secondaryAction={actions} />
{:else}
  <EmptyState
    kind={create === undefined ? 'not-found' : 'first-use'}
    {title}
    {description}
    headingLevel={1}
    action={actions}
    {...create === undefined ? {} : { icon: disc }}
  />
{/if}

{#snippet disc()}
  <Inbox aria-hidden="true" />
{/snippet}
