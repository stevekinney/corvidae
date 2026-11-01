<script lang="ts">
  /**
   * `/settings/models`: one page, three sections, no tabs. Providers (Connect, or Connected with
   * Manage), Models (the catalog, edited through `PUT /host/catalog`), and Decisions (the decision
   * model, its fallback and its limit per task, which are Bureau settings and are saved with
   * `bureau.settings.update` like the rest of Settings). The Decisions section is the settings
   * editor over `decisions.*` (`../settings-frame.svelte`); the first two read the host's providers.
   */
  import { Alert, Button, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { MODELS_COPY, RETRY_LABEL } from '../../../app/copy.ts';
  import { getProviders } from '../../../lib/host-providers.ts';
  import { returnPathOf } from '../../../lib/provider-return.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import SettingsFrame from '../settings-frame.svelte';
  import ModelsSection from './models-section.svelte';
  import ProvidersSection from './providers-section.svelte';

  const providers = createQuery(
    () => ({
      queryKey: queryKeys.hostProviders(),
      queryFn: ({ signal }) => getProviders({ signal }),
      retry: false,
    }),
    undefined,
  );

  // A page that needs a provider (the agent editor with no model to offer) sends the person here
  // with the way back. Read once: the page is mounted per address.
  const returnPath = router.current.search.has('return')
    ? returnPathOf(router.current.search)
    : null;
  const connected = $derived(providers.data?.providers.some((entry) => entry.hasKey) === true);

  function goBack(event: MouseEvent): void {
    if (returnPath === null) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(returnPath);
  }

  /** The provider whose Connect or Manage dialog is open. */
  let connecting = $state<string | null>(null);

  /** The first provider with no key, which the empty Models list offers to connect. */
  function firstToConnect(): string | null {
    const entries = providers.data?.providers ?? [];
    return (entries.find((entry) => !entry.hasKey) ?? entries[0])?.name ?? null;
  }
</script>

<SettingsFrame
  section="decisions"
  title={MODELS_COPY.title}
  intro={MODELS_COPY.intro}
  page="settings-models"
>
  {#snippet before()}
    {#if returnPath !== null}
      <Alert variant={connected ? 'success' : 'info'} data-testid="models-return">
        <p class="ib-models-page__alert-title">{MODELS_COPY.returnNotice.title}</p>
        <p class="ib-models-page__alert-body">
          {connected
            ? MODELS_COPY.returnNotice.connectedDescription
            : MODELS_COPY.returnNotice.description}
        </p>
        <Button
          variant={connected ? 'primary' : 'secondary'}
          size="sm"
          href={router.href(returnPath)}
          onclick={goBack}>{MODELS_COPY.returnNotice.action}</Button
        >
      </Alert>
    {/if}
    {#if providers.data !== undefined}
      <ProvidersSection snapshot={providers.data} bind:connecting />
      <ModelsSection snapshot={providers.data} onConnect={() => (connecting = firstToConnect())} />
    {:else if providers.isError}
      <Alert variant="danger" data-testid="models-load-failed">
        <p class="ib-models-page__alert-title">{MODELS_COPY.loadFailed.title}</p>
        <p class="ib-models-page__alert-body">{MODELS_COPY.loadFailed.description}</p>
        <Button variant="secondary" size="sm" onclick={() => void providers.refetch()}
          >{RETRY_LABEL}</Button
        >
      </Alert>
    {:else}
      <div role="status" aria-busy="true" aria-label={MODELS_COPY.loading}>
        <Skeleton height="1.5rem" width="40%" />
        <Skeleton height="10rem" />
      </div>
    {/if}
  {/snippet}
</SettingsFrame>

<style>
  .ib-models-page__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .ib-models-page__alert-body {
    margin: var(--cinder-space-1) 0 var(--cinder-space-2);
  }
</style>
