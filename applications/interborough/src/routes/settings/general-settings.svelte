<script lang="ts">
  /**
   * The body of Settings › General (board SettingsShell, "General · /settings"): the Bureau's
   * settings in four sections (Tools, Runs, Storage, Your preferences), one Cinder `SettingRow` each,
   * and the sticky banner that counts the saved changes waiting for a restart. Every setting saves
   * when its field is left and says so on its own row (`settings-autosave.svelte.ts`); there is no
   * page-level Save. The page follows the Bureau: a change made elsewhere is taken in for every
   * setting that is not being edited.
   *
   * The Bureau's `engine.*` keys are never shown under that name: they sit under Runs. In remote mode
   * the settings the deployment locks, and the storage backend, move into a "Remote deployment"
   * card, where each says who owns it. The preferences are this browser's: the theme, the sidebar,
   * the agent a new chat starts with and the keyboard.
   */
  import {
    Banner,
    Button,
    FormSection,
    Segment,
    SegmentedControl,
    Select,
    SettingRow,
    Toggle,
    formatTimeOfDay,
    validateSchemaFormValue,
  } from '@lostgradient/cinder';
  import { RotateCw, TriangleAlert } from '@lucide/svelte';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { onDestroy, untrack } from 'svelte';

  import { RESTART_COPY, SETTINGS_COPY } from '../../app/copy.ts';
  import { getKeyboardPreferences } from '../../app/keyboard-preferences.svelte.ts';
  import { getLayoutPreferences } from '../../app/layout-preferences.svelte.ts';
  import { HostRestartFlow } from '../../app/restart/host-restart-flow.svelte.ts';
  import RestartBackBanner from '../../app/restart/restart-back-banner.svelte';
  import RestartConfirmDialog from '../../app/restart/restart-confirm-dialog.svelte';
  import RestartDialog from '../../app/restart/restart-dialog.svelte';
  import { getTheme, type ThemeMode } from '../../app/theme.svelte.ts';
  import { dismissToast, showToast } from '../../app/toast-host.svelte';
  import {
    getSettings,
    updateSettings,
    type SettingKeyState,
    type SettingsSchema,
    type SettingsSnapshot,
  } from '../../lib/bureau-settings.ts';
  import { defaultAgentQuery, listAgentsWithReadiness } from '../../lib/default-agent.ts';
  import { getHostPaths } from '../../lib/host-paths.ts';
  import { readPreferredAgent, writePreferredAgent } from '../../lib/preferred-agent.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { generalSections } from './general-sections.ts';
  import SettingField from './setting-field.svelte';
  import { SettingsAutosave } from './settings-autosave.svelte.ts';
  import { controlFor, settingLabel, type Control } from './settings-controls.ts';
  import { formSchemaOf, numbersCommitted } from './settings-form-schema.ts';
  import { SettingsForm } from './settings-form.svelte.ts';
  import { SettingsRevert } from './settings-revert.svelte.ts';

  interface Props {
    schema: SettingsSchema;
    snapshot: SettingsSnapshot;
  }

  let { schema, snapshot }: Props = $props();

  const queryClient = useQueryClient();
  const theme = getTheme();
  const layout = getLayoutPreferences();
  const keyboard = getKeyboardPreferences();

  const hostPaths = createQuery(
    () => ({
      queryKey: queryKeys.hostPaths(),
      queryFn: ({ signal }) => getHostPaths({ signal }),
      retry: false,
    }),
    undefined,
  );
  const remote = $derived(hostPaths.data?.mode === 'remote');
  const words = $derived(
    remote
      ? { ...SETTINGS_COPY.hostPaths, ...SETTINGS_COPY.remote.hostPaths }
      : SETTINGS_COPY.hostPaths,
  );

  const controls = new Map<string, Control>(
    untrack(() => Object.entries(schema).map(([key, node]) => [key, controlFor(key, node)])),
  );

  /** What a key without a state from the Bureau is: a live key nothing holds. */
  const UNKNOWN_STATE: SettingKeyState = { apply: 'live', locked: false, pendingRestart: false };

  function stateOf(key: string): SettingKeyState {
    return snapshot.keys[key] ?? UNKNOWN_STATE;
  }

  async function validate(key: string, value: unknown): Promise<string | undefined> {
    const node = schema[key];
    if (node === undefined) return undefined;
    const result = await validateSchemaFormValue(formSchemaOf(key, node), value);
    return result.valid ? undefined : (result.issues[0]?.message ?? SETTINGS_COPY.invalidValue);
  }

  function committed(key: string, value: unknown): boolean {
    const node = schema[key];
    return node === undefined || numbersCommitted(formSchemaOf(key, node), value);
  }

  const form = new SettingsForm(controls, (key) => stateOf(key).locked, validate, committed);
  untrack(() => form.load(snapshot));

  /** Reads the settings again, into the page's own query. */
  const readSettings = (): Promise<SettingsSnapshot> =>
    queryClient.fetchQuery({
      queryKey: queryKeys.settings.snapshot(),
      queryFn: ({ signal }) => getSettings({ signal }),
      staleTime: 0,
    });

  const autosave = new SettingsAutosave({
    form,
    update: (patch, expectedRevision) => updateSettings(patch, expectedRevision),
    read: readSettings,
  });

  // The restart banner's Revert, and the Undo toast it leaves until the page is left.
  const revert = new SettingsRevert({
    form,
    update: (patch, expectedRevision) => updateSettings(patch, expectedRevision),
    read: readSettings,
    showUndo: (message, undo) => showToast(message, { undo }),
    dismiss: dismissToast,
    fail: (message) => void showToast(message, { variant: 'danger' }),
  });
  onDestroy(() => revert.dispose());

  // The settings were read again: every setting not being edited takes them. A save in flight
  // reads them again itself and takes them when it is done, so this waits for it.
  $effect(() => {
    const latest = snapshot;
    if (autosave.busy) return;
    untrack(() => {
      if (latest.revision !== form.revision) form.rebase(latest);
    });
  });

  const sections = $derived(
    generalSections(Object.keys(schema), (key) => stateOf(key).locked, remote),
  );

  /** The settings that wait for a restart, in the order the page lists them. */
  const restartKeys = $derived(
    sections.flatMap((section) => section.keys).filter((key) => stateOf(key).pendingRestart),
  );

  const restartFlow = new HostRestartFlow<SettingsSnapshot>({
    read: () => getSettings(),
    waiting: (current) => Object.values(current.keys).some((key) => key.pendingRestart),
  });
  onDestroy(() => restartFlow.dispose());
  let confirmingRestart = $state(false);
  const restartRefusalWords = $derived(
    restartFlow.refusal === undefined || restartFlow.refusal === 'save-failed'
      ? ''
      : RESTART_COPY.refusal[restartFlow.refusal],
  );

  /** When the host came back, and which settings the restart applied, for their rows ("In effect since 10:44 AM"). */
  let appliedAt = $state<number | undefined>(undefined);
  let appliedLabels = $state<readonly string[]>([]);
  $effect(() => {
    if (restartFlow.phase !== 'back') return;
    untrack(() => {
      appliedAt = Date.now();
      appliedLabels = restartFlow.intent.changes;
      void queryClient.invalidateQueries();
    });
  });

  function appliedNoteOf(key: string): string | undefined {
    if (appliedAt === undefined || !appliedLabels.includes(settingLabel(key))) return undefined;
    return SETTINGS_COPY.general.inEffectSince(formatTimeOfDay(appliedAt));
  }

  // The agents a new chat can start with, and the one it starts with now.
  const agents = createQuery(
    () => ({
      queryKey: [...queryKeys.agents.list(), 'readiness'] as const,
      queryFn: () => listAgentsWithReadiness(),
      retry: false,
    }),
    undefined,
  );
  const defaultAgent = createQuery(() => defaultAgentQuery(), undefined);
  let preferredAgent = $state<string | undefined>(readPreferredAgent());
  const agentChoice = $derived(preferredAgent ?? defaultAgent.data ?? '');

  function chooseAgent(name: string): void {
    preferredAgent = name;
    writePreferredAgent(name);
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents.default() });
  }

  const THEME_OPTIONS: readonly ThemeMode[] = ['system', 'light', 'dark'];
