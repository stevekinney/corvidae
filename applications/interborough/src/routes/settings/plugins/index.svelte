<script lang="ts">
  /**
   * `/settings/plugins`: the plugins Interborough loaded at startup, with the open one beside the
   * list. A plugin's switch and configuration are drafts the page holds (`plugin-drafts.svelte.ts`),
   * and a banner counts them with Discard and Restart now. Restart now writes each changed plugin
   * and restarts the host (`restart-flow.svelte.ts`), then waits for the host to answer again.
   * Turning a plugin off asks first and lists what depends on it. A secret is saved at once, because
   * it needs no restart. The page reads `GET /host/plugins`; whether the host may be changed at all
   * is the host's to say (`lockReason`).
   */
  import {
    Alert,
    Banner,
    Button,
    EmptyState,
    ListDetail,
    PageHeader,
    SelectableRow,
    Skeleton,
    StatusDot,
  } from '@lostgradient/cinder';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { onDestroy, untrack } from 'svelte';

  import { PLUGINS_COPY, RETRY_LABEL } from '../../../app/copy.ts';
  import { showToast } from '../../../app/toast-host.svelte';
  import { getPlugins, type PluginStanding } from '../../../lib/host-plugins.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { routerSelectionLocationFor } from '../../../lib/router-selection-location.ts';
  import SettingsSectionNav from '../settings-section-nav.svelte';
  import DisableDialog from './disable-dialog.svelte';
  import PluginDetail from './plugin-detail.svelte';
  import { PluginDrafts } from './plugin-drafts.svelte.ts';
  import { isShadowed, listKey, sourceWord, statusOf } from './plugin-presentation.ts';
  import RestartDialog from './restart-dialog.svelte';
  import { RestartFlow } from './restart-flow.svelte.ts';
  import SecretDialog, { type SecretTarget } from './secret-dialog.svelte';
  import UnloadedFolders from './unloaded-folders.svelte';

  const copy = PLUGINS_COPY;
  const queryClient = useQueryClient();
  const selectionLocation = routerSelectionLocationFor('/settings/plugins');

  const plugins = createQuery(
    () => ({
      queryKey: queryKeys.hostPlugins(),
      queryFn: ({ signal }) => getPlugins({ signal }),
      // A failure is shown with Try again, not retried behind the person's back.
      retry: false,
    }),
    undefined,
  );

  const drafts = new PluginDrafts();
  const flow = new RestartFlow();
  onDestroy(() => flow.dispose());

  let disabling = $state<PluginStanding | null>(null);
  let secret = $state<SecretTarget | null>(null);

  const snapshot = $derived(plugins.data);
  const locked = $derived(snapshot?.lockReason !== undefined);
  const pendingCount = $derived(snapshot === undefined ? 0 : drafts.changeCount(snapshot));
  const invalid = $derived(snapshot !== undefined && drafts.hasInvalid(snapshot));

  // What a write reached the host with is no longer a draft, and neither is a change made elsewhere
  // that now matches one.
  $effect(() => {
    const current = plugins.data;
    if (current !== undefined) untrack(() => drafts.reconcile(current));
  });

  // The host answered again, or said it did not restart: the page shows what it reports now.
  $effect(() => {
    const result = flow.result;
    if (result === undefined) return;
    untrack(() => {
      queryClient.setQueryData(queryKeys.hostPlugins(), result);
      if (flow.phase === 'back') {
        drafts.discard();
        // The host started again: what the rest of the application kept is from the host that stopped.
        void queryClient.invalidateQueries();
      }
    });
  });

  // The host applied every write at once: nothing waits for a restart, so nothing is a draft.
  $effect(() => {
    if (!flow.saved) return;
    untrack(() => {
      drafts.discard();
      showToast(copy.banner.saved, { variant: 'success' });
      if (flow.result === undefined) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.hostPlugins() });
      }
    });
  });

  // A write that failed part way left some plugins written; the page reads them again.
  $effect(() => {
    if (flow.refusal !== undefined) {
      untrack(() => void queryClient.invalidateQueries({ queryKey: queryKeys.hostPlugins() }));
    }
  });

  function restart(): void {
    if (snapshot === undefined || invalid) return;
    void flow.run(
      drafts.writes(snapshot),
      snapshot.plugins.some((plugin) => plugin.restartRequired),
    );
  }

  // The dialog's Disable and restart writes everything the page holds, so it lists the other
  // changes and waits for text that cannot be applied to be fixed, as Restart now does.
  const otherChanges = $derived(
    snapshot === undefined || disabling === null
      ? []
      : drafts
          .pendingWrites(snapshot)
          .filter((change) => change.name !== disabling?.descriptor.name),
  );

  function confirmDisable(plugin: PluginStanding): void {
    if (invalid) return;
    drafts.setEnabled(plugin, false);
    disabling = null;
    restart();
  }

  const refusalWords = $derived(
    flow.refusal === 'save-failed'
      ? flow.rejection === undefined
        ? copy.banner.failed
        : copy.banner.rejected(flow.rejection.plugin)
      : flow.refusal === 'locked'
        ? copy.locked
        : flow.refusal === 'refused'
          ? copy.banner.refused
          : flow.refusal === 'unreachable'
            ? copy.banner.unreachable
            : '',
  );
</script>

