<script lang="ts">
  /**
   * One setting on the General page, drawn as a Cinder `SettingRow`: the label from the shared
   * formatter with the raw key beside it, the Bureau's description, the control the schema shape
   * calls for (`settings-controls.ts`), and the row's own save status. The setting saves when the
   * person leaves its field: a switch or a select as soon as it changes, any other control when
   * focus leaves it (`settings-autosave.svelte.ts`). An object is edited through a `SchemaForm`
   * and a free-form value through a JSON editor, both under the row.
   */
  import {
    Button,
    DurationField,
    Input,
    JsonEditor,
    NumberInput,
    SchemaForm,
    Select,
    SettingRow,
    Toggle,
  } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { SETTINGS_COPY } from '../../app/copy.ts';
  import { getAgentCatalog } from '../../lib/agent-definitions.ts';
  import type { SchemaNode, SettingKeyState } from '../../lib/bureau-settings.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { inlineSegments } from './inline-markdown.ts';
  import {
    DURATION_SETTINGS,
    HOST_DECISION_MODELS,
    SETTING_UNITS,
    holdsForm,
    settingLabel,
    type Control,
  } from './settings-controls.ts';
  import { formSchemaOf } from './settings-form-schema.ts';
  import type { SettingsAutosave } from './settings-autosave.svelte.ts';
  import type { SettingsForm } from './settings-form.svelte.ts';

  interface Props {
    name: string;
    node: SchemaNode;
    control: Control;
    form: SettingsForm;
    keyState: SettingKeyState;
    autosave: SettingsAutosave;
    /** What the status line says for a setting a restart just applied ("In effect since 10:44 AM"). */
    appliedNote?: string | undefined;
    /** Whether the banner's Revert put this setting back to its running value ("Reverted · in effect now"). */
    reverted?: boolean;
    /** The row's own words in place of the Bureau's description, such as in the Remote deployment card. */
    descriptionOverride?: string | undefined;
    /** The row's own label in place of the one made from the key, such as "Decision model" for `decisions.model`. */
    labelOverride?: string | undefined;
    /** Called when the person changes the value, which ends what Revert said about it. */
    onEdit?: (() => void) | undefined;
  }

  let {
    name,
    node,
    control: spec,
    form,
    keyState,
    autosave,
    appliedNote,
    reverted = false,
    descriptionOverride,
    labelOverride,
    onEdit,
  }: Props = $props();

  const id = $derived(`weft-setting-${name.replaceAll('.', '-')}`);
  const label = $derived(labelOverride ?? settingLabel(name));
  /** The description as plain words: a code span reads as its text. */
  const description = $derived(
    descriptionOverride ??
      inlineSegments(node.description ?? '')
        .map((segment) => segment.text)
        .join(''),
  );
  const draft = $derived(form.draft(name));
  const locked = $derived(keyState.locked);
  const hasValue = $derived(draft !== undefined);
  const saveState = $derived(autosave.stateOf(name));
  const problem = $derived(form.error(name));
  const formSchema = $derived(holdsForm(spec) ? formSchemaOf(name, node) : undefined);
  const duration = $derived(DURATION_SETTINGS[name]);
  const unit = $derived(SETTING_UNITS[name]);
  const switchedOn = $derived(
    spec.kind === 'switch-json' ? draft !== false : draft !== false && draft !== undefined,
  );
  /** An unset object stays "Not set" until the person asks to set it, so its empty fields carry no error. */
  let revealed = $state(false);
  const formShown = $derived(
    (spec.kind === 'form' && (hasValue || revealed)) || (spec.kind === 'switch-form' && switchedOn),
  );

  // Starting over puts an unset setting back to unset, so its fields are hidden again.
  $effect(() => {
    void form.generation;
    if (draft === undefined) revealed = false;
  });

  const error = $derived.by(() => {
    if (saveState?.phase === 'invalid') {
      return `${problem ?? SETTINGS_COPY.invalidValue} ${SETTINGS_COPY.nothingSaved}`;
    }
    if (saveState?.phase !== 'failed') return undefined;
    const { fault } = saveState;
    if (fault.kind === 'forbidden') return SETTINGS_COPY.forbidden;
    if (fault.kind === 'rejected' || fault.kind === 'locked') {
      return `${fault.message} ${SETTINGS_COPY.nothingSaved}`;
    }
    return SETTINGS_COPY.couldNotSave;
  });
  const retriable = $derived(
    saveState?.phase === 'failed' &&
      (saveState.fault.kind === 'other' || saveState.fault.kind === 'forbidden'),
  );

  const status = $derived.by(() => {
    if (saveState?.phase === 'saving') return 'saving' as const;
    if (keyState.pendingRestart) return 'saved-restart' as const;
    if (saveState?.phase === 'saved' || appliedNote !== undefined) return 'saved' as const;
    if (reverted) return 'reverted' as const;
    if (keyState.apply === 'restart') return 'restart' as const;
    return undefined;
  });
  const statusLabel = $derived(
    status === 'saved' && saveState?.phase !== 'saved' ? appliedNote : undefined,
  );

  // The catalog is read only for a key that names one of its rows.
  const catalog = createQuery(
    () => ({
      queryKey: queryKeys.agents.catalog(),
      queryFn: ({ signal }) => getAgentCatalog({ signal }),
      enabled: spec.kind === 'choice' && spec.source === 'catalog-rows',
      retry: false,
    }),
    undefined,
  );

  /** The options of a select of rows: what the source offers, and the value the key holds now so it is never lost. */
  const choices = $derived.by(() => {
    if (spec.kind !== 'choice') return [];
    const options =
      spec.source === 'catalog-rows'
        ? (catalog.data?.models ?? []).map((row) => {
            const value = `${row.provider}/${row.model}`;
            return { value, label: value };
          })
        : HOST_DECISION_MODELS.map((option) => ({ ...option }));
    const current = typeof draft === 'string' && draft !== '' ? draft : undefined;
    return current === undefined || options.some((option) => option.value === current)
      ? options
      : [{ value: current, label: current }, ...options];
  });

  /** Changes the draft, which clears what the last save said about the old one. */
  function change(next: unknown): void {
    autosave.clear(name);
    onEdit?.();
    form.set(name, next);
  }

  /** The field was left, or a switch or select changed: save it. */
  function leave(): void {
    void autosave.commit(name);
  }

  /** Saves when focus leaves the whole control, not when it moves between the parts of one. */
  function leaveControl(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget instanceof Node) {
      if (event.currentTarget.contains(next)) return;
    }
    leave();
  }
