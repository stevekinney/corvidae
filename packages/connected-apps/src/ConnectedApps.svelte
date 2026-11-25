<script lang="ts">
  import { activateResource } from '@lostgradient/backchannel-svelte';
  import { Button, ConfirmDialog } from '@lostgradient/cinder';
  import { onDestroy } from 'svelte';
  import { getConnectedAppsHost, useConnectedAppsList, useConnectedAppsRevoke } from './svelte.ts';

  const host = getConnectedAppsHost();
  const list = useConnectedAppsList(host, () => ({}));
  const revoke = useConnectedAppsRevoke(host);
  let target = $state<{ grantId: string; name: string } | undefined>();
  let message = $state('');
  let pending = false;
  let destroyed = false;
  onDestroy(() => {
    destroyed = true;
  });

  async function disconnect(grantId: string) {
    if (pending) return;
    pending = true;
    message = '';
    try {
      await revoke.mutateAsync({ grantId });
      if (!destroyed && !host.disposed) message = 'App disconnected.';
    } catch {
      if (!destroyed && !host.disposed) {
        message = 'Unable to disconnect the app. Check the refreshed list before trying again.';
        const refreshed = await revoke.reconcile('connected.apps.list', {}).catch(() => undefined);
        if (refreshed !== undefined && !host.disposed)
          host.cache.setQueryData(host.key('connected.apps.list', {}), refreshed);
      }
    } finally {
      pending = false;
    }
  }
</script>

<section {@attach activateResource(list)}>
  <h1>Connected apps</h1>
  {#if message}<p role="status">{message}</p>{/if}
  {#if list.initialError}<p>Unable to load connected apps.</p>{/if}
  {#if list.data}
    {#if list.data.managementDestination}<a href={list.data.managementDestination}
        >Manage connected apps</a
      >{/if}
    {#if list.data.canList}
      {#if list.data.grants.length === 0}<p>No connected apps.</p>{/if}
      <ul>
        {#each list.data.grants as grant (grant.grantId)}
          <li>
            <h2>{grant.clientName}</h2>
            <p>Client: {grant.clientId}</p>
            <p>Resource: {grant.resource}</p>
            <p>
              Approved: {grant.approvedAt === null
                ? 'Time unavailable'
                : new Date(grant.approvedAt).toLocaleString()}
            </p>
            <details>
              <summary>Approved permissions</summary>
              <ul>
                {#each grant.permissions as permission (permission.scope)}<li>
                    {permission.description} ({permission.scope}){permission.available
                      ? ', currently available'
                      : ', currently unavailable'}
                  </li>{/each}
              </ul>
            </details>
            {#if list.data.canRevoke}<Button
                onclick={() => {
                  target = { grantId: grant.grantId, name: grant.clientName };
                }}>Disconnect</Button
              >{/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
  <ConfirmDialog
    open={target !== undefined}
    title={`Disconnect ${target?.name ?? ''}`}
    description="This approval will no longer grant access."
    confirmLabel="Disconnect"
    destructive
    onCancel={() => {
      target = undefined;
    }}
    onConfirm={() => {
      const selected = target;
      target = undefined;
      if (selected) void disconnect(selected.grantId);
    }}
  />
</section>
