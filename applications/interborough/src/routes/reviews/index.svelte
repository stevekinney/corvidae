<script lang="ts">
  import { ReviewsProvider } from '@lostgradient/bureau-sdk/reviews/svelte';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { bureauTransport } from '../../lib/bureau-transport.ts';
  import { getPrincipalStore, principalQueryScope } from '../../lib/scopes.svelte.ts';
  import { queryKeys } from '../../lib/query.ts';
  import ReviewsPage from './reviews-page.svelte';

  let {
    seed,
  }: {
    seed?: { scope: string; entries: readonly { input: unknown; data: unknown }[] } | undefined;
  } = $props();

  const queryClient = useQueryClient();
  const principal = getPrincipalStore();
  const scope = $derived(JSON.stringify(principalQueryScope(principal.principal)));
  const authorized = $derived.by(() => {
    const captured = scope;
    return () =>
      principal.principal !== null &&
      JSON.stringify(principalQueryScope(principal.principal)) === captured;
  });
  const transport = bureauTransport({ baseUrl: '' });
  $effect(() => {
    void scope;
    return () => queryClient.removeQueries({ queryKey: queryKeys.reviews.inbox('pending') });
  });
</script>

<ReviewsProvider
  {scope}
  cache={queryClient}
  {transport}
  {authorized}
  {seed}
  decisionSurface="reviews"
>
  <ReviewsPage />
</ReviewsProvider>
