<script lang="ts">
  /**
   * App shell entry point (plan §13 T1.6, design `Weft UI.dc.html`),
   * the application's root component.
   * Owns the boot sequence — read runtime config, construct the initial
   * `HttpClient`, resolve the principal, and mount the real `<Shell>`
   * (sidebar, topbar, notification center, route outlet). The host answers
   * every request as the one local caller, so there is no sign-in: a
   * principal that cannot be resolved, or a credential the engine stops
   * accepting, shows an error with a reload button instead of a form.
   *
   * `<Shell>` is the component that actually calls `provideClient()` /
   * `providePrincipalStore()`.
   */
  import type { HttpClient } from '@lostgradient/weft';
  import { tick } from 'svelte';

  import { Skeleton, setCodeHighlighterContext } from '@lostgradient/cinder';
  import { QueryClientProvider } from '@tanstack/svelte-query';

  import { createClient } from '../lib/client.ts';
  import { codeHighlighter } from '../lib/code-highlighter.ts';
  import { readRuntimeConfig, type WeftUiRuntimeConfig } from '../lib/config.ts';
  import { createQueryClient } from '../lib/query.ts';
  import { resolveHostPrincipal, type Principal } from '../lib/scopes.svelte.ts';
  import BootFailure from './boot-failure.svelte';
  import Shell from './shell/shell.svelte';
  import ToastHost, { provideToastHost } from './toast-host.svelte';
  import { WorkspaceLifetime } from './workspace-lifetime.ts';

  // The `<ToastHost>` below serves every view in the shell, so a view never
  // mounts a second one of its own.
  provideToastHost();
  const config: WeftUiRuntimeConfig = readRuntimeConfig();

  // Every highlighted CodeBlock in the UI renders JSON or TypeScript, so the
  // whole tree shares the curated highlighter over exactly those grammars.
  // CodeBlock imports no highlighter of its own, which keeps Shiki's other
  // grammars and themes out of the bundle.
  setCodeHighlighterContext(codeHighlighter);

  type BootPhase =
    | { readonly status: 'resolving' }
    | { readonly status: 'unidentified' }
    | {
        readonly status: 'ready';
        readonly client: HttpClient;
        readonly principal: Principal;
        readonly queryClient: ReturnType<typeof createQueryClient>;
      };

  let phase = $state<BootPhase>({ status: 'resolving' });
  const lifetime = new WorkspaceLifetime({
    resolve: async () => {
      await tick();
      const client = createClient(config);
      const principal = await resolveHostPrincipal(client.headers);
      if (principal?.workspace === undefined) throw new Error('Workspace identity unavailable');
      return { client, principal };
    },
    open: ({ client, principal }) => {
      const queryClient = createQueryClient();
      phase = { status: 'ready', client, principal, queryClient };
      return () => {
        phase = { status: 'resolving' };
        void queryClient.cancelQueries();
        queryClient.clear();
      };
    },
    fail: () => {
      phase = { status: 'unidentified' };
    },
  });

  $effect(() => {
    void lifetime.refresh();
    return () => lifetime.dispose();
  });

  function onIdentityMismatch(expiredClient: HttpClient): void {
    if (phase.status !== 'ready' || phase.client !== expiredClient) return;
    void lifetime.refresh();
  }

  function onAuthExpired(expiredClient: HttpClient): void {
    if (phase.status !== 'ready' || phase.client !== expiredClient) return;
    lifetime.dispose();
    phase = { status: 'unidentified' };
  }
</script>

{#if phase.status === 'ready'}
  {#key phase.queryClient}
    <QueryClientProvider client={phase.queryClient}>
      <Shell
        client={phase.client}
        initialPrincipal={phase.principal}
        {onAuthExpired}
        {onIdentityMismatch}
      />
    </QueryClientProvider>
  {/key}
{:else if phase.status === 'unidentified'}
  <BootFailure />
{:else}
  <div
    class="weft-shell-boot-skeleton"
    role="status"
    aria-busy="true"
    aria-label="Loading Interborough"
  >
    <Skeleton height="100vh" radius="0" />
  </div>
{/if}
<ToastHost />
