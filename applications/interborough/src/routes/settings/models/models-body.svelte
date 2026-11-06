<script lang="ts">
  /**
   * The body of Settings › Models (board SettingsShell, "Models · /settings/models"): one page, three
   * sections and no tabs. Providers (Connect, or Connected with Manage), Models (the catalog, which
   * only reads) and Decisions (the decision model, its fallback and its limit per task, which are
   * Bureau settings that save as they are left). The first two read the host's providers; the third
   * is the settings machinery the General page uses (`../general-settings.svelte`), over `decisions.*`.
   *
   * The Models list and the provider rows come from one read of the host. After a key is saved the
   * provider reads Connected at once (`connect-dialog.svelte`); if the read that follows fails, the
   * rows stay and the error sits in the catalog section, with Try again.
   */
  import { Alert, Button, Skeleton, validateSchemaFormValue } from '@lostgradient/cinder';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { onDestroy, untrack } from 'svelte';

  import { MODELS_COPY, RETRY_LABEL, SETTINGS_COPY } from '../../../app/copy.ts';
  import { HostRestartFlow } from '../../../app/restart/host-restart-flow.svelte.ts';
  import { dismissToast, showToast } from '../../../app/toast-host.svelte';
  import {
    getSettings,
    updateSettings,
    type SettingKeyState,
    type SettingsSchema,
    type SettingsSnapshot,
  } from '../../../lib/bureau-settings.ts';
  import { getPlugins } from '../../../lib/host-plugins.ts';
  import { getProviders, HostProviderError } from '../../../lib/host-providers.ts';
  import { returnPathOf } from '../../../lib/provider-return.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import { policyOf } from '../model-policy-edit.ts';
  import { controlFor, inSection, MODEL_POLICY_KEY, type Control } from '../settings-controls.ts';
  import { formSchemaOf, numbersCommitted } from '../settings-form-schema.ts';
  import { SettingsAutosave } from '../settings-autosave.svelte.ts';
  import { SettingsForm } from '../settings-form.svelte.ts';
  import SettingsRestartNotice from '../settings-restart-notice.svelte';
  import { SettingsRevert } from '../settings-revert.svelte.ts';
  import DecisionsSection from './decisions-section.svelte';
  import { providerDisplayName } from './format-model.ts';
  import ModelsSection, { type CatalogFailure } from './models-section.svelte';
  import ProvidersSection from './providers-section.svelte';

  interface Props {
    schema: SettingsSchema;
    snapshot: SettingsSnapshot;
  }

  let { schema, snapshot }: Props = $props();

  const queryClient = useQueryClient();

  const providers = createQuery(
    () => ({
      queryKey: queryKeys.hostProviders(),
      queryFn: ({ signal }) => getProviders({ signal }),
      retry: false,
    }),
    undefined,
  );

  // TypeSafe is a plugin; its decision model has no key while the plugin is `needs-setup`.
  const plugins = createQuery(
    () => ({
      queryKey: queryKeys.hostPlugins(),
      queryFn: ({ signal }) => getPlugins({ signal }),
      retry: false,
    }),
    undefined,
  );
  const typesafeNeedsKey = $derived(
    (plugins.data?.plugins ?? []).some(
      (plugin) => plugin.descriptor.name === 'typesafe' && plugin.status === 'needs-setup',
    ),
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

  /** The list of models did not come back, though a read of it gave the page its providers before. */
  const failure = $derived.by((): CatalogFailure | undefined => {
    if (!providers.isError || providers.data === undefined) return undefined;
    const error = providers.error;
    return {
      providers: providers.data.providers
        .filter((entry) => entry.hasKey)
        .map((entry) => providerDisplayName(entry.name)),
      status: error instanceof HostProviderError ? error.status : undefined,
    };
  });

  function goToProviders(): void {
    const target = document.getElementById('ib-models-providers');
    target?.scrollIntoView({ block: 'start' });
    target?.focus({ preventScroll: true });
  }

  // The settings machinery the General page uses: a form over the schema, each decision saving as
  // it is left, and the restart notice every section of Settings shares.
  const controls = new Map<string, Control>(
    untrack(() => Object.entries(schema).map(([key, node]) => [key, controlFor(key, node)])),
  );

  /** What a key without a state from the Bureau is: a live key nothing holds. */
  const UNKNOWN_STATE: SettingKeyState = { apply: 'live', locked: false, pendingRestart: false };
  const stateOf = (key: string): SettingKeyState => snapshot.keys[key] ?? UNKNOWN_STATE;

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

  const revert = new SettingsRevert({
    form,
    update: (patch, expectedRevision) => updateSettings(patch, expectedRevision),
    read: readSettings,
    showUndo: (message, undo) => showToast(message, { undo }),
    dismiss: dismissToast,
    fail: (message) => void showToast(message, { variant: 'danger' }),
  });
  onDestroy(() => revert.dispose());

  // The settings were read again: every setting not being edited takes them.
  $effect(() => {
    const latest = snapshot;
    if (autosave.busy) return;
    untrack(() => {
      if (latest.revision !== form.revision) form.rebase(latest);
    });
  });

  const restartFlow = new HostRestartFlow<SettingsSnapshot>({
    read: () => getSettings(),
    waiting: (current) => Object.values(current.keys).some((key) => key.pendingRestart),
  });
  onDestroy(() => restartFlow.dispose());
  $effect(() => {
    if (restartFlow.phase !== 'back') return;
    untrack(() => void queryClient.invalidateQueries());
  });

  /** The settings that wait for a restart, in the schema's order. */
  const restartKeys = $derived(Object.keys(schema).filter((key) => stateOf(key).pendingRestart));

  const decisionNodes = $derived(
    Object.fromEntries(Object.entries(schema).filter(([key]) => inSection(key, 'decisions'))),
  );
  const policy = $derived(policyOf(snapshot.values[MODEL_POLICY_KEY]));
</script>

<SettingsRestartNotice
  keys={restartKeys}
  {snapshot}
  flow={restartFlow}
  {revert}
  saving={autosave.busy}
/>

<div class="ib-models-page" role="group" aria-label={SETTINGS_COPY.formLabel}>
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
    <div id="ib-models-providers" tabindex="-1" class="ib-models-page__anchor">
      <ProvidersSection snapshot={providers.data} bind:connecting />
    </div>
    <ModelsSection
      models={failure === undefined ? providers.data.models : []}
      {policy}
      {failure}
      onRetry={() => void providers.refetch()}
      onGoToProviders={goToProviders}
    />
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
  <DecisionsSection
    nodes={decisionNodes}
    {controls}
    {form}
    {autosave}
    {revert}
    {stateOf}
    effective={snapshot.effective}
    {typesafeNeedsKey}
  />
</div>

<style>
  .ib-models-page {
    grid-area: content;
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-8);
    max-inline-size: 46rem;
    min-inline-size: 0;
  }

  .ib-models-page__anchor {
    min-inline-size: 0;
    outline: none;
  }

  .ib-models-page__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .ib-models-page__alert-body {
    margin: var(--cinder-space-1) 0 var(--cinder-space-2);
  }
</style>
