<script lang="ts">
  /**
   * The body of Settings › Allowed models (board PageSettingsSections, "Allowed models,
   * /settings/allowed-models"): which of the connected providers' models agents may use, as one
   * checkbox per model, and the caller's own preferences among them, as two setting rows. It edits
   * the `modelPolicy` setting in plain words and never shows it as JSON.
   *
   * Unlike the rest of Settings it saves explicitly: saving raises the policy revision, which makes
   * the plans made under the old policy be checked again, so the actions bar says so and nothing is
   * sent until Save. A model is allowed until the policy denies it, so unticking one adds it to the
   * deployment layer's `deniedModels` and ticking it takes it out; every other field of the policy,
   * including the ones this page has no control for, stays as it was (`model-policy-edit.ts`).
   */
  import {
    Button,
    Checkbox,
    FormActions,
    FormSection,
    Link,
    Select,
    SettingRow,
    validateSchemaFormValue,
  } from '@lostgradient/cinder';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { onDestroy, onMount, untrack } from 'svelte';

  import { ALLOWED_MODELS_COPY as copy, EFFORT_LABELS, SETTINGS_COPY } from '../../app/copy.ts';
  import { HostRestartFlow } from '../../app/restart/host-restart-flow.svelte.ts';
  import { dismissToast, showToast } from '../../app/toast-host.svelte';
  import {
    getSettings,
    settingsFaultOf,
    updateSettings,
    type SettingKeyState,
    type SettingsSchema,
    type SettingsSnapshot,
  } from '../../lib/bureau-settings.ts';
  import { getProviders, type ProviderModel } from '../../lib/host-providers.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { shortcuts } from '../../lib/shortcuts.ts';
  import {
    changedChoices,
    committedPolicy,
    defaultEffortOf,
    deniedProvidersOf,
    isModelAllowed,
    policyOf,
    preferenceOf,
    withField,
    withModelAllowed,
    withPreference,
    type ModelPolicy,
    type PreferChoice,
  } from './model-policy-edit.ts';
  import {
    formatModelAbilities,
    modelDisplayName,
    providerDisplayName,
  } from './models/format-model.ts';
  import ModelName from './models/model-name.svelte';
  import { controlFor, MODEL_POLICY_KEY, type Control } from './settings-controls.ts';
  import { formSchemaOf, numbersCommitted } from './settings-form-schema.ts';
  import { SettingsForm } from './settings-form.svelte.ts';
  import SettingsRestartNotice from './settings-restart-notice.svelte';
  import { SettingsRevert } from './settings-revert.svelte.ts';

  interface Props {
    schema: SettingsSchema;
    snapshot: SettingsSnapshot;
  }

  let { schema, snapshot }: Props = $props();

  const queryClient = useQueryClient();
  const PROVIDERS_PATH = '/settings/models';

  /** What a key without a state from the Bureau is: a live key nothing holds. */
  const UNKNOWN_STATE: SettingKeyState = { apply: 'live', locked: false, pendingRestart: false };
  const stateOf = (key: string): SettingKeyState => snapshot.keys[key] ?? UNKNOWN_STATE;
  const locked = $derived(stateOf(MODEL_POLICY_KEY).locked);

  // The form holds the one setting this page edits; the restart notice's Revert reads and rebases
  // it as it does the General page's.
  const policyNode = untrack(() => schema[MODEL_POLICY_KEY]);
  const controls = new Map<string, Control>(
    policyNode === undefined ? [] : [[MODEL_POLICY_KEY, controlFor(MODEL_POLICY_KEY, policyNode)]],
  );

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

  const revert = new SettingsRevert({
    form,
    update: (patch, expectedRevision) => updateSettings(patch, expectedRevision),
    read: readSettings,
    showUndo: (message, undo) => showToast(message, { undo }),
    dismiss: dismissToast,
    fail: (message) => void showToast(message, { variant: 'danger' }),
  });
  onDestroy(() => revert.dispose());

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

  // The settings were read again: with nothing edited the form takes them; under an edit it says
  // they changed and waits for the person, because taking them discards the edit.
  let changedElsewhere = $state(false);
  $effect(() => {
    const latest = snapshot;
    if (saving) return;
    untrack(() => {
      if (latest.revision === form.revision) return;
      if (form.dirtyKeys.length === 0) form.rebase(latest);
      else changedElsewhere = true;
    });
  });

  /** The policy as stored, and as it is being edited. */
  const stored = $derived(policyOf(form.baseline(MODEL_POLICY_KEY)));
  const current = $derived(policyOf(form.draft(MODEL_POLICY_KEY)));
  const changes = $derived(changedChoices(stored, current));
  const deniedProviders = $derived(deniedProvidersOf(current));

  function edit(next: ModelPolicy): void {
    if (saving) return;
    const policy = committedPolicy(stored, next);
    // Back to the stored policy is no change at all, even when the setting had no value.
    form.set(
      MODEL_POLICY_KEY,
      policy === stored && form.baseline(MODEL_POLICY_KEY) === undefined ? undefined : policy,
    );
    failure = undefined;
  }

  // The models the connected providers offer.
  const providers = createQuery(
    () => ({
      queryKey: queryKeys.hostProviders(),
      queryFn: ({ signal }) => getProviders({ signal }),
      retry: false,
    }),
    undefined,
  );

  type Group = { readonly provider: string; readonly models: readonly ProviderModel[] };
  const groups = $derived.by((): readonly Group[] => {
    const snapshotOfProviders = providers.data;
    if (snapshotOfProviders === undefined) return [];
    return snapshotOfProviders.providers
      .filter((provider) => provider.hasKey)
      .map((provider) => ({
        provider: provider.name,
        models: snapshotOfProviders.models.filter((model) => model.provider === provider.name),
      }))
      .filter((group) => group.models.length > 0);
  });

  /** The id of a model's checkbox, which its name labels. */
  const checkboxId = (model: ProviderModel): string =>
    `weft-allowed-${model.provider}-${model.model}`.replaceAll(/[^a-zA-Z0-9-]/g, '-');

  const PREFER_ORDER = ['neither', 'cost', 'speed'] as const;
  const preference = $derived(preferenceOf(current));
  // A policy that holds both preferences is a choice the person can see and leave, not one the page offers again.
  const preferOptions = $derived(
    (preference === 'both' ? [...PREFER_ORDER, 'both' as const] : PREFER_ORDER).map((value) => ({
      value,
      label: copy.preferences.prefer.options[value],
    })),
  );
  const effort = $derived(defaultEffortOf(current) ?? '');
  const effortOptions = $derived([
    ...(effort === '' || defaultEffortOf(stored) === undefined
      ? [{ value: '', label: copy.preferences.effort.notSet }]
      : []),
    ...Object.entries(EFFORT_LABELS).map(([value, label]) => ({ value, label })),
  ]);

  /** What a failed save says, under the buttons, until the person changes something or saves again. */
  let failure = $state<string | undefined>(undefined);
  /** Whether the Bureau said the settings changed under the edit. */
  let stale = $state(false);
  let sending = false;
  let saving = $state(false);

  const submit = createMutation(() => ({
    mutationFn: (input: { patch: Record<string, unknown>; expectedRevision: number }) =>
      updateSettings(input.patch, input.expectedRevision),
    onMutate: () => {
      failure = undefined;
      stale = false;
    },
    onSettled: () => {
      sending = false;
      saving = false;
    },
    onSuccess: async () => {
      changedElsewhere = false;
      try {
        form.load(await readSettings());
      } catch {
        // The save went through; the page reads the settings again and says they changed if it must.
        void queryClient.invalidateQueries({ queryKey: queryKeys.settings.snapshot() });
      }
      showToast(SETTINGS_COPY.saved.title, { variant: 'success' });
    },
    onError: (error: unknown) => {
      const fault = settingsFaultOf(error);
      if (fault.kind === 'stale') {
        stale = true;
        void queryClient.invalidateQueries({ queryKey: queryKeys.settings.snapshot() });
        return;
      }
      const said =
        fault.kind === 'other'
          ? copy.saveFailed.didNotAnswer
          : fault.kind === 'forbidden'
            ? SETTINGS_COPY.forbidden
            : fault.message;
      failure = `${said} ${copy.saveFailed.stillHere}`;
    },
  }));

  /** Sends the edited policy, when it differs from the stored one and nothing is wrong with it. */
  async function save(): Promise<void> {
    if (sending || locked) return;
    sending = true;
    saving = true;
    // An edit made a moment ago may still be checked against its schema.
    await form.settled();
    if (!form.canSave || submit.isPending) {
      sending = false;
      saving = false;
      return;
    }
    submit.mutate({ patch: form.patch(), expectedRevision: form.revision });
  }

  /** Puts the edits back to the stored policy, and takes the settings as they are now if they moved. */
  function reset(): void {
    failure = undefined;
    stale = false;
    changedElsewhere = false;
    if (snapshot.revision === form.revision) form.discard();
    else form.load(snapshot);
  }

  // ⌘Enter saves from anywhere on the page (`lib/shortcuts.ts`).
  onMount(() =>
    shortcuts.register({
      keys: ['Enter'],
      modifier: 'mod',
      label: SETTINGS_COPY.saveAction,
      group: SETTINGS_COPY.shortcutGroup,
      scope: { route: '/settings/allowed-models' },
      handler: () => void save(),
    }),
  );

  function openProviders(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(PROVIDERS_PATH);
  }

  const bar = $derived(changes > 0 || failure !== undefined);
  // The controls are held while a save is sent and the settings are read again after it, because
  // that read replaces the form: an edit made meanwhile would be dropped without a word.
  const held = $derived(locked || saving);