</script>

{#snippet backendRow(remoteMode: boolean)}
  {@const copy = SETTINGS_COPY.general.storageBackend}
  <div class="weft-general__row" data-setting={copy.identifier}>
    <SettingRow
      id="weft-setting-storage-backend"
      label={copy.label}
      identifier={copy.identifier}
      description={remoteMode ? copy.remoteDescription : copy.description}
      {...remoteMode ? { managed: { message: copy.setByDeployment } } : {}}
    >
      {#snippet control()}
        <span class="weft-general__value" data-testid="storage-backend-value"
          >{remoteMode ? copy.remote : copy.local}</span
        >
      {/snippet}
    </SettingRow>
  </div>
{/snippet}

{#snippet field(key: string, remoteCard: boolean)}
  {@const node = schema[key]}
  {@const control = controls.get(key)}
  {#if node !== undefined && control !== undefined}
    <SettingField
      name={key}
      {node}
      {control}
      {form}
      keyState={stateOf(key)}
      {autosave}
      appliedNote={appliedNoteOf(key)}
      reverted={revert.isReverted(key)}
      descriptionOverride={remoteCard ? SETTINGS_COPY.general.remoteDescriptions[key] : undefined}
      onEdit={() => revert.forget(key)}
    />
  {/if}
{/snippet}

{#if restartFlow.phase === 'back' || restartFlow.phase === 'unconfirmed' || restartKeys.length > 0}
  <div class="weft-general__banner" data-testid="settings-banner">
    {#if restartFlow.phase === 'back'}
      <RestartBackBanner
        title={RESTART_COPY.back.title}
        text={RESTART_COPY.back.applied(restartFlow.intent.changes)}
        onDismiss={() => restartFlow.close()}
      />
    {:else if restartFlow.phase === 'unconfirmed'}
      <Banner
        variant="warning"
        dismissible
        onDismiss={() => restartFlow.close()}
        title={RESTART_COPY.unconfirmed.title}
        titleLayout="stacked"
        data-testid="settings-restart-unconfirmed"
      >
        {RESTART_COPY.unconfirmed.description}
      </Banner>
    {:else if restartKeys.length > 0}
      <Banner
        variant="warning"
        sticky
        title={SETTINGS_COPY.general.restartBanner.title(restartKeys.length)}
        titleLayout="stacked"
        data-testid="settings-restart-summary"
      >
        {#snippet icon()}<TriangleAlert size={16} aria-hidden="true" />{/snippet}
        {SETTINGS_COPY.general.restartBanner.detail(restartKeys.map(settingLabel))}
        {#if restartRefusalWords !== ''}
          <span data-testid="settings-restart-refused">{restartRefusalWords}</span>
        {/if}
        {#snippet actions()}
          <Button
            variant="secondary"
            size="sm"
            disabled={restartFlow.running || revert.busy || autosave.busy}
            data-testid="settings-revert"
            onclick={() => void revert.revert(restartKeys, snapshot)}
          >
            {SETTINGS_COPY.general.restartBanner.revert(restartKeys.length)}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={restartFlow.running || revert.busy}
            onclick={() => (confirmingRestart = true)}
          >
            {#snippet leadingIcon()}<RotateCw size={14} aria-hidden="true" />{/snippet}
            {RESTART_COPY.confirm.confirm}
          </Button>
        {/snippet}
      </Banner>
    {/if}
  </div>
{/if}

<div class="weft-general__content" role="group" aria-label={SETTINGS_COPY.formLabel}>
  {#each sections as section (section.id)}
    <FormSection
      grouped
      heading={SETTINGS_COPY.general.sections[section.id].title}
      {...section.id === 'runs'
        ? { description: SETTINGS_COPY.general.sections.runs.description }
        : {}}
    >
      {#if section.id === 'storage'}
        {@render backendRow(false)}
      {:else if section.id === 'remote'}
        {@render backendRow(true)}
      {/if}
      {#each section.keys as key (key)}
        {@render field(key, section.id === 'remote')}
      {/each}
    </FormSection>
  {/each}

  <FormSection
    grouped
    heading={SETTINGS_COPY.general.sections.preferences.title}
    description={SETTINGS_COPY.general.sections.preferences.description}
  >
    {#if theme !== undefined}
      {@const copy = SETTINGS_COPY.general.preferences.theme}
      <div class="weft-general__row" data-setting={copy.identifier}>
        <SettingRow
          id="weft-setting-theme"
          label={copy.label}
          identifier={copy.identifier}
          description={copy.description}
        >
          {#snippet control()}
            <SegmentedControl
              id="weft-setting-theme"
              label={copy.label}
              labelVisible={false}
              value={theme.mode}
              onValueChange={(mode: ThemeMode) => theme.set(mode)}
            >
              {#each THEME_OPTIONS as mode (mode)}
                <Segment value={mode}>{copy.options[mode]}</Segment>
              {/each}
            </SegmentedControl>
          {/snippet}
        </SettingRow>
      </div>
    {/if}
    {#if layout !== undefined}
      {@const copy = SETTINGS_COPY.general.preferences.sidebar}
      <div class="weft-general__row" data-setting={copy.identifier}>
        <SettingRow
          id="weft-setting-sidebar"
          label={copy.label}
          identifier={copy.identifier}
          description={copy.description}
        >
          {#snippet control()}
            <Select
              id="weft-setting-sidebar"
              label={copy.label}
              value={layout.sidebarCollapsed ? 'collapsed' : 'expanded'}
              options={[
                { value: 'expanded', label: copy.options.expanded },
                { value: 'collapsed', label: copy.options.collapsed },
              ]}
              onchange={(event) =>
                layout.setSidebarCollapsed(event.currentTarget.value === 'collapsed')}
            />
          {/snippet}
        </SettingRow>
      </div>
    {/if}
    {#if (agents.data ?? []).length > 0}
      {@const copy = SETTINGS_COPY.general.preferences.defaultAgent}
      <div class="weft-general__row" data-setting={copy.identifier}>
        <SettingRow
          id="weft-setting-default-agent"
          label={copy.label}
          identifier={copy.identifier}
          description={copy.description}
        >
          {#snippet control()}
            <Select
              id="weft-setting-default-agent"
              label={copy.label}
              value={agentChoice}
              options={(agents.data ?? [])
                .filter((agent) => agent.ready || agent.name === agentChoice)
                .map((agent) => ({ value: agent.name, label: agent.displayName }))}
              onchange={(event) => chooseAgent(event.currentTarget.value)}
            />
          {/snippet}
        </SettingRow>
      </div>
    {/if}
    {#if keyboard !== undefined}
      {@const copy = SETTINGS_COPY.general.preferences.singleKey}
      <div class="weft-general__row" data-setting={copy.identifier}>
        <SettingRow
          id="weft-settings-single-key-shortcuts"
          label={copy.label}
          identifier={copy.identifier}
          description={copy.description}
        >
          {#snippet control()}
            <Toggle
              id="weft-settings-single-key-shortcuts"
              label={copy.label}
              checked={keyboard.singleKeyShortcuts}
              onValueChange={(enabled) => keyboard.setSingleKeyShortcuts(enabled)}
            />
          {/snippet}
        </SettingRow>
      </div>
    {/if}
  </FormSection>

  <section class="weft-general__paths" aria-labelledby="weft-settings-paths-title">
    <h2 id="weft-settings-paths-title" class="weft-general__paths-title">{words.title}</h2>
    <p class="weft-general__muted">{SETTINGS_COPY.hostPaths.description}</p>
    {#if hostPaths.data !== undefined}
      <dl class="weft-general__path-list">
        <dt>{words.agents}</dt>
        <dd><code>{hostPaths.data.agentDirectory}</code></dd>
        <dt>{words.workflows}</dt>
        <dd><code>{hostPaths.data.workflowDirectory}</code></dd>
        <dt>{words.configuration}</dt>
        <dd><code>{hostPaths.data.configurationFile}</code></dd>
        <dt>{words.providers}</dt>
        <dd>
          <ul class="weft-general__path-providers">
            {#each hostPaths.data.providers as provider (provider.name)}
              <li><code>{provider.secretFile}</code></li>
            {/each}
          </ul>
        </dd>
      </dl>
    {:else if hostPaths.isError}
      <p class="weft-general__muted">{SETTINGS_COPY.hostPaths.unavailable}</p>
    {/if}
  </section>
</div>

<RestartConfirmDialog
  bind:open={confirmingRestart}
  changes={restartKeys.length}
  onConfirm={() => void restartFlow.restart({ changes: restartKeys.map(settingLabel) })}
/>
<RestartDialog flow={restartFlow} />

<style>
  .weft-general__banner {
    grid-area: banner;
    position: sticky;
    inset-block-start: 0;
    z-index: 1;
    min-inline-size: 0;
    margin-block-end: var(--cinder-space-4);
  }

  .weft-general__content {
    grid-area: content;
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-8);
    max-inline-size: 46rem;
    min-inline-size: 0;
  }

  .weft-general__value {
    font-weight: var(--cinder-font-semibold);
    white-space: nowrap;
  }

  .weft-general__paths {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
  }

  .weft-general__paths-title {
    margin: 0;
    font-size: var(--cinder-text-base);
    font-weight: 600;
  }

  .weft-general__muted {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .weft-general__path-list {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--cinder-space-1) var(--cinder-space-4);
    margin: 0;
    font-size: var(--cinder-text-sm);
  }

  .weft-general__path-list dt {
    color: var(--cinder-text-muted);
  }

  .weft-general__path-list dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .weft-general__path-providers {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  code {
    font-family: var(--cinder-font-mono);
  }

  @media (max-width: 39.99rem) {
    .weft-general__path-list {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