</script>

<div
  class="weft-setting"
  data-setting={name}
  data-apply={keyState.apply}
  data-locked={locked ? 'true' : 'false'}
  data-dirty={form.isDirty(name) ? 'true' : 'false'}
>
  <SettingRow
    {id}
    {label}
    identifier={name}
    {description}
    {...status === undefined ? {} : { status }}
    {...statusLabel === undefined ? {} : { statusLabel }}
    {...error === undefined ? {} : { error }}
    {...retriable ? { onRetry: () => void autosave.retry(name) } : {}}
    {...locked ? { managed: { message: SETTINGS_COPY.lockedMessage } } : {}}
    disabled={locked}
  >
    {#snippet control()}
      {#if spec.kind === 'toggle'}
        <Toggle
          {id}
          {label}
          checked={draft === true}
          disabled={locked}
          onValueChange={(next) => {
            change(next);
            leave();
          }}
        />
      {:else if spec.kind === 'switch-form' || spec.kind === 'switch-json'}
        <Toggle
          {id}
          {label}
          checked={switchedOn}
          disabled={locked}
          onValueChange={(next) => {
            autosave.clear(name);
            onEdit?.();
            form.setSwitch(name, next);
            leave();
          }}
        />
      {:else if spec.kind === 'select'}
        <Select
          {id}
          {label}
          labelVisible={false}
          options={spec.options.map((option) => ({ value: option, label: option }))}
          {...typeof draft === 'string' ? { value: draft } : {}}
          disabled={locked}
          onchange={(event) => {
            change(event.currentTarget.value);
            leave();
          }}
        />
      {:else if spec.kind === 'choice'}
        <Select
          {id}
          {label}
          labelVisible={false}
          options={hasValue ? choices : [{ value: '', label: SETTINGS_COPY.notSet }, ...choices]}
          value={typeof draft === 'string' ? draft : ''}
          disabled={locked}
          onchange={(event) => {
            change(event.currentTarget.value || undefined);
            leave();
          }}
        />
      {:else if spec.kind === 'text'}
        <div onfocusout={leaveControl}>
          <Input
            {id}
            {label}
            variant="code"
            value={typeof draft === 'string' ? draft : ''}
            disabled={locked}
            onValueChange={(next) => change(next)}
          />
        </div>
      {:else if spec.kind === 'number' && duration !== undefined}
        <div onfocusout={leaveControl}>
          <DurationField
            {id}
            value={typeof draft === 'number' ? draft : null}
            unit={duration.unit}
            unitSelectable={duration.selectable}
            disabled={locked}
            onValueChange={(next) => change(next ?? undefined)}
          />
        </div>
      {:else if spec.kind === 'number'}
        <div onfocusout={leaveControl}>
          <NumberInput
            {id}
            value={typeof draft === 'number' ? draft : null}
            disabled={locked}
            {...unit === undefined ? {} : { adornment: unit }}
            onValueChange={(next) => change(next ?? undefined)}
          />
        </div>
      {:else if spec.kind === 'form' && !hasValue && !revealed && !locked}
        <div class="weft-setting__unset">
          <span>{SETTINGS_COPY.notSet}</span>
          <Button variant="secondary" size="sm" onclick={() => (revealed = true)}>
            {SETTINGS_COPY.setAction}
          </Button>
        </div>
      {:else if spec.kind === 'form' || spec.kind === 'json'}
        <span class="weft-setting__unset">{hasValue ? '' : SETTINGS_COPY.notSet}</span>
      {/if}
    {/snippet}
    {#snippet disclosure()}
      {#if formSchema !== undefined && formShown}
        <!-- A `SchemaForm` takes its value once, so it is made again whenever the draft starts over. -->
        {#key form.generation}
          <fieldset class="weft-setting__form" disabled={locked} onfocusout={leaveControl}>
            <SchemaForm
              schema={formSchema}
              name={`setting-${id}`}
              value={spec.kind === 'switch-form' && draft === false ? undefined : draft}
              jsonEditable={false}
              onDraftChange={(next) => change(next)}
              onSubmit={() => leave()}
            />
          </fieldset>
        {/key}
      {:else if spec.kind === 'json'}
        <div onfocusout={leaveControl}>
          <JsonEditor
            id={`${id}-json`}
            {label}
            rows={8}
            validFeedbackVisible={false}
            disabled={locked}
            value={form.text(name)}
            error={problem ?? ''}
            onValueChange={(next) => {
              autosave.clear(name);
              onEdit?.();
              form.setText(name, next);
            }}
          />
        </div>
      {/if}
    {/snippet}
  </SettingRow>
</div>

<style>
  .weft-setting {
    min-inline-size: 0;
  }

  .weft-setting__unset {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    align-items: center;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .weft-setting__form {
    min-inline-size: 0;
    margin: var(--cinder-space-3) 0 0;
    padding: 0;
    border: 0;
  }

  /* A setting saves as it is left, so the form's own submit button is not drawn. */
  .weft-setting__form :global(button[type='submit']) {
    display: none;
  }
</style>
