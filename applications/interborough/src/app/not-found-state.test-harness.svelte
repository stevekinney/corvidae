<script lang="ts">
  /**
   * Test-only page that mounts the not-found page the way the shell does: with the function that
   * opens the search palette provided, and the breadcrumb trail for the address it is on. Never
   * imported by production code.
   */
  import { router } from '../lib/router.svelte.ts';
  import { breadcrumbTrail } from './breadcrumbs.svelte.ts';
  import type { ViewLink } from './copy.ts';
  import NotFoundState from './not-found-state.svelte';
  import { provideSearchOpener } from './shell/search-opener.ts';
  import type { ViewName } from './views.ts';

  interface NotFoundHarnessProps {
    title: string;
    view?: ViewName;
    /** A primary button that starts the thing again, as the chat page's New chat. */
    create?: ViewLink;
    /** The way back in the view's own words. */
    back?: ViewLink;
    /** Whether the page offers "Search everything". Defaults to true. */
    search?: boolean;
    /** Called when the page asks to open search. When omitted, the page is mounted without a shell. */
    onSearch?: () => void;
  }

  let { title, view, create, back, search, onSearch }: NotFoundHarnessProps = $props();

  // `$props` are read once: the shell's opener does not change.
  // svelte-ignore state_referenced_locally
  if (onSearch !== undefined) provideSearchOpener(onSearch);

  const trail = $derived(breadcrumbTrail(router.pathname).map((item) => item.label));
</script>

<p data-testid="trail">{trail.join(' › ')}</p>
<NotFoundState
  {title}
  {...view === undefined ? {} : { view }}
  {...create === undefined ? {} : { create }}
  {...back === undefined ? {} : { back }}
  {...search === undefined ? {} : { search }}
/>