<section class="ib-plugins" aria-label={copy.title} data-page="settings-plugins">
  <SettingsSectionNav />
  <PageHeader title={copy.title} description={copy.intro} />

  {#if locked}
    <Alert variant="info" data-testid="plugins-locked">
      <p class="ib-plugins__alert">{copy.locked}</p>
    </Alert>
  {/if}

  {#if pendingCount > 0}
    <Banner variant="warning" dismissible={false} data-testid="plugins-pending">
      <span class="ib-plugins__pending-text"
        >{copy.banner.changes(pendingCount)} {copy.banner.explanation}</span
      >
      {#snippet actions()}
        {#if drafts.hasDrafts}
          <Button
            variant="secondary"
            size="sm"
            onclick={() => {
              drafts.discard();
              flow.rejection = undefined;
            }}>{copy.banner.discard}</Button
          >
        {/if}
        <Button
          data-changes
          variant="primary"
          size="sm"
          disabled={invalid || flow.running}
          onclick={restart}>{copy.banner.restartNow}</Button
        >
      {/snippet}
    </Banner>
    {#if invalid}
      <p class="ib-plugins__hint">{copy.banner.invalid}</p>
    {/if}
  {/if}

  {#if refusalWords !== ''}
    <Alert variant="danger" data-testid="plugins-restart-refused">
      <p class="ib-plugins__alert">{refusalWords}</p>
    </Alert>
  {/if}

  {#if snapshot !== undefined}
    {#if snapshot.plugins.length === 0 && snapshot.unloaded.length === 0}
      <EmptyState
        kind="first-use"
        headingLevel={2}
        title={copy.empty.title}
        description={copy.empty.description}
      />
    {:else if snapshot.plugins.length > 0}
      <div class="ib-plugins__frame" data-shortcut-region="list-detail">
        <ListDetail
          items={[...snapshot.plugins]}
          key={(plugin) => listKey(snapshot, plugin)}
          label={copy.listLabel}
          detailLabel={copy.detailLabel}
          emptyTitle={copy.emptyDetail.title}
          emptyDescription={copy.emptyDetail.description}
          selectionParameter="plugin"
          {selectionLocation}
          storageKey="interborough-settings-plugins"
        >
          {#snippet header()}
            <p class="ib-plugins__count" data-testid="plugins-count">
              {copy.count(snapshot.plugins.length)}
            </p>
          {/snippet}
          {#snippet list(plugin, row)}
            {@const status = statusOf(
              plugin,
              isShadowed(snapshot, plugin) ? plugin.enabled : drafts.enabledOf(plugin),
            )}
            <SelectableRow
              selected={row.selected}
              selectedState="current"
              onclick={row.open}
              data-plugin-row={plugin.descriptor.name}
            >
              {#snippet title()}<span class="ib-plugins__identifier">{plugin.descriptor.name}</span
                >{/snippet}
              {#snippet description()}
                <StatusDot status={status.dot} label={status.label} labelVisible size="sm" />
              {/snippet}
              {#snippet meta()}{sourceWord(plugin.source)}{/snippet}
            </SelectableRow>
          {/snippet}
          {#snippet detail(plugin)}
            <PluginDetail
              {plugin}
              {drafts}
              locked={locked || isShadowed(snapshot, plugin)}
              rejection={flow.rejection?.plugin === plugin.descriptor.name
                ? flow.rejection
                : undefined}
              onDisable={(target) => (disabling = target)}
              onSecret={(target, key) => (secret = { plugin: target.descriptor.name, key })}
            />
          {/snippet}
        </ListDetail>
      </div>
    {/if}
    {#if snapshot.unloaded.length > 0}
      <UnloadedFolders folders={snapshot.unloaded} />
    {/if}
  {:else if plugins.isError}
    <Alert variant="danger" data-testid="plugins-load-failed">
      <p class="ib-plugins__alert-title">{copy.loadFailed.title}</p>
      <p class="ib-plugins__alert-body">{copy.loadFailed.description}</p>
      <Button variant="secondary" size="sm" onclick={() => void plugins.refetch()}
        >{RETRY_LABEL}</Button
      >
    </Alert>
  {:else}
    <div role="status" aria-busy="true" aria-label={copy.loading}>
      <Skeleton height="1.5rem" width="40%" />
      <Skeleton height="12rem" />
    </div>
  {/if}
</section>

<DisableDialog
  plugin={disabling}
  {otherChanges}
  {invalid}
  onConfirm={confirmDisable}
  onCancel={() => (disabling = null)}
/>
<SecretDialog bind:target={secret} />
<RestartDialog {flow} />

<style>
  .ib-plugins {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    min-width: 0;
  }

  /* ListDetail fills the height it is given and scrolls each pane, so the frame gives it one. */
  .ib-plugins__frame {
    block-size: max(28rem, calc(100dvh - 22rem));
    min-inline-size: 0;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
    overflow: hidden;
  }

  .ib-plugins__alert,
  .ib-plugins__pending-text,
  .ib-plugins__hint,
  .ib-plugins__count {
    margin: 0;
  }

  .ib-plugins__hint,
  .ib-plugins__count {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-plugins__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .ib-plugins__alert-body {
    margin: var(--cinder-space-1) 0 var(--cinder-space-2);
  }

  .ib-plugins__identifier {
    font-family: var(--cinder-font-mono);
    overflow-wrap: anywhere;
  }
</style>
