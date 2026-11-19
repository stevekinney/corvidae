<script lang="ts">
  /**
   * A page a plugin's panel places with `{ kind: 'page', path }` (COR-2213): `/plugins/<plugin>/<path>`.
   * The panel renders full-page through Chat's `McpApp` with `fill`, under a header with the panel's
   * title and "From <Plugin title>". The view frame's probe has already settled that the host serves
   * the address (not found, or a disabled plugin, are the frame's); this page words the rest:
   *
   * - loading is one Cinder skeleton named for the panel, and `McpApp` draws none of its own, since
   *   the page hands it the resource it loaded;
   * - a page that did not load, and an app that failed after it opened, say "Couldn’t open <title>"
   *   in the same Cinder error state with "Try again" and a link to the plugin in Settings;
   * - a plugin that needs setup shows its page under one note, with the one missing key's dialog or
   *   a link to Settings;
   * - a link the app opens inside Interborough moves the router, and any other address is refused
   *   with a toast.
   *
   * No plugin name, panel name or path is shown as words: the page, the breadcrumb, the sidebar and
   * the palette name each by its title.
   */
  import { McpApp } from '@lostgradient/chat';
  import { Button, Callout, ErrorState, Link, PageHeader, Skeleton } from '@lostgradient/cinder';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { usePageLabel } from '../../app/breadcrumbs.svelte.ts';
  import { PLUGIN_PAGE_COPY, pluginSettingsPath } from '../../app/copy/plugin-pages.ts';
  import NotFoundState from '../../app/not-found-state.svelte';
  import { showToast } from '../../app/toast-host.svelte';
  import { getPanels, loadPluginApp, pluginToolCaller } from '../../lib/host-panels.ts';
  import { getPlugins } from '../../lib/host-plugins.ts';
  import { findPluginPage } from '../../lib/plugin-pages.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import SecretDialog, { type SecretTarget } from '../settings/plugins/secret-dialog.svelte';

  const plugin = $derived(router.current.params['plugin'] ?? '');
  const path = $derived(router.current.params['*'] ?? '');

  const panels = createQuery(
    () => ({
      queryKey: queryKeys.hostPanels(),
      queryFn: ({ signal }) => getPanels({ signal }),
      retry: false,
      // The frame's probe has just read the panels; a failure it found is not read again on mount.
      retryOnMount: false,
    }),
    undefined,
  );
  const plugins = createQuery(
    () => ({
      queryKey: queryKeys.hostPlugins(),
      queryFn: ({ signal }) => getPlugins({ signal }),
      retry: false,
    }),
    undefined,
  );

  const page = $derived(findPluginPage(panels.data ?? [], plugin, path));
  const standing = $derived(
    plugins.data?.plugins.find((candidate) => candidate.descriptor.name === plugin),
  );
  const pluginTitle = $derived(standing?.descriptor.title);
  const settingsPath = $derived(pluginSettingsPath(plugin));

  // The page the host serves for the panel, which the view frame's probe reads under this key
  // (`app/view-probes.ts`) and this page only watches: the probe is the key's one reader. A second
  // reader here would race it. The page mounts while the probe is still reading the panels, so a
  // reader here fetches first, and when it fails the probe then reads the failed page again and
  // succeeds, taking the "Couldn’t open" state away without anyone asking. "Try again" asks through
  // the probe too, so the state a person reads is the answer of the one read.
  const resource = createQuery(
    () => ({
      queryKey: queryKeys.hostPanelPage(plugin, page?.app ?? ''),
      queryFn: ({ signal }) => loadPluginApp(plugin, page?.app ?? '', { signal }),
      enabled: false,
      retry: false,
    }),
    undefined,
  );
  const queryClient = useQueryClient();
  /** Asks the frame's probe again: it reads the panels, then the page, and says what became of both. */
  function tryAgain(): void {
    void queryClient.refetchQueries({
      queryKey: queryKeys.view('plugin-page', `${plugin}/${path}`),
    });
  }
  const panelUri = $derived(
    (panels.data ?? []).find(
      (candidate) => candidate.plugin === plugin && candidate.app === page?.app,
    )?.uri,
  );

  usePageLabel(() => ({ path: router.pathname, label: page?.title }));

  // A plugin that waits for secrets still opens its page, with one note above it. Exactly one missing
  // secret is added from here, in the dialog Settings uses; any other number is fixed in Settings.
  const missing = $derived((standing?.secrets ?? []).filter((secret) => !secret.set));
  const needsSetup = $derived(standing?.status === 'needs-setup');
  let secret = $state<SecretTarget | null>(null);

  function follow(event: MouseEvent, target: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(target);
  }

  function openLink(target: string): boolean {
    router.navigate(target);
    return true;
  }
