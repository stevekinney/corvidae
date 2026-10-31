<script lang="ts">
  /**
   * Save a secret a plugin declared: one value, sent to the host in one request
   * (`PUT /host/plugins/<name>/secrets/<key>`), which stores it where only the person can read it.
   * What waits for the secret works at once, with no restart.
   *
   * The value is held only in the field, only until the request settles. It is cleared whether the
   * host accepted it or refused it, and when the dialog is dismissed, and it is never put in a
   * message: a refusal is worded by the host in terms of the field, and a message that held the
   * value is replaced before it gets here (`lib/host-plugins.ts`).
   */
  import { Alert, Button, Input, Modal } from '@lostgradient/cinder';
  import { useQueryClient } from '@tanstack/svelte-query';

  import { PLUGINS_COPY } from '../../../app/copy.ts';
  import { showToast } from '../../../app/toast-host.svelte';
  import { HostPluginError, savePluginSecret } from '../../../lib/host-plugins.ts';
  import { queryKeys } from '../../../lib/query.ts';

  /** The plugin and the secret the dialog is for. */
  export interface SecretTarget {
    readonly plugin: string;
    readonly key: string;
  }

  interface Props {
    /** The secret the dialog is for, or `null` while it is closed. */
    target: SecretTarget | null;
  }

  let { target = $bindable() }: Props = $props();

  const copy = PLUGINS_COPY.secrets.dialog;
  const queryClient = useQueryClient();

  const pluginName = $derived(target?.plugin ?? '');

  let value = $state('');
  let valueError = $state('');
  let failure = $state('');
  let sending = $state(false);

  /** The words for a refusal, none of which is the value. */
  function wordsFor(error: unknown): string {
    if (!(error instanceof HostPluginError)) return copy.failed;
    if (error.kind === 'locked') return copy.locked;
    return error.message === '' ? copy.failed : `${copy.failed} ${error.message}`;
  }

  function close(): void {
    if (sending) return;
    value = '';
    valueError = '';
    failure = '';
    target = null;
  }

  async function submit(): Promise<void> {
    if (sending || target === null) return;
    if (value.trim() === '') {
      valueError = copy.valueRequired;
      return;
    }
    const { plugin, key } = target;
    sending = true;
    valueError = '';
    failure = '';
    try {
      await savePluginSecret(plugin, key, value);
      showToast(copy.saved(key), { variant: 'success' });
      target = null;
      // The plugin's status, its problems and what it adds changed under the page.
      void queryClient.invalidateQueries({ queryKey: queryKeys.hostPlugins() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.catalog() });
    } catch (error) {
      failure = wordsFor(error);
    } finally {
      // Settled either way: the value is not kept.
      value = '';
      sending = false;
    }
  }
</script>

{#if target !== null}
  <Modal
    open
    title={copy.title(target.key)}
    onDismiss={close}
    dismissOnEscape={!sending}
    dismissOnBackdropClick={!sending}
  >
    {#snippet children()}
      <form
        class="ib-plugin-secret"
        data-testid="plugin-secret-form"
        onsubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p class="ib-plugin-secret__lead">{copy.description(pluginName)}</p>
        <Input
          id="plugin-secret-value"
          type="password"
          autocomplete="off"
          spellcheck={false}
          variant="code"
          label={copy.valueLabel}
          description={copy.valueDescription}
          bind:value
          error={valueError}
          disabled={sending}
        />
        {#if failure !== ''}
          <Alert variant="danger" data-testid="plugin-secret-failure">
            <p class="ib-plugin-secret__failure">{failure}</p>
          </Alert>
        {/if}
      </form>
    {/snippet}
    {#snippet footer()}
      <Button variant="secondary" onclick={close} disabled={sending}>{copy.cancel}</Button>
      <Button data-changes variant="primary" onclick={() => void submit()} loading={sending}
        >{copy.save}</Button
      >
    {/snippet}
  </Modal>
{/if}

<style>
  .ib-plugin-secret {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-plugin-secret__lead,
  .ib-plugin-secret__failure {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
