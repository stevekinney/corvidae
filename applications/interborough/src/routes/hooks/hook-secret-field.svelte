<script lang="ts">
  /**
   * The Signing secret field of a saved webhook hook (design rows 84s and 85v). Deliveries are signed
   * with the secret so the receiver can verify them, and the Bureau shows a secret once: the one the
   * hook was made with, or the one Replace made. While the page holds that secret it is revealed in
   * Cinder's secret field with its Copy button and the note "Copy this now. You won't be able to
   * see it again." Once the page is left it is masked, and the field offers Replace, which makes a
   * new secret and stops the old one signing at once. A masked secret has nothing to copy, because
   * the Bureau returns no stored secret, so the field offers no Copy for it. Under the field, what
   * the secret is for, and a link to the payload it signs in the delivery log.
   */
  import { Alert, Button, Link, SecretValueField } from '@lostgradient/cinder';

  import { HOOKS_COPY } from './hook-copy.ts';

  interface Props {
    /** The secret the page holds for this one time, or `null` when it is masked. */
    secret: string | null;
    /** Whether a new secret is being made. */
    replacing: boolean;
    /** Why the last Replace failed, said beside the field. */
    failure?: string | null;
    /** Makes a new secret. */
    onReplace: () => void;
    /** Opens the delivery log, where the payload a delivery signed is shown. */
    onSeePayload: (event: MouseEvent) => void;
  }

  let { secret, replacing, failure = null, onReplace, onSeePayload }: Props = $props();

  const copy = HOOKS_COPY.editor.webhook;
  const labelId = $props.id();
</script>

<div class="ib-hook-secret" data-testid="hook-secret">
  {#if secret !== null}
    <SecretValueField value={secret} label={copy.secretLabel} initiallyRevealed>
      {#snippet warning()}{copy.secretOnce}{/snippet}
    </SecretValueField>
  {:else}
    <span id={labelId} class="ib-hook-secret__label">{copy.secretLabel}</span>
    <div class="ib-hook-secret__masked" role="group" aria-labelledby={labelId}>
      <span
        class="ib-hook-secret__mask"
        aria-label={copy.secretMasked}
        data-testid="hook-secret-mask">{'••••••••••••••••'}</span
      >
    </div>
  {/if}
  <div class="ib-hook-secret__actions">
    <Button
      variant="secondary"
      size="sm"
      mutating
      disabled={replacing}
      aria-label={`${copy.secretReplace} ${copy.secretLabel.toLowerCase()}`}
      onclick={onReplace}>{copy.secretReplace}</Button
    >
  </div>
  {#if failure !== null}
    <Alert variant="danger" data-testid="hook-secret-failure">{failure}</Alert>
  {/if}
  <p class="ib-hook-secret__help">
    {copy.secretHelp}
    <Link href="#ib-hook-log" onclick={onSeePayload}>{copy.seePayload}</Link>
  </p>
</div>

<style>
  .ib-hook-secret {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .ib-hook-secret__label {
    font-size: var(--cinder-text-sm);
    font-weight: 500;
  }

  .ib-hook-secret__mask {
    font-family: var(--cinder-font-mono);
    letter-spacing: 0.1em;
  }

  .ib-hook-secret__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
  }

  .ib-hook-secret__help {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }
</style>
