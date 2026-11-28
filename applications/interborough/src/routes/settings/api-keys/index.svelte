<script lang="ts">
  import { ApiKeySettingsProvider } from '@lostgradient/api-key-settings/svelte';
  import ApiKeySettings from '@lostgradient/api-key-settings/ui';
  import { ErrorState, Skeleton } from '@lostgradient/cinder';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { API_KEY_SETTINGS_COPY, SETTINGS_SECTION_COPY } from '../../../app/copy/settings.ts';
  import { getPrincipalStore } from '../../../lib/scopes.svelte.ts';
  import { settingsTransport } from '../section-transport.ts';
  import SettingsFrame from '../settings-frame.svelte';
  import { readSettingsAccess, type SettingsAccess } from '../section-access.ts';

  let {
    initialAccess,
    documentPath,
  }: { initialAccess?: SettingsAccess; documentPath?: string | undefined } = $props();
  const cache = useQueryClient();
  const access = createQuery(() => ({
    queryKey: ['host', 'api-keys', 'access'],
    queryFn: ({ signal }) => readSettingsAccess('/host/api-keys/access', fetch, signal),
    ...(initialAccess === undefined ? {} : { initialData: initialAccess }),
    retry: false,
  }));

  const principal = getPrincipalStore();
  const transport = settingsTransport(
    '/host/api-keys',
    'api.keys.list',
    () => principal.principal?.method === 'browser-session',
  );
</script>

<SettingsFrame
  title={SETTINGS_SECTION_COPY.apiKeys}
  intro={API_KEY_SETTINGS_COPY.intro}
  page="settings-api-keys"
  staticState={access.isPending ? 'loading' : access.isError ? 'error' : 'ready'}
  {documentPath}
>
  {#snippet staticBody()}
    {#if access.isError}
      <ErrorState
        title={API_KEY_SETTINGS_COPY.unavailable}
        description={API_KEY_SETTINGS_COPY.unavailableDescription}
        onRetry={() => void access.refetch()}
        headingLevel={2}
      />
    {:else if access.isPending}
      <Skeleton label={API_KEY_SETTINGS_COPY.loading} />
    {:else if access.data?.allowed}
      <ApiKeySettingsProvider scope={access.data.scope} {cache} {transport}>
        <ApiKeySettings showHeading={false} />
      </ApiKeySettingsProvider>
    {:else}
      <ErrorState
        title={API_KEY_SETTINGS_COPY.denied}
        description={API_KEY_SETTINGS_COPY.deniedDescription}
        headingLevel={2}
      />
    {/if}
  {/snippet}
</SettingsFrame>
