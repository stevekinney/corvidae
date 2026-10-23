<script lang="ts">
  /**
   * Unauthenticated-mode banner (plan §6, §10; design `Weft UI.dc.html`
   * "auth-mode banner"): `warn`/`allow` variants from the scopes module's
   * `PrincipalStore.bannerMode`. `auth-required`/`none` render nothing here
   * — `auth-required` is handled by `../app.svelte`, which shows its boot
   * failure in place of the shell, and `none` (a normally authenticated principal)
   * has nothing to announce.
   */
  import { TriangleAlert, X } from '@lucide/svelte';

  import type { BannerMode } from '../../lib/scopes.svelte.ts';

  interface AuthModeBannerProps {
    mode: BannerMode;
  }

  let { mode }: AuthModeBannerProps = $props();

  let dismissed = $state(false);

  // Copy matches the actual per-request behavior (`scopes.svelte.ts` module
  // doc): a server with no `auth` runs every request as the
  // `unauthenticated-local` principal, which holds every scope, regardless of
  // `warn` vs `allow`. Every operation is open to anyone who can reach the
  // port, so the banner says so rather than implying scopes are missing.
  const COPY: Readonly<Record<'unauthenticated-warn' | 'unauthenticated-allow', string>> = {
    'unauthenticated-warn':
      'Running without authentication. Every operation is open to anyone who can reach this server.',
    'unauthenticated-allow':
      'Running without authentication by deployment choice. Every operation is open to anyone who can reach this server.',
  };

  $effect(() => {
    // A mode change (e.g. re-resolving the principal after an API-key
    // entry) should re-show the banner rather than keep a stale dismissal.
    void mode;
    dismissed = false;
  });
</script>

{#if !dismissed && (mode === 'unauthenticated-warn' || mode === 'unauthenticated-allow')}
  <div
    class="weft-shell-auth-banner"
    data-variant={mode === 'unauthenticated-warn' ? 'warn' : 'allow'}
  >
    <TriangleAlert aria-hidden="true" size={15} class="weft-shell-auth-banner__icon" />
    <span>{COPY[mode]}</span>
    <button
      type="button"
      class="weft-shell-auth-banner__dismiss"
      aria-label="Dismiss"
      onclick={() => (dismissed = true)}
    >
      <X aria-hidden="true" size={14} />
    </button>
  </div>
{/if}
