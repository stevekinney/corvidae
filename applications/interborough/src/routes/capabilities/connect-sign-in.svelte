<script lang="ts">
  /**
   * Sign in with OAuth before the source is saved (board PageConnectTools, rows 33g, 34k, 34l and
   * 34y, COR-2436). "Sign in to GitHub" asks the host to start a sign-in
   * (`POST /host/tool-source-sign-ins`) and opens the provider in a window of its own. While it is
   * open the button reads "Waiting for GitHub…" with a spinner, a Cancel link sits beside it and a
   * line says closing the window cancels; the rest of the form stays editable. The provider's
   * window comes back to the host, whose page posts the outcome here: only a message from that
   * window, for this sign-in, is read. A window closed with no message, or Cancel, reads the
   * outcome from the host once, so a sign-in that finished is not taken for a cancel.
   *
   * Signed in reads "Signed in as you" in green; a cancel is neutral text with Try again; a refusal
   * is a danger-tone message with the provider's reason from the host's closed set and Try again.
   * The page never holds a token: `signIn` is the host's reference, which Test connection and
   * Connect name. A change to where the source is or how it signs in drops the sign-in, because
   * the host took it for that description alone.
   */
  import { Button, Link } from '@lostgradient/cinder';
  import { KeyRound } from '@lucide/svelte';

  import { CAPABILITIES_COPY } from '../../app/copy/capabilities.ts';
  import {
    getToolSourceSignIn,
    signInMessageOf,
    startToolSourceSignIn,
    toolSourceFaultTreatment,
    type ToolSourceSignInStanding,
  } from '../../lib/host-tool-sources.ts';

  interface Props {
    /** What the source is called, which names the provider; empty before it has a name. */
    provider: string;
    /**
     * What the sign-in is for: the identifier and the description the host would save, or
     * `undefined` while the form cannot make one. A change to it drops the sign-in.
     */
    target: { readonly id: string; readonly source: Readonly<Record<string, unknown>> } | undefined;
    /** Whether the page is saving, which holds the button still. */
    disabled: boolean;
    /** The host's reference to the sign-in that succeeded, or `undefined`. */
    signIn: string | undefined;
  }

  let { provider, target, disabled, signIn = $bindable() }: Props = $props();

  const copy = CAPABILITIES_COPY.source.connect.authentication.signIn;
  const named = $derived(provider.trim() === '' ? copy.provider : provider.trim());

  type State =
    | { readonly kind: 'idle' }
    | { readonly kind: 'starting' }
    | { readonly kind: 'waiting'; readonly signIn: string; readonly popup: Window }
    | { readonly kind: 'signed-in'; readonly signIn: string }
    | { readonly kind: 'canceled'; readonly declined: boolean }
    | { readonly kind: 'refused'; readonly message: string }
    | { readonly kind: 'blocked' }
    | { readonly kind: 'not-needed' };
  let current = $state<State>({ kind: 'idle' });

  /** The description the sign-in was made for: a change to it drops the sign-in. */
  const signature = $derived(target === undefined ? '' : JSON.stringify(target));
  let signedFor = '';
  $effect(() => {
    const now = signature;
    if (signedFor !== '' && now !== signedFor) {
      signedFor = '';
      closeWindow();
      current = { kind: 'idle' };
      signIn = undefined;
    }
  });

  function closeWindow(): void {
    if (current.kind === 'waiting' && !current.popup.closed) current.popup.close();
  }

  /** The words for a sign-in that did not succeed. */
  function settle(standing: ToolSourceSignInStanding): void {
    if (current.kind !== 'waiting' || standing.signIn !== current.signIn) return;
    if (standing.outcome === 'succeeded') {
      current = { kind: 'signed-in', signIn: standing.signIn };
      signIn = standing.signIn;
      return;
    }
    signIn = undefined;
    if (standing.outcome === 'waiting' || standing.outcome === 'canceled') {
      current = { kind: 'canceled', declined: standing.reason === 'denied' };
      return;
    }
    const reason = standing.reason ?? 'unknown';
    const why = copy.reasons[reason];
    current = {
      kind: 'refused',
      message:
        why === undefined
          ? copy.failed(copy.failures[reason] ?? copy.failures['unknown'] ?? '')
          : copy.refused(named, why),
    };
  }

  /** The outcome the host holds, read once: a window closed with no message, or Cancel. */
  async function readOutcome(reference: string): Promise<void> {
    try {
      settle(await getToolSourceSignIn(reference));
    } catch {
      settle({ signIn: reference, outcome: 'canceled' });
    }
  }

  // The message the provider's window posts when the host has settled the sign-in.
  $effect(() => {
    if (current.kind !== 'waiting') return;
    const { popup, signIn: reference } = current;
    const listen = (event: MessageEvent): void => {
      // Only the window this page opened speaks for the sign-in, and only for this one.
      if (event.source !== popup) return;
      const standing = signInMessageOf(event.data);
      if (standing === undefined || standing.signIn !== reference) return;
      settle(standing);
    };
    window.addEventListener('message', listen);
    // poll-reason: timer — a window closed by the person posts nothing, and no event says so.
    const watch = setInterval(() => {
      if (popup.closed) {
        clearInterval(watch);
        void readOutcome(reference);
      }
    }, 500);
    return () => {
      window.removeEventListener('message', listen);
      clearInterval(watch);
    };
  });

  async function start(): Promise<void> {
    if (target === undefined) return;
    const asked = target;
    // Opened before the request, while the click still allows a window, then sent on.
    const popup = window.open('about:blank', 'interborough-sign-in', 'popup,width=520,height=680');
    if (popup === null) {
      current = { kind: 'blocked' };
      return;
    }
    current = { kind: 'starting' };
    signIn = undefined;
    try {
      const started = await startToolSourceSignIn(asked.id, asked.source);
      if (started.authorized) {
        popup.close();
        current = { kind: 'not-needed' };
        return;
      }
      signedFor = JSON.stringify(asked);
      popup.location.href = started.authorizationUrl;
      current = { kind: 'waiting', signIn: started.signIn, popup };
    } catch (error) {
      popup.close();
      current = { kind: 'refused', message: copy.failed(toolSourceFaultTreatment(error).message) };
    }
  }

  function cancel(): void {
    if (current.kind !== 'waiting') return;
    const reference = current.signIn;
    closeWindow();
    void readOutcome(reference);
  }
