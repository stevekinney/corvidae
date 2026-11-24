<script lang="ts">
  import { activateResource } from '@lostgradient/backchannel-svelte';
  import { Button, ConfirmDialog, Input } from '@lostgradient/cinder';
  import { onDestroy } from 'svelte';
  import {
    getApiKeySettingsHost,
    useApiKeysIssue,
    useApiKeysList,
    useApiKeysRevoke,
    useApiKeysRotate,
  } from './svelte.ts';

  const host = getApiKeySettingsHost();
  const list = useApiKeysList(host, () => ({}));
  const issue = useApiKeysIssue(host);
  const rotate = useApiKeysRotate(host);
  const revoke = useApiKeysRevoke(host);
  let label = $state('');
  let subject = $state('');
  let scopes = $state<string[]>([]);
  let expiresAt = $state('');
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
    if (secretPending || secret !== undefined) return;
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

<section {@attach activateResource(list)}>
  <h1>API keys</h1>
  {#if message}<p role="status">{message}</p>{/if}
  {#if secret}
    <section aria-label="New API key">
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
      onsubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Input id="api-key-label" label="Label" bind:value={label} required />
      <label
        >Target
        <select
          bind:value={subject}
          onchange={() => {
            scopes = [];
          }}
          required
        >
          <option value="">Choose a target</option>
          {#each list.data.targets as target (target.subject)}<option value={target.subject}
              >{target.subject}</option
            >{/each}
        </select>
      </label>
      {#each list.data.targets.find((target) => target.subject === subject)?.scopes ?? [] as scope (scope)}
        <label><input type="checkbox" value={scope} bind:group={scopes} />{scope}</label>
      {/each}
      <label>Expires at <input type="datetime-local" bind:value={expiresAt} /></label>
      <Button type="submit" disabled={secretPending || secret !== undefined}>Issue key</Button>
    </form>
    <ul>
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
