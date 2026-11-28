<script lang="ts">
  import { activateResource } from '@lostgradient/backchannel-svelte';
  import { Button, Checkbox, ConfirmDialog, DatePicker, Input, Select } from '@lostgradient/cinder';
  import { onDestroy } from 'svelte';
  import {
    getApiKeySettingsHost,
    useApiKeysIssue,
    useApiKeysList,
    useApiKeysRevoke,
    useApiKeysRotate,
  } from './svelte.ts';

  let { showHeading = true }: { showHeading?: boolean } = $props();

  const host = getApiKeySettingsHost();
  const list = useApiKeysList(host, () => ({}));
  const issue = useApiKeysIssue(host);
  const rotate = useApiKeysRotate(host);
  const revoke = useApiKeysRevoke(host);
  let label = $state('');
  let subject = $state('');
  let scopes = $state<string[]>([]);
  let expiresAt = $state<string | undefined>();
  const available = $derived(
    list.data?.targets.find((target) => target.subject === subject)?.scopes ?? [],
  );
  let secret = $state<string | undefined>();
  let secretPending = $state(false);
  let revokeTarget = $state<{ id: string; label: string } | undefined>();
  let revoking = false;
  let message = $state('');
  let destroyed = false;
  onDestroy(() => {
    destroyed = true;
    secret = undefined;
  });

  async function submit() {
    if (secretPending || secret !== undefined || !subject) return;
    secretPending = true;
    message = '';
    try {
      const result = await issue.mutateAsync({
        label,
        subject,
        scopes,
        ...(expiresAt ? { expiresAt: new Date(expiresAt).getTime() } : {}),
      });
      if (!destroyed && !host.disposed) secret = result.secret;
    } catch {
      if (!destroyed && !host.disposed) {
        message = 'The outcome is uncertain. Check the refreshed list before trying again.';
        const metadata = await issue.reconcile('api.keys.list', {}).catch(() => undefined);
        if (metadata !== undefined && !host.disposed)
          host.cache.setQueryData(host.key('api.keys.list', {}), metadata);
      }
    } finally {
      secretPending = false;
    }
  }
  async function rotateKey(id: string) {
    if (secretPending || secret !== undefined) return;
    secretPending = true;
    message = '';
    try {
      const result = await rotate.mutateAsync({ id });
      if (!destroyed && !host.disposed) {
        secret = result.secret;
        message = `The old key expires at ${new Date(result.retiresAt).toLocaleString()}.`;
      }
    } catch {
      if (!destroyed && !host.disposed) {
        message = 'The outcome is uncertain. Check the refreshed list before trying again.';
        const metadata = await rotate.reconcile('api.keys.list', {}).catch(() => undefined);
        if (metadata !== undefined && !host.disposed)
          host.cache.setQueryData(host.key('api.keys.list', {}), metadata);
      }
    } finally {
      secretPending = false;
    }
  }
  async function revokeKey(id: string) {
    if (revoking) return;
    revoking = true;
    message = '';
    try {
      await revoke.mutateAsync({ id });
    } catch {
      if (!destroyed && !host.disposed) {
        message = 'The outcome is uncertain. Check the refreshed list before trying again.';
        const metadata = await revoke.reconcile('api.keys.list', {}).catch(() => undefined);
        if (metadata !== undefined && !host.disposed)
          host.cache.setQueryData(host.key('api.keys.list', {}), metadata);
      }
    } finally {
      revoking = false;
    }
  }
</script>

<section class="api-key-settings" {@attach activateResource(list)}>
  {#if showHeading}<h1>API keys</h1>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  {#if secret}
    <section class="key-secret" aria-label="New API key">
      <p>Copy this secret now. It will not be shown again.</p>
      <code>{secret}</code>
      <Button
        onclick={() => {
          secret = undefined;
        }}>Dismiss</Button
      >
    </section>
  {/if}
  {#if list.initialError}<p>Unable to load API keys.</p>{/if}
  {#if list.data}
    <form
      class="key-form"
      onsubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Input id="api-key-label" label="Label" bind:value={label} required />
      <Select
        id="api-key-target"
        label="Target"
        placeholder="Choose a target"
        bind:value={subject}
        options={list.data.targets.map((target) => ({
          value: target.subject,
          label: target.subject,
        }))}
        onchange={() => {
          scopes = [];
        }}
        required
      />

      {#if available.length}
        <fieldset>
          <legend>Permissions</legend>
          {#each available as scope (scope)}
            <Checkbox
              label={scope}
              checked={scopes.includes(scope)}
              onValueChange={(checked) => {
                scopes = checked ? [...scopes, scope] : scopes.filter((entry) => entry !== scope);
              }}
            />
          {/each}
        </fieldset>
      {/if}
      <DatePicker
        id="api-key-expires-at"
        label="Expires at"
        granularity="minute"
        bind:value={expiresAt}
      />
      <Button type="submit" disabled={secretPending || secret !== undefined}>Issue key</Button>
    </form>
    <ul class="key-list">
      {#each list.data.keys as key (key.id)}
        <li>
          {key.label} ({key.subject}) <code>{key.id}</code>
          {#if key.actions.includes('rotate')}<Button
              disabled={secretPending || secret !== undefined}
              onclick={() => void rotateKey(key.id)}>Rotate</Button
            >{/if}
          {#if key.actions.includes('revoke')}<Button
              onclick={() => {
                revokeTarget = { id: key.id, label: key.label };
              }}>Revoke</Button
            >{/if}
        </li>
      {/each}
    </ul>
  {/if}
  <ConfirmDialog
    open={revokeTarget !== undefined}
    title={`Revoke ${revokeTarget?.label ?? ''}`}
    description="This key will no longer authenticate requests."
    confirmLabel="Revoke key"
    destructive
    onCancel={() => {
      revokeTarget = undefined;
    }}
    onConfirm={() => {
      const target = revokeTarget;
      revokeTarget = undefined;
      if (target) void revokeKey(target.id);
    }}
  />
</section>

<style>
  .api-key-settings,
  .key-form,
  .key-secret {
    display: grid;
    gap: var(--cinder-space-4);
    max-inline-size: 32rem;
    min-inline-size: 0;
  }

  .key-form :global(.cinder-button),
  .key-secret :global(.cinder-button) {
    justify-self: start;
  }

  fieldset {
    display: grid;
    gap: var(--cinder-space-2);
    margin: 0;
    padding: 0;
    border: 0;
    min-inline-size: 0;
  }

  legend {
    margin-block-end: var(--cinder-space-2);
  }

  .key-list {
    display: grid;
    gap: var(--cinder-space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  code {
    overflow-wrap: anywhere;
  }
</style>