</script>

<SettingsRestartNotice keys={restartKeys} {snapshot} flow={restartFlow} {revert} {saving} />

<div class="weft-allowed" role="group" aria-label={SETTINGS_COPY.formLabel}>
  {#if locked}
    <p class="weft-allowed__muted">{copy.lockedNote}</p>
  {/if}
  {#if stale || changedElsewhere}
    <div class="weft-allowed__prompt" role="alert" data-testid="settings-reload-prompt">
      <p class="weft-allowed__prompt-title">
        {stale ? SETTINGS_COPY.stale.title : SETTINGS_COPY.changedElsewhere.title}
      </p>
      <p class="weft-allowed__muted">
        {stale ? SETTINGS_COPY.stale.description : SETTINGS_COPY.changedElsewhere.description}
      </p>
      <Button variant="secondary" size="sm" onclick={reset}>{SETTINGS_COPY.reloadAction}</Button>
    </div>
  {/if}

  {#if groups.length > 0}
    <FormSection grouped heading={copy.models.title} description={copy.models.description}>
      {#each groups as group (group.provider)}
        <h3 class="weft-allowed__provider">{providerDisplayName(group.provider)}</h3>
        {#each group.models as model (model.model)}
          {@const denied = deniedProviders.includes(model.provider)}
          <div class="weft-allowed__model" data-model={`${model.provider}/${model.model}`}>
            <Checkbox
              id={checkboxId(model)}
              checked={!denied && isModelAllowed(current, model.model)}
              disabled={held || denied}
              onValueChange={(allowed) => edit(withModelAllowed(current, model.model, allowed))}
            />
            <ModelName
              name={modelDisplayName(model.model)}
              identifier={model.model}
              layout="inline"
              labelFor={checkboxId(model)}
            />
            <span class="weft-allowed__abilities">{formatModelAbilities(model)}</span>
          </div>
        {/each}
      {/each}
    </FormSection>
  {:else}
    <div class="weft-allowed__models">
      <FormSection grouped heading={copy.models.title} description={copy.models.description} />
      {#if providers.isError}
        <p class="weft-allowed__muted" role="alert">
          {copy.models.loadFailed}
          <Button variant="secondary" size="sm" onclick={() => void providers.refetch()}
            >{copy.models.tryAgain}</Button
          >
        </p>
      {:else if providers.isPending}
        <p class="weft-allowed__muted" role="status">{copy.models.loading}</p>
      {:else}
        <p class="weft-allowed__muted" data-testid="allowed-models-empty">
          {copy.models.empty}
          <Link href={router.href(PROVIDERS_PATH)} underline="always" onclick={openProviders}
            >{copy.models.goToProviders}</Link
          >
        </p>
      {/if}
    </div>
  {/if}

  <div class="weft-allowed__preferences">
    <FormSection
      grouped
      heading={copy.preferences.title}
      description={copy.preferences.description}
    >
      <div class="weft-allowed__row" data-setting={copy.preferences.prefer.identifier}>
        <SettingRow
          id="weft-allowed-prefer"
          label={copy.preferences.prefer.label}
          identifier={copy.preferences.prefer.identifier}
          description={copy.preferences.prefer.description}
          disabled={held}
        >
          {#snippet control()}
            <Select
              id="weft-allowed-prefer"
              label={copy.preferences.prefer.label}
              labelVisible={false}
              value={preference}
              options={preferOptions}
              disabled={held}
              onchange={(event) =>
                edit(withPreference(current, event.currentTarget.value as PreferChoice))}
            />
          {/snippet}
        </SettingRow>
      </div>
      <div class="weft-allowed__row" data-setting={copy.preferences.effort.identifier}>
        <SettingRow
          id="weft-allowed-effort"
          label={copy.preferences.effort.label}
          identifier={copy.preferences.effort.identifier}
          description={copy.preferences.effort.description}
          disabled={held}
        >
          {#snippet control()}
            <Select
              id="weft-allowed-effort"
              label={copy.preferences.effort.label}
              labelVisible={false}
              value={effort}
              options={effortOptions}
              disabled={held}
              onchange={(event) =>
                edit(
                  withField(
                    current,
                    'your-preferences',
                    'defaultEffort',
                    event.currentTarget.value === '' ? undefined : event.currentTarget.value,
                  ),
                )}
            />
          {/snippet}
        </SettingRow>
      </div>
    </FormSection>
    <p class="weft-allowed__muted weft-allowed__note">{copy.note}</p>
  </div>

  {#if bar}
    <FormActions sticky unsavedChanges={changes} error={failure} errorTitle={copy.saveFailed.title}>
      {#snippet summary()}{copy.effect}{/snippet}
      {#snippet end()}
        <Button variant="secondary" disabled={saving} onclick={reset}>{copy.reset}</Button>
        <Button
          data-changes
          variant="primary"
          disabled={saving || locked}
          onclick={() => void save()}>{copy.save}</Button
        >
      {/snippet}
    </FormActions>
  {/if}
</div>

<style>
  .weft-allowed {
    grid-area: content;
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-8);
    max-inline-size: 46rem;
    min-inline-size: 0;
  }

  .weft-allowed__models {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
  }

  .weft-allowed__preferences {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
  }

  .weft-allowed__muted {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .weft-allowed__note {
    margin-block-start: var(--cinder-space-2);
  }

  .weft-allowed__prompt {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    padding: var(--cinder-space-3) var(--cinder-space-4);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-lg);
  }

  .weft-allowed__prompt-title {
    margin: 0;
    font-weight: var(--cinder-font-semibold);
  }

  /* A provider's name heads its models inside the card, on a quiet band. */
  .weft-allowed__provider {
    margin: 0;
    background: var(--cinder-surface-inset);
    color: var(--cinder-text-default);
    font-size: var(--cinder-text-sm);
    font-weight: var(--cinder-font-semibold);
  }

  .weft-allowed__model {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    min-inline-size: 0;
  }

  .weft-allowed__abilities {
    margin-inline-start: auto;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
    white-space: nowrap;
  }
</style>
