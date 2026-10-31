<script lang="ts">
  /**
   * The settings form: every key of the schema under its group, and one Save for the keys the
   * person changed. Save sends the dirty keys in one `bureau.settings.update` against the revision
   * the page read; the Bureau applies all of them or none. The form follows the Bureau: when the
   * settings change while nothing is edited it takes them, and when they change under an edit it
   * says so and offers to reload, because saving over a change would overwrite it. A save the
   * Bureau refuses as stale says the same.
   */
  import { Alert, Button, validateSchemaFormValue } from '@lostgradient/cinder';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { onMount, untrack } from 'svelte';

  import { SETTINGS_COPY } from '../../app/copy.ts';
  import {
    getSettings,
    settingsFaultOf,
    updateSettings,
    type SettingKeyState,
    type SettingsFault,
    type SettingsSchema,
    type SettingsSnapshot,
    type SettingsUpdateReceipt,
  } from '../../lib/bureau-settings.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { shortcuts } from '../../lib/shortcuts.ts';
  import ModelPolicyEditor from './model-policy-editor.svelte';
  import SettingRow from './setting-row.svelte';
  import {
    controlFor,
    groupLabel,
    groupOf,
    groupsOf,
    inSection,
    MODEL_POLICY_KEY,
    type Control,
    type SettingsSectionId,
  } from './settings-controls.ts';
  import { formSchemaOf, numbersCommitted } from './settings-form-schema.ts';
  import { SettingsForm } from './settings-form.svelte.ts';

  interface Props {
    schema: SettingsSchema;
    snapshot: SettingsSnapshot;
    /** Which settings the section edits; the form holds all of them, so a save sends only what changed. */
    section: SettingsSectionId;
  }

  let { schema, snapshot, section }: Props = $props();

  const queryClient = useQueryClient();

  const keys = $derived(Object.keys(schema).filter((key) => inSection(key, section)));
  const controls = new Map<string, Control>(
    untrack(() => Object.entries(schema).map(([key, node]) => [key, controlFor(key, node)])),
  );

  /** What a key without a state from the Bureau is: a live key nothing holds. */
  const UNKNOWN_STATE: SettingKeyState = { apply: 'live', locked: false, pendingRestart: false };

  function stateOf(key: string): SettingKeyState {
    return snapshot.keys[key] ?? UNKNOWN_STATE;
  }

  /** Checks a `SchemaForm` key's value against the schema the form was given. */
  async function validate(key: string, value: unknown): Promise<string | undefined> {
    const node = schema[key];
    if (node === undefined) return undefined;
    const result = await validateSchemaFormValue(formSchemaOf(key, node), value);
    return result.valid ? undefined : (result.issues[0]?.message ?? SETTINGS_COPY.invalidValue);
  }

  /** Whether a `SchemaForm` key's value holds only numbers that were committed, not text still being typed. */
  function committed(key: string, value: unknown): boolean {
    const node = schema[key];
    return node === undefined || numbersCommitted(formSchemaOf(key, node), value);
  }

  const form = new SettingsForm(controls, (key) => stateOf(key).locked, validate, committed);
  untrack(() => form.load(snapshot));

  /** A save the Bureau applied: which keys now wait for a restart. */
  let saved = $state<SettingsUpdateReceipt | null>(null);
  /** A save the Bureau refused, other than for being stale. */
  let refusal = $state<Exclude<SettingsFault, { kind: 'stale' }> | null>(null);
  /** The settings changed since the page read them, found by a save the Bureau refused. */
  let stale = $state(false);
  /** The settings changed under an edit, found by reading them again. */
  let changedElsewhere = $state(false);

  // The settings were read again. With nothing edited the form takes them; with an edit under way
  // it says they changed and waits for the person, because a reload discards the edit.
  $effect(() => {
    const latest = snapshot;
    untrack(() => {
      if (latest.revision === form.revision) return;
      if (form.dirtyKeys.length === 0) form.load(latest);
      else changedElsewhere = true;
    });
  });

  /**
   * Whether a save has started and not finished. It is set before the first `await`, because
   * `submit.isPending` only turns true a tick after `mutate`, and one key press can ask twice: a
   * number field in a `SchemaForm` submits its form on ⌘Enter, and the shortcut runs as well.
   */
  let sending = false;

  const submit = createMutation(() => ({
    mutationFn: (input: { patch: Record<string, unknown>; expectedRevision: number }) =>
      updateSettings(input.patch, input.expectedRevision),
    onMutate: () => {
      saved = null;
      refusal = null;
      stale = false;
    },
    onSettled: () => {
      sending = false;
    },
    onSuccess: async (receipt: SettingsUpdateReceipt) => {
      saved = receipt;
      changedElsewhere = false;
      try {
        await reload();
      } catch {
        // The save went through. The page reads the settings again, and says they changed if it must.
        void queryClient.invalidateQueries({ queryKey: queryKeys.settings.snapshot() });
      }
    },
    onError: (error: unknown) => {
      const fault = settingsFaultOf(error);
      if (fault.kind === 'stale') {
        stale = true;
        void queryClient.invalidateQueries({ queryKey: queryKeys.settings.snapshot() });
        return;
      }
      refusal = fault;
    },
  }));

  /** Sends the dirty keys, if there are any and nothing is wrong with them. */
  async function save(): Promise<void> {
    if (sending) return;
    sending = true;
    // An edit made a moment ago may still be checked against its schema.
    await form.settled();
    if (!form.canSave || submit.isPending) {
      sending = false;
      return;
    }
    submit.mutate({ patch: form.patch(), expectedRevision: form.revision });
  }

  // ⌘Enter saves from anywhere on the page, a field included (`lib/shortcuts.ts`).
  onMount(() =>
    shortcuts.register({
      keys: ['Enter'],
      modifier: 'mod',
      label: SETTINGS_COPY.saveAction,
      group: SETTINGS_COPY.shortcutGroup,
      scope: { route: section === 'general' ? '/settings' : '/settings/model-policy' },
      handler: () => void save(),
    }),
  );

  /** The keys that wait for a restart: the ones the Bureau holds a stored value for, and the ones about to be saved. */
  const restartKeys = $derived(
    Object.keys(schema).filter(
      (key) =>
        inSection(key, section) &&
        (stateOf(key).pendingRestart || (stateOf(key).apply === 'restart' && form.isDirty(key))),
    ),
  );

  /** Reads the settings again and starts the form over from them, whatever was edited. */
  async function reload(): Promise<void> {
    const fresh = await queryClient.fetchQuery({
      queryKey: queryKeys.settings.snapshot(),
      queryFn: ({ signal }) => getSettings({ signal }),
      staleTime: 0,
    });
    form.load(fresh);
    stale = false;
    changedElsewhere = false;
  }

  /** Puts the edits back. If the settings moved while they were being made, the form takes the settings as they are now. */
  function discard(): void {
    refusal = null;
    stale = false;
    changedElsewhere = false;
    if (snapshot.revision === form.revision) form.discard();
    else form.load(snapshot);
  }

  const groups = $derived(groupsOf(keys));