</script>

<div class="ib-connect__sign-in" data-testid="connect-sign-in" data-state={current.kind}>
  {#if current.kind === 'waiting' || current.kind === 'starting'}
    <div class="ib-connect__sign-in-row">
      <Button variant="secondary" loading disabled data-testid="connect-sign-in-waiting"
        >{copy.waiting(named)}</Button
      >
      {#if current.kind === 'waiting'}
        <Link href="#cancel" onclick={(event) => (event.preventDefault(), cancel())}
          >{copy.cancel}</Link
        >
      {/if}
    </div>
    <p class="ib-connect__help" role="status">{copy.approve(named)}</p>
  {:else}
    <div class="ib-connect__sign-in-row">
      <Button
        data-changes
        variant="secondary"
        disabled={disabled || target === undefined}
        onclick={() => void start()}
        data-testid="connect-sign-in-start"
      >
        {#snippet leadingIcon()}<KeyRound size={14} aria-hidden="true" />{/snippet}
        {current.kind === 'canceled' || current.kind === 'refused' || current.kind === 'blocked'
          ? copy.tryAgain
          : copy.action(named)}
      </Button>
      {#if current.kind === 'signed-in'}
        <span class="ib-connect__signed-in" role="status" data-testid="connect-signed-in"
          >{copy.signedIn}</span
        >
      {/if}
    </div>
    {#if current.kind === 'canceled'}
      <p class="ib-connect__help" role="status" data-testid="connect-sign-in-canceled">
        {current.declined ? copy.declined(named) : copy.canceled(named)}
      </p>
    {:else if current.kind === 'refused'}
      <p class="ib-connect__sign-in-refused" role="alert" data-testid="connect-sign-in-refused">
        {current.message}
      </p>
    {:else if current.kind === 'blocked'}
      <p class="ib-connect__help" role="status">{copy.blocked}</p>
    {:else if current.kind === 'not-needed'}
      <p class="ib-connect__help" role="status">{copy.notNeeded}</p>
    {/if}
  {/if}
</div>

<style>
  .ib-connect__sign-in {
    display: grid;
    gap: var(--cinder-space-2);
  }

  .ib-connect__sign-in-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-3);
    align-items: center;
  }

  .ib-connect__signed-in {
    color: var(--cinder-status-success-text);
    font-weight: var(--cinder-font-medium);
  }

  .ib-connect__sign-in-refused {
    margin: 0;
    color: var(--cinder-status-danger-text);
  }
</style>