</script>

{#snippet settingsLink()}
  <Button
    variant="secondary"
    size="sm"
    href={router.href(settingsPath)}
    onclick={(event) => follow(event, settingsPath)}
    >{PLUGIN_PAGE_COPY.failed.settings(pluginTitle)}</Button
  >
{/snippet}

{#snippet fromPlugin()}
  {@const owner = pluginTitle}
  {#if owner !== undefined}
    From <Link href={router.href(settingsPath)} onclick={(event) => follow(event, settingsPath)}
      >{owner}</Link
    >
  {/if}
{/snippet}

<div class="ib-plugin-page" data-section="plugin-page">
  {#if page === undefined}
    {#if panels.isPending}
      <Skeleton variant="card" lines={3} label={PLUGIN_PAGE_COPY.loading(undefined)} />
    {:else if panels.isError}
      <ErrorState
        title={PLUGIN_PAGE_COPY.failed.title(undefined)}
        description={PLUGIN_PAGE_COPY.failed.description(pluginTitle)}
        headingLevel={1}
        onRetry={tryAgain}
      />
    {:else}
      <!-- The host stopped serving the page after the view frame found it, such as a plugin turned off. -->
      <NotFoundState
        title={PLUGIN_PAGE_COPY.notFound.title}
        description={PLUGIN_PAGE_COPY.notFound.description}
        view="plugin-page"
        back={PLUGIN_PAGE_COPY.notFound.back}
        search={false}
      />
    {/if}
  {:else}
    <!-- The header is flush (Cinder's default): the page lays out its own column (the panel is edge
         to edge under it). At 320 pixels a two-line title and the "From" line are 79 pixels
         tall, and with the page's gap the panel starts within 96 pixels of the header's top (PL8-15). -->
    <PageHeader
      title={page.title}
      headingLevel={1}
      {...pluginTitle === undefined ? {} : { description: fromPlugin }}
    />
    {#if needsSetup && standing !== undefined}
      <Callout variant="warning" semantic="note">
        {PLUGIN_PAGE_COPY.needsSetup.note(standing.descriptor.title)}
        {#snippet action()}
          {#if missing.length === 1 && missing[0] !== undefined}
            {@const key = missing[0].key}
            <Button variant="secondary" size="sm" onclick={() => (secret = { plugin, key })}
              >{PLUGIN_PAGE_COPY.needsSetup.addKey}</Button
            >
          {:else}
            {@render settingsLink()}
          {/if}
        {/snippet}
      </Callout>
    {/if}
    {#if resource.isError && !resource.isFetching}
      <ErrorState
        title={PLUGIN_PAGE_COPY.failed.title(page.title)}
        description={PLUGIN_PAGE_COPY.failed.description(pluginTitle)}
        headingLevel={2}
        onRetry={tryAgain}
      >
        {#snippet secondaryAction()}{@render settingsLink()}{/snippet}
      </ErrorState>
    {:else if resource.data === undefined || panelUri === undefined}
      <Skeleton variant="card" lines={3} label={PLUGIN_PAGE_COPY.loading(page.title)} />
    {:else}
      <div class="ib-plugin-page__panel">
        <McpApp
          fill
          resourceUri={panelUri}
          title={page.title}
          preloadedResource={resource.data}
          loadResource={() => loadPluginApp(plugin, page.app)}
          onToolCall={pluginToolCaller(plugin, page.app)}
          onOpenLink={openLink}
          onOpenLinkRefused={() =>
            showToast(PLUGIN_PAGE_COPY.linkBlocked(page.title), { variant: 'warning' })}
          errorDescription={PLUGIN_PAGE_COPY.failed.description(pluginTitle)}
          errorAction={settingsLink}
        />
      </div>
    {/if}
  {/if}
</div>
<SecretDialog bind:target={secret} />

<style>
  /* The panel fills what is left of the outlet, to its bottom edge: the outlet has no bottom padding
     but ends in a spacer (`foundation.css`), so the page's negative margin takes that room back, and
     the app scrolls inside itself, never the page. */
  .ib-plugin-page {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    block-size: 100%;
    margin-block-end: calc(var(--cinder-space-6) * -1);
    min-block-size: 0;
  }

  .ib-plugin-page__panel {
    flex: 1 1 auto;
    min-block-size: 0;
  }
</style>
