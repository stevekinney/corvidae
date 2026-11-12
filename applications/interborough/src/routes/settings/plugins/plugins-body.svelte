<script lang="ts">
  /**
   * The body of Settings › Plugins (board PageSettingsSections, "Plugins, /settings/plugins"): the
   * plugins Interborough loaded at startup as a list with the open one beside it, under the restart
   * notice every section of Settings shares. The notice counts the plugins that wait for a restart
   * with the settings that do, and Revert and Restart now act on both.
   *
   * A plugin's switch is a draft the page holds (`plugin-drafts.svelte.ts`); Restart now writes each
   * switched plugin and restarts the host (`restart-flow.svelte.ts`), then waits for the host to
   * answer again. A plugin's configuration is saved by its own Save and waits for a restart. A
   * secret is saved at once, because it needs no restart. The page reads `GET /host/plugins`; whether
   * the host may be changed at all is the host's to say (`lockReason`).
   */
  import {
    Alert,
    Banner,
    Button,
    EmptyState,
    Link,
    ListDetail,
    SelectableRow,
    Skeleton,
    StatusDot,
  } from '@lostgradient/cinder';
  import { useQueryClient, type CreateQueryResult } from '@tanstack/svelte-query';
  import { onDestroy, tick, untrack } from 'svelte';

  import { PLUGINS_COPY } from '../../../app/copy/plugins.ts';
  import { SETTINGS_COPY } from '../../../app/copy/settings.ts';
  import type { RestartIntent } from '../../../app/restart/host-restart-flow.svelte.ts';
  import { dismissToast, showToast } from '../../../app/toast-host.svelte';
  import {
    getSettings,
    updateSettings,
    type SettingKeyState,
    type SettingsSchema,
    type SettingsSnapshot,
  } from '../../../lib/bureau-settings.ts';
  import {
    didNotLoadCount,
    PluginsReadError,
    type PluginProblem,
    type PluginsSnapshot,
    type PluginStanding,
  } from '../../../lib/host-plugins.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import { routerSelectionLocationFor } from '../../../lib/router-selection-location.ts';
  import ConnectDialog from '../models/connect-dialog.svelte';
  import { controlFor, settingLabel, type Control } from '../settings-controls.ts';
  import { SettingsForm } from '../settings-form.svelte.ts';
  import SettingsRestartNotice from '../settings-restart-notice.svelte';
  import { SettingsRevert } from '../settings-revert.svelte.ts';
  import DisableDialog from './disable-dialog.svelte';
  import EnableDialog from './enable-dialog.svelte';
  import { focusConfiguration } from './focus-configuration.ts';
  import PluginDetail from './plugin-detail.svelte';
  import { PluginDrafts } from './plugin-drafts.svelte.ts';
  import PluginProblemCard from './plugin-problem-card.svelte';
  import {
    clashCounterpart,
    isShadowed,
    listKey,
    providerOf,
    restartBackWords,
    sourceWord,
    statusOf,
    unavailableAfterDisable,
  } from './plugin-presentation.ts';
  import { revertPlugins } from './plugin-revert.ts';
  import { RestartFlow } from './restart-flow.svelte.ts';
  import SecretDialog, { type SecretTarget } from './secret-dialog.svelte';
  import UnloadedFolders from './unloaded-folders.svelte';

  interface Props {
    /** The read of the host's plugins, which the page starts before the settings are in. */
    plugins: CreateQueryResult<PluginsSnapshot, Error>;
    schema: SettingsSchema;
    snapshot: SettingsSnapshot;
  }

  let { plugins, schema, snapshot: settings }: Props = $props();

  const copy = PLUGINS_COPY;
  const queryClient = useQueryClient();
  const selectionLocation = routerSelectionLocationFor('/settings/plugins');

  // The settings machinery the notice shares with the other sections: a form over the schema holds
  // the drafts Revert writes through, and the revision it writes against.
  const controls = new Map<string, Control>(
    untrack(() => Object.entries(schema).map(([key, node]) => [key, controlFor(key, node)])),
  );
  const UNKNOWN_STATE: SettingKeyState = { apply: 'live', locked: false, pendingRestart: false };
  const stateOf = (key: string): SettingKeyState => settings.keys[key] ?? UNKNOWN_STATE;
  const form = new SettingsForm(controls, (key) => stateOf(key).locked);
  untrack(() => form.load(settings));

  const readSettings = (): Promise<SettingsSnapshot> =>
    queryClient.fetchQuery({
      queryKey: queryKeys.settings.snapshot(),
      queryFn: ({ signal }) => getSettings({ signal }),
      staleTime: 0,
    });

  const revert = new SettingsRevert({
    form,
    update: (patch, expectedRevision) => updateSettings(patch, expectedRevision),
    read: readSettings,
    showUndo: (message, undo) => showToast(message, { undo }),
    dismiss: dismissToast,
    fail: (message) => void showToast(message, { variant: 'danger' }),
  });
  onDestroy(() => revert.dispose());

  // The settings were read again: every setting takes them.
  $effect(() => {
    const latest = settings;
    untrack(() => {
      if (latest.revision !== form.revision) form.rebase(latest);
    });
  });

  /** The settings that wait for a restart, in the schema's order. */
  const restartKeys = $derived(Object.keys(schema).filter((key) => stateOf(key).pendingRestart));

  const drafts = new PluginDrafts();
  const flow = new RestartFlow();
  onDestroy(() => flow.dispose());

  let disabling = $state<PluginStanding | null>(null);
  let enabling = $state<PluginStanding | null>(null);
  let secret = $state<SecretTarget | null>(null);
  let connecting = $state<string | null>(null);
  // The open plugin's key. The list fills it from the address, and a problem's `Show both` sets it.
  let openKey = $state<string | null>(null);
  /** Whether the person gave up on a read that took longer than usual. */
  let canceled = $state(false);
  let reverting = $state(false);

  const snapshot = $derived(plugins.data);
  const locked = $derived(snapshot?.lockReason !== undefined);
  /** The plugins that wait for a restart: the switches the page holds and the choices the host stores. */
  const waiting = $derived(snapshot === undefined ? [] : drafts.changed(snapshot));

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
      queryClient.setQueryData(queryKeys.hostPlugins(), result.plugins);
      queryClient.setQueryData(queryKeys.settings.snapshot(), result.settings);
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
   * What the restart applies, in the names a person reads: the settings that wait, and the plugins
   * the page holds a change for or the host stores one for.
   */
  function intentFor(current: PluginsSnapshot, turningOff?: PluginStanding): RestartIntent {
    const changed = drafts.changed(current);
    const changes = [
      ...restartKeys.map(settingLabel),
      ...changed.map((plugin) => plugin.descriptor.title),
    ];
    // The plugin turned off is the only plugin change: the dialog and the banner then say what
    // became of it, even while a setting also waits for the restart (board PageSettingsSections,
    // "Disable, failed" and "Disable, back up").
    const alone =
      turningOff !== undefined &&
      changed.length === 1 &&
      changed[0]?.descriptor.name === turningOff.descriptor.name;
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
    if (snapshot === undefined) return;
    void flow.run(
      drafts.pendingWrites(snapshot),
      // A setting that waits for a restart is restarted for too, with or without a plugin change.
      restartKeys.length > 0 || snapshot.plugins.some((plugin) => plugin.restartRequired),
      intentFor(snapshot, turningOff),
    );
  }

  /** Puts every waiting plugin back to what the host runs, and drops the switches the page holds. */
  async function revertWaiting(): Promise<void> {
    if (snapshot === undefined) return;
    reverting = true;
    const stored = waiting;
    drafts.discard();
    flow.rejection = undefined;
    try {
      await revertPlugins(stored);
    } catch {
      showToast(SETTINGS_COPY.general.reverted.revertFailed, { variant: 'danger' });
    } finally {
      reverting = false;
      await queryClient.invalidateQueries({ queryKey: queryKeys.hostPlugins() });
    }
  }

  // A confirmation's restart writes everything the page holds, so it lists the other switches it
  // will write.
  const otherChanges = $derived.by(() => {
    const target = disabling ?? enabling;
    return snapshot === undefined || target === null
      ? []
      : drafts.pendingWrites(snapshot).filter((change) => change.name !== target.descriptor.name);
  });

  /** Turns the plugin off or on, as the person confirmed, and restarts so the host loads what is left. */
  function confirmSwitch(plugin: PluginStanding, enabled: boolean): void {
    drafts.setEnabled(plugin, enabled);
    disabling = null;
    enabling = null;
    // Only a plugin turned off is named in the dialog and the banner after it.
    restart(enabled ? undefined : plugin);
  }

  /**
   * After a startup where something did not load, the problems of every plugin are listed above the
   * list, each under the plugin's name (board PageSettingsSections, "Plugin problems"), so what to
   * fix is in one place and each plugin's page need not draw them again.
   */
  const attention = $derived.by(() => {
    if (snapshot === undefined || didNotLoadCount(snapshot) === 0) return [];
    return snapshot.plugins.flatMap((plugin) =>
      plugin.problems.map((problem, index) => ({
        key: `${listKey(snapshot, plugin)}#${String(index)}`,
        plugin,
        problem,
      })),
    );
  });

  /** Adds the missing secret `key` of a plugin: a provider through the connect flow, any other in the secret dialog. */
  function addSecret(plugin: PluginStanding, key: string): void {
    const provider = providerOf(plugin);
    if (provider !== undefined) connecting = provider;
    else secret = { plugin: plugin.descriptor.name, key };
  }

  /** Opens the plugin and moves to its configuration, which is where a setting the host refused is fixed. */
  async function fixSetting(plugin: PluginStanding): Promise<void> {
    if (snapshot === undefined) return;
    openKey = listKey(snapshot, plugin);
    await tick();
    focusConfiguration(plugin.descriptor.name);
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

  const saveFailedWords = $derived(
    flow.refusal !== 'save-failed'
      ? ''
      : flow.rejection === undefined
        ? copy.banner.failed
        : copy.banner.rejected(flow.rejection.plugin),
  );

  const failureStatus = $derived(
    plugins.error instanceof PluginsReadError ? plugins.error.status : undefined,
  );

  function cancelLoading(): void {
    canceled = true;
    void queryClient.cancelQueries({ queryKey: queryKeys.hostPlugins() });
  }

  function tryAgain(): void {
    canceled = false;
    void plugins.refetch();
  }

  function openHealth(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate('/health');
  }
</script>

<SettingsRestartNotice
  keys={restartKeys}
  snapshot={settings}
  {flow}
  {revert}
  extra={{
    labels: waiting.map((plugin) => plugin.descriptor.title),
    revert: revertWaiting,
    busy: reverting,
  }}
  onRestart={() => restart()}
  back={flow.phase === 'back' ? restartBackWords(flow.intent, flow.result?.plugins) : undefined}
/>

<div class="ib-plugins" data-testid="plugins-body">
  {#if locked}
    <Alert variant="info" data-testid="plugins-locked">
      <p class="ib-plugins__alert">{copy.locked}</p>
    </Alert>
  {/if}

  {#if saveFailedWords !== ''}
    <Alert variant="danger" data-testid="plugins-restart-refused">
      <p class="ib-plugins__alert">{saveFailedWords}</p>
    </Alert>
  {/if}

  {#if snapshot !== undefined}
    {#if attention.length > 0}
      <section
        class="ib-plugins__attention"
        aria-label={copy.problems.listLabel}
        data-testid="plugins-attention"
      >
        {#each attention as entry (entry.key)}
          <PluginProblemCard
            problem={entry.problem}
            plugin={entry.plugin}
            owner={entry.plugin.descriptor.title}
            locked={locked || isShadowed(snapshot, entry.plugin)}
            onSecret={(key) => addSecret(entry.plugin, key)}
            onFixSetting={() => void fixSetting(entry.plugin)}
            onShowBoth={showBoth(entry.plugin, entry.problem)}
          />
        {/each}
      </section>
    {/if}
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
          openFirst
          selectionParameter="plugin"
          {selectionLocation}
          storageKey="interborough-settings-plugins"
        >
          {#snippet header()}
            <div class="ib-plugins__list-top">
              <h2 class="ib-plugins__heading" data-testid="plugins-count">
                {copy.listHeader.heading}
                <span class="ib-plugins__total">{snapshot.plugins.length}</span>
              </h2>
              <Link href={copy.listHeader.howToAddHref} external>{copy.listHeader.howToAdd}</Link>
            </div>
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
              {#snippet title()}
                <span class="ib-plugins__row-line">
                  <span class="ib-plugins__row-name">{plugin.descriptor.title}</span>
                  <span class="ib-plugins__row-version">{plugin.descriptor.version}</span>
                </span>
              {/snippet}
              {#snippet description()}
                <span class="ib-plugins__row-line">
                  <StatusDot status={status.dot} label={status.label} labelVisible size="sm" />
                  <span class="ib-plugins__row-kind">{sourceWord(plugin.source)}</span>
                </span>
              {/snippet}
            </SelectableRow>
          {/snippet}
          {#snippet detail(plugin)}
            <PluginDetail
              {plugin}
              {drafts}
              locked={locked || isShadowed(snapshot, plugin)}
              onDisable={(target) => (disabling = target)}
              onEnable={(target) => (enabling = target)}
              problemsListed={attention.length > 0}
              onSecret={(target, key) => (secret = { plugin: target.descriptor.name, key })}
              onConnect={(provider) => (connecting = provider)}
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
    <Banner
      variant="danger"
      dismissible={false}
      title={copy.loadFailed.title}
      data-testid="plugins-load-failed"
    >
      {copy.loadFailed.description(failureStatus)}
      {#snippet actions()}
        <Button variant="secondary" size="sm" onclick={tryAgain}>{copy.loading.tryAgain}</Button>
        <Button variant="ghost" size="sm" href={router.href('/health')} onclick={openHealth}
          >{copy.loadFailed.openHealth}</Button
        >
      {/snippet}
    </Banner>
  {:else if canceled}
    <div data-testid="plugins-canceled">
      <p class="ib-plugins__alert">{copy.loading.canceled}</p>
      <Button variant="secondary" size="sm" onclick={tryAgain}>{copy.loading.tryAgain}</Button>
    </div>
  {:else}
    <!-- The navigation and heading are real; the rows are placeholders after 300 ms, then say it is slow. -->
    <Skeleton
      variant="card"
      lines={4}
      delay={300}
      stillLoadingAfter={10_000}
      stillLoadingLabel={copy.loading.stillLoading}
      label={copy.loading.label}
      onCancel={cancelLoading}
    />
  {/if}
</div>

<DisableDialog
  plugin={disabling}
  {otherChanges}
  onConfirm={(plugin) => confirmSwitch(plugin, false)}
  onCancel={() => (disabling = null)}
/>
<EnableDialog
  plugin={enabling}
  {otherChanges}
  onConfirm={(plugin) => confirmSwitch(plugin, true)}
  onCancel={() => (enabling = null)}
/>
<SecretDialog bind:target={secret} />
<ConnectDialog bind:provider={connecting} />

<style>
  .ib-plugins {
    grid-area: content;
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    max-inline-size: var(--ib-settings-content-width);
    min-inline-size: 0;
  }

  /* ListDetail fills the height it is given and scrolls each pane, so the frame gives it one. */
  .ib-plugins__frame {
    block-size: max(32rem, calc(100dvh - 13rem));
    min-inline-size: 0;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
    overflow: hidden;
  }

  .ib-plugins__alert {
    margin: 0;
  }

  .ib-plugins__attention {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-inline-size: 0;
  }

  .ib-plugins__list-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-2);
    padding: var(--cinder-space-2) var(--cinder-space-3);
  }

  .ib-plugins__heading {
    margin: 0;
    font-size: var(--cinder-text-sm);
    font-weight: 600;
  }

  .ib-plugins__total {
    color: var(--cinder-text-muted);
    font-weight: 400;
  }

  .ib-plugins__row-line {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--cinder-space-2);
  }

  .ib-plugins__row-name {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .ib-plugins__row-version,
  .ib-plugins__row-kind {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
    white-space: nowrap;
  }
</style>