</script>

{#if stale || changedElsewhere}
  <Alert variant="warning" data-testid="settings-reload-prompt">
    <p class="weft-settings-editor__alert-title">
      {stale ? SETTINGS_COPY.stale.title : SETTINGS_COPY.changedElsewhere.title}
    </p>
    <p class="weft-settings-editor__alert-body">
      {stale ? SETTINGS_COPY.stale.description : SETTINGS_COPY.changedElsewhere.description}
    </p>
    <Button variant="secondary" size="sm" onclick={() => void reload()}
      >{SETTINGS_COPY.reloadAction}</Button
    >
  </Alert>
{/if}
{#if saved !== null}
  <Alert variant="success" dismissible onDismiss={() => (saved = null)}>
    <p class="weft-settings-editor__alert-title">{SETTINGS_COPY.saved.title}</p>
    <p class="weft-settings-editor__alert-body">
      {SETTINGS_COPY.saved.description}
    </p>
  </Alert>
{/if}
{#if refusal !== null}
  <Alert variant="danger" dismissible onDismiss={() => (refusal = null)}>
    <p class="weft-settings-editor__alert-title">{SETTINGS_COPY.saveFailed}</p>
    <p class="weft-settings-editor__alert-body">
      {refusal.kind === 'forbidden' ? SETTINGS_COPY.forbidden : refusal.message}
    </p>
  </Alert>
{/if}

{#if restartKeys.length > 0}
  <Alert variant="info" data-testid="settings-restart-summary">
    <p class="weft-settings-editor__alert-body">
      {SETTINGS_COPY.restartSummary(restartKeys)}
    </p>
  </Alert>
{/if}

<div class="weft-settings-editor" role="group" aria-label={SETTINGS_COPY.formLabel}>
  <!-- The controls stop while a save is in flight, so an edit is not lost to the settings it reads back. -->
  <fieldset class="weft-settings-editor__fields" disabled={submit.isPending}>
    {#if section === 'model-policy'}
      <ModelPolicyEditor {form} keyState={stateOf(MODEL_POLICY_KEY)} />
    {:else}
      {#each groups as group (group)}
        <section
          class="weft-settings-editor__group"
          aria-labelledby={`weft-settings-group-${group}`}
        >
          <h2 id={`weft-settings-group-${group}`} class="weft-settings-editor__group-title">
            {groupLabel(group)}
          </h2>
          {#each keys.filter((key) => groupOf(key) === group) as key (key)}
            {@const control = controls.get(key)}
            {#if control !== undefined && schema[key] !== undefined}
              <SettingRow
                name={key}
                node={schema[key]}
                {control}
                {form}
                keyState={stateOf(key)}
                requestSave={save}
              />
            {/if}
          {/each}
        </section>
      {/each}
    {/if}
  </fieldset>

  <div class="weft-settings-editor__actions">
    <Button
      type="button"
      variant="primary"
      data-changes
      disabled={!form.canSave || submit.isPending}
      onclick={() => void save()}>{SETTINGS_COPY.saveAction}</Button
    >
    <Button
      type="button"
      variant="secondary"
      disabled={form.dirtyKeys.length === 0 || submit.isPending}
      onclick={discard}>{SETTINGS_COPY.discardAction}</Button
    >
  </div>
</div>

<style>
  .weft-settings-editor {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-6);
  }

  .weft-settings-editor__fields {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-6);
    min-inline-size: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }

  .weft-settings-editor__group {
    display: flex;
    flex-direction: column;
  }

  .weft-settings-editor__group-title {
    margin: 0;
    padding-bottom: var(--cinder-space-2);
    border-bottom: 1px solid var(--cinder-border-muted);
    font-size: var(--cinder-text-lg);
    font-weight: 600;
  }

  .weft-settings-editor__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
  }

  .weft-settings-editor__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .weft-settings-editor__alert-body {
    margin: var(--cinder-space-1) 0 var(--cinder-space-2);
  }
</style>
