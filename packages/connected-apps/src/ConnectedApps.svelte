<script lang="ts">
  import { activateResource } from '@lostgradient/backchannel-svelte';
  import { Button, Card, Collapsible, ConfirmDialog, EmptyState } from '@lostgradient/cinder';
  import { onDestroy } from 'svelte';
  import { getConnectedAppsHost, useConnectedAppsList, useConnectedAppsRevoke } from './svelte.ts';

  let {
    showHeading = true,
    labelledby,
    workspaceLabel,
  }: { showHeading?: boolean; labelledby?: string | undefined; workspaceLabel?: string } = $props();

  const host = getConnectedAppsHost();
  const list = useConnectedAppsList(host, () => ({}));
  const revoke = useConnectedAppsRevoke(host);
  const duplicateNames = $derived.by(() => {
    const names = new Set<string>();
    const duplicates = new Set<string>();
    for (const grant of list.data?.grants ?? []) {
      if (names.has(grant.clientName)) duplicates.add(grant.clientName);
      names.add(grant.clientName);
    }
    return duplicates;
  });
  let target = $state<{ grantId: string; name: string } | undefined>();
  let message = $state('');
  let pendingGrant = $state<string | undefined>();
  let destroyed = false;
  onDestroy(() => {
    destroyed = true;
  });

  async function disconnect(grantId: string) {
    if (pendingGrant !== undefined) return;
    pendingGrant = grantId;
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
      pendingGrant = undefined;
    }
  }
</script>

<section class="connected-apps" aria-labelledby={labelledby} {@attach activateResource(list)}>
  {#if showHeading}<h1>Connected apps</h1>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  {#if list.initialError}<p>Unable to load connected apps.</p>{/if}
  {#if list.data}
    {#if list.data.managementDestination}<a href={list.data.managementDestination}
        >Manage connected apps</a
      >{/if}
    {#if list.data.canList}
      {#if list.data.grants.length === 0}
        <EmptyState title="You haven’t authorized any apps in this workspace." headingLevel={2} />
      {/if}
      <ul class="grant-list">
        {#each list.data.grants as grant (grant.grantId)}
          <li>
            <Card class="grant-card">
              <h2>{grant.clientName}</h2>
              <p>
                {grant.permissions
                  .filter((permission) => permission.available)
                  .map((permission) => permission.description)
                  .join(', ') || 'No currently available permissions'}
              </p>
              <p>
                Approved: {grant.approvedAt === null
                  ? 'Time unavailable'
                  : new Date(grant.approvedAt).toLocaleString()}
              </p>
              {#if duplicateNames.has(grant.clientName)}
                <p class="grant-reference">Grant reference <code>{grant.grantId}</code></p>
              {/if}
              <Collapsible trigger="Connection details" variant="disclosure" chevron="start">
                <dl>
                  {#if workspaceLabel || grant.workspace}
                    <div>
                      <dt>Workspace</dt>
                      <dd>{workspaceLabel ?? grant.workspace}</dd>
                    </div>
                  {/if}
                  <div>
                    <dt>Registered client</dt>
                    <dd>{grant.clientId}</dd>
                  </div>
                  {#if !duplicateNames.has(grant.clientName)}
                    <div>
                      <dt>Grant reference</dt>
                      <dd>{grant.grantId}</dd>
                    </div>
                  {/if}
                  <div>
                    <dt>MCP resource</dt>
                    <dd>{grant.resource}</dd>
                  </div>
                </dl>
                <ul>
                  {#each grant.permissions as permission (permission.scope)}<li>
                      {permission.description} ({permission.scope}){permission.available
                        ? ', currently available'
                        : ', currently unavailable'}
                    </li>{/each}
                </ul>
              </Collapsible>
              {#if list.data.canRevoke}<Button
                  loading={pendingGrant === grant.grantId}
                  loadingStatus="Disconnecting app…"
                  disabled={pendingGrant !== undefined && pendingGrant !== grant.grantId}
                  onclick={() => {
                    target = { grantId: grant.grantId, name: grant.clientName };
                  }}>Disconnect</Button
                >{/if}
            </Card>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
  <ConfirmDialog
    open={target !== undefined}
    title={`Disconnect ${target?.name ?? ''}`}
    description="Future calls and token refreshes through this connection will stop."
    confirmLabel="Disconnect"
    options={connectionReference}
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

{#snippet connectionReference()}
  {#if target}
    <p class="grant-reference">Grant reference <code>{target.grantId}</code></p>
  {/if}
{/snippet}

<style>
  .connected-apps {
    display: grid;
    gap: var(--cinder-space-4);
    min-inline-size: 0;
  }

  .grant-list {
    display: grid;
    gap: var(--cinder-space-4);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .grant-list > li {
    overflow-wrap: anywhere;
    min-inline-size: 0;
  }

  .grant-list :global(.grant-card) {
    display: grid;
    gap: var(--cinder-space-3);
  }

  .grant-reference {
    overflow-wrap: anywhere;
  }

  .grant-list p,
  .grant-list h2 {
    margin: 0;
  }

  dl {
    display: grid;
    gap: var(--cinder-space-2);
  }

  dd {
    margin: 0;
  }

  .grant-list :global(.cinder-button) {
    justify-self: start;
  }
</style>
