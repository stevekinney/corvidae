<script lang="ts">
  /**
   * `/settings/plugins`: the plugins Interborough loaded at startup, with the open one beside the
   * list. A plugin's switch and configuration are drafts the page holds (`plugin-drafts.svelte.ts`),
   * and a banner counts them with Discard and Restart now. Restart now writes each changed plugin
   * and restarts the host (`restart-flow.svelte.ts`), then waits for the host to answer again; the
   * restart asks first, shows its progress in the shell's restart dialog (`app/restart`) and, once
   * the host is back, says what applied in a banner. Turning a plugin off asks first and lists what
   * depends on it. A secret is saved at once, because
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

  import { PLUGINS_COPY, RESTART_COPY, RETRY_LABEL } from '../../../app/copy.ts';
  import type { RestartIntent } from '../../../app/restart/host-restart-flow.svelte.ts';
  import RestartBackBanner from '../../../app/restart/restart-back-banner.svelte';
  import RestartConfirmDialog from '../../../app/restart/restart-confirm-dialog.svelte';
  import RestartDialog from '../../../app/restart/restart-dialog.svelte';
  import { showToast } from '../../../app/toast-host.svelte';
  import {
    getPlugins,
    type PluginProblem,
    type PluginsSnapshot,
    type PluginStanding,
  } from '../../../lib/host-plugins.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { routerSelectionLocationFor } from '../../../lib/router-selection-location.ts';
  import SettingsSectionNav from '../settings-section-nav.svelte';
  import DisableDialog from './disable-dialog.svelte';
  import PluginDetail from './plugin-detail.svelte';
  import { PluginDrafts } from './plugin-drafts.svelte.ts';
  import {
    clashCounterpart,
    isShadowed,
    listKey,
    restartBackWords,
    sourceWord,
    statusOf,
    unavailableAfterDisable,
  } from './plugin-presentation.ts';
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
  let confirmingRestart = $state(false);
  let secret = $state<SecretTarget | null>(null);
  // The open plugin's key. The list fills it from the address, and a problem's `Show both` sets it.
  let openKey = $state<string | null>(null);

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

  /**
   * What the restart applies, in the plugins' own names: the ones the page holds a change for, and
   * the ones the host already stores a change for that wait for a restart.
   */
  function intentFor(current: PluginsSnapshot, turningOff?: PluginStanding): RestartIntent {
    const titles = new Map(
      current.plugins.map((plugin) => [plugin.descriptor.name, plugin.descriptor.title]),
    );
    const changed = new Set(drafts.pendingWrites(current).map((change) => change.name));
    for (const plugin of current.plugins) {
      if (plugin.restartRequired) changed.add(plugin.descriptor.name);
    }
    const changes = [...changed].map((name) => titles.get(name) ?? name);
    // The plugin turned off is the only change: the banner then says what became of it.
    const alone =
      turningOff !== undefined && changed.size === 1 && changed.has(turningOff.descriptor.name);
    return alone
      ? {
          changes,
          disabling: {
            title: turningOff.descriptor.title,
            unavailable: unavailableAfterDisable(turningOff),
          },
        }
      : { changes };
  }

  function restart(turningOff?: PluginStanding): void {
    if (snapshot === undefined || invalid) return;
    void flow.run(
      drafts.writes(snapshot),
      snapshot.plugins.some((plugin) => plugin.restartRequired),
      intentFor(snapshot, turningOff),
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
    restart(plugin);
  }

  // What `Show both` does for a name clash: open the other plugin that holds the name, or nothing
  // when that plugin is not in the list.
  function showBoth(plugin: PluginStanding, problem: PluginProblem): (() => void) | undefined {
    if (snapshot === undefined) return undefined;
    const other = clashCounterpart(snapshot, plugin, problem);
    if (other === undefined) return undefined;
    const key = listKey(snapshot, other);
    return () => (openKey = key);
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
          onclick={() => (confirmingRestart = true)}>{copy.banner.restartNow}</Button
        >
      {/snippet}
    </Banner>
    {#if invalid}
      <p class="ib-plugins__hint">{copy.banner.invalid}</p>
    {/if}
  {/if}

  {#if flow.phase === 'back'}
    {@const back = restartBackWords(flow.intent, flow.result)}
    <RestartBackBanner title={back.title} text={back.text} onDismiss={() => flow.close()} />
  {:else if flow.phase === 'unconfirmed'}
    <Alert
      variant="warning"
      dismissible
      onDismiss={() => flow.close()}
      data-testid="plugins-restart-unconfirmed"
    >
      <p class="ib-plugins__alert-title">{RESTART_COPY.unconfirmed.title}</p>
      <p class="ib-plugins__alert-body">{RESTART_COPY.unconfirmed.description}</p>
    </Alert>
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
          bind:selectedKey={openKey}
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
              {showBoth}
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
<RestartConfirmDialog
  bind:open={confirmingRestart}
  changes={pendingCount}
  onConfirm={() => restart()}
/>
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
