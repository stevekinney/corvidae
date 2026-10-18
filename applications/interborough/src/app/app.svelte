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

  import { Skeleton, setCodeHighlighterContext } from '@lostgradient/cinder';
  import { QueryClientProvider } from '@tanstack/svelte-query';

  import { createClient } from '../lib/client.ts';
  import { codeHighlighter } from '../lib/code-highlighter.ts';
  import { readRuntimeConfig, type WeftUiRuntimeConfig } from '../lib/config.ts';
  import { createQueryClient } from '../lib/query.ts';
  import { resolvePrincipal, type Principal } from '../lib/scopes.svelte.ts';
  import BootFailure from './boot-failure.svelte';
  import Shell from './shell/shell.svelte';
  import ToastHost, { provideToastHost } from './toast-host.svelte';

  const queryClient = createQueryClient();
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
    | { readonly status: 'ready'; readonly client: HttpClient; readonly principal: Principal };

  let phase = $state<BootPhase>({ status: 'resolving' });

  $effect(() => {
    let cancelled = false;
    const initialClient = createClient(config);

    void resolvePrincipal(initialClient).then(
      (principal) => {
        if (cancelled) return undefined;
        phase =
          principal === null
            ? { status: 'unidentified' }
            : { status: 'ready', client: initialClient, principal };
        return undefined;
      },
      () => {
        // A non-auth failure (network error, 500) from the boot probe isn't
        // one of the two documented boot states — fail open into the
        // unauthenticated-mode path so the shell still mounts and the real
        // surfaces (backed by <FaultBoundary>/query error handling) report
        // the underlying problem instead of the boot sequence hanging.
        if (cancelled) return undefined;
        phase = {
          status: 'ready',
          client: initialClient,
          principal: { scopes: [], unauthenticatedAccess: null },
        };
        return undefined;
      },
    );

    return () => {
      cancelled = true;
    };
  });

  function onAuthExpired(expiredClient: HttpClient): void {
    if (phase.status !== 'ready' || phase.client !== expiredClient) return;
    queryClient.clear();
    phase = { status: 'unidentified' };
  }
</script>

<QueryClientProvider client={queryClient}>
  {#if phase.status === 'ready'}
    <Shell client={phase.client} initialPrincipal={phase.principal} {onAuthExpired} />
  {:else if phase.status === 'unidentified'}
    <BootFailure />
  {:else}
    <div
      class="weft-shell-boot-skeleton"
      role="status"
      aria-busy="true"
      aria-label="Loading Weft UI"
    >
      <Skeleton height="100vh" radius="0" />
    </div>
  {/if}
  <ToastHost />
</QueryClientProvider>
