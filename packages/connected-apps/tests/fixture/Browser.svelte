<script lang="ts">
  import { QueryClient } from '@tanstack/svelte-query';
  import { ConnectedAppsProvider } from '../../src/svelte.ts';
  import ConnectedApps from '../../src/ConnectedApps.svelte';
  let writes = $state(0);
  let present = true;
  const cache = new QueryClient();
  async function transport(operation: string) {
    if (operation === 'connected.apps.list')
      return {
        canList: true,
        canRevoke: true,
        grants: present
          ? [
              {
                grantId: 'grant',
                clientId: 'client',
                clientName: 'Claude',
                resource: 'https://resource.test',
                approvedAt: 1,
                permissions: [{ scope: 'read', description: 'Read assets', available: true }],
              },
            ]
          : [],
      };
    writes++;
    present = false;
    return { grantId: 'grant', status: 'revoked' };
  }
</script>

<output data-testid="writes">{writes}</output>
<ConnectedAppsProvider scope="member" {cache} {transport}><ConnectedApps /></ConnectedAppsProvider>
