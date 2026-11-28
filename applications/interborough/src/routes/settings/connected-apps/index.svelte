<script lang="ts">
  import { ConnectedAppsProvider } from '@lostgradient/connected-apps/svelte';
  import ConnectedApps from '@lostgradient/connected-apps/ui';
  import { EmptyState, ErrorState, Skeleton } from '@lostgradient/cinder';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import {
    CONNECTED_APPS_SETTINGS_COPY as copy,
    SETTINGS_SECTION_COPY,
  } from '../../../app/copy/settings.ts';
  import { readSettingsAccess, type SettingsAccess } from '../section-access.ts';
  import { settingsTransport } from '../section-transport.ts';
  import SettingsFrame from '../settings-frame.svelte';

  let {
    initialAccess,
    documentPath,
  }: { initialAccess?: SettingsAccess; documentPath?: string | undefined } = $props();
  const cache = useQueryClient();
  const access = createQuery(() => ({
    queryKey: ['host', 'connected-apps', 'access'],
    queryFn: ({ signal }) => readSettingsAccess('/host/connected-apps/access', fetch, signal),
    ...(initialAccess === undefined ? {} : { initialData: initialAccess }),
    retry: false,
  }));
  const transport = settingsTransport('/host/connected-apps', 'connected.apps.list', () => true);
</script>

<SettingsFrame
  title={SETTINGS_SECTION_COPY.connectedApps}
  intro={copy.intro}
  page="settings-connected-apps"
  staticState={access.isPending ? 'loading' : access.isError ? 'error' : 'ready'}
  headingId="settings-heading"
  {documentPath}
>
  {#snippet staticBody()}
    {#if access.isError}
      <ErrorState
        title={copy.unavailable}
        description={copy.unavailableDescription}
        onRetry={() => void access.refetch()}
        headingLevel={2}
      />
    {:else if access.isPending}
      <Skeleton label={copy.loading} />
    {:else if access.data?.allowed}
      <ConnectedAppsProvider scope={access.data.scope} {cache} {transport}>
        <ConnectedApps
          showHeading={false}
          labelledby="settings-heading"
          workspaceLabel="This workspace"
        />
      </ConnectedAppsProvider>
    {:else}
      <EmptyState title={copy.disabled} description={copy.disabledDescription} headingLevel={2} />
    {/if}
  {/snippet}
</SettingsFrame>
