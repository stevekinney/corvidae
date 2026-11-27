<script lang="ts">
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import { setCodeHighlighterContext } from '@lostgradient/cinder';
  import { onDestroy, untrack } from 'svelte';
  import Shell from '../../app/shell/shell.svelte';
  import ToastHost, { provideToastHost } from '../../app/toast-host.svelte';
  import { WorkspaceLifetime } from '../../app/workspace-lifetime.ts';
  import { createClient } from '../../lib/client.ts';
  import { codeHighlighter } from '../../lib/code-highlighter.ts';
  import { createQueryClient } from '../../lib/query.ts';
  import { provideReviewsNavigation } from '../../lib/reviews-navigation.ts';
  import { resolveHostPrincipal, type Principal } from '../../lib/scopes.svelte.ts';
  import Reviews from '../../routes/reviews/index.svelte';
  import '../../styles/index.css';

  let {
    data,
  }: {
    data: {
      address: string;
      principal: Principal;
      seed: { scope: string; entries: readonly { input: unknown; data: unknown }[] };
    };
  } = $props();
  const initial = untrack(() => data);
  provideReviewsNavigation(initial.address);
  provideToastHost();
  setCodeHighlighterContext(codeHighlighter);
  const client = createClient({ baseUrl: '' }, new URL(initial.address).origin);
  let phase = $state<{
    principal: Principal;
    queryClient: ReturnType<typeof createQueryClient>;
    seed?: typeof data.seed;
  } | null>(null);
  let first = true;
  const lifetime = new WorkspaceLifetime({
    initial: initial.principal,
    resolve: async () => {
      const principal = await resolveHostPrincipal(client.headers);
      if (!principal?.workspace) throw new Error('Workspace identity unavailable');
      return principal;
    },
    open: (principal) => {
      const queryClient = createQueryClient();
      phase = { principal, queryClient, ...(first ? { seed: initial.seed } : {}) };
      first = false;
      return () => {
        phase = null;
        void queryClient.cancelQueries();
        queryClient.clear();
      };
    },
    fail: () => {
      phase = null;
    },
  });
  onDestroy(() => lifetime.dispose());
  function expire() {
    lifetime.dispose();
    phase = null;
  }
</script>

{#if phase}
  {#key phase.queryClient}
    <QueryClientProvider client={phase.queryClient}>
      <Shell
        {client}
        initialPrincipal={phase.principal}
        serverRendered
        onAuthExpired={expire}
        onIdentityMismatch={() => void lifetime.refresh()}
      >
        <main class="weft-shell-outlet" data-width="wide">
          <Reviews seed={phase.seed} />
        </main>
      </Shell>
    </QueryClientProvider>
  {/key}
{/if}
<ToastHost />
