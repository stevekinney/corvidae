<script lang="ts">
  /**
   * One setting: the control its schema shape calls for (`settings-controls.ts`), what the Bureau
   * says about the key (how it applies, whether the deployment locked it, whether a stored value
   * waits for a restart), and what is wrong with the draft. A locked key's control is disabled, and
   * the row says the deployment holds it.
   */
  import {
    Badge,
    FormSection,
    Input,
    JsonEditor,
    NumberInput,
    Select,
    Toggle,
    humanizeIdentifier,
  } from '@lostgradient/cinder';

  import { SETTINGS_COPY } from '../../app/copy.ts';
  import type { SchemaNode, SettingKeyState } from '../../lib/bureau-settings.ts';
  import { isDuration, type Control, type NumberField } from './settings-controls.ts';
  import type { SettingsForm } from './settings-form.svelte.ts';

  interface Props {
    name: string;
    node: SchemaNode;
    control: Control;
    form: SettingsForm;
    state: SettingKeyState;
  }

  let { name, node, control, form, state }: Props = $props();

  /** The option that stands for the object, in a setting that is a literal or an object. */
  const FIELDS_OPTION = '__fields__';

  const id = $derived(`weft-setting-${name.replaceAll('.', '-')}`);
  /** The schema's description, without the Markdown marks around names. */
  const description = $derived((node.description ?? '').replaceAll('`', ''));
  const draft = $derived(form.draft(name));
  const error = $derived(form.error(name));
  const locked = $derived(state.locked);
  const hasValue = $derived(draft !== undefined);

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function fieldValue(field: NumberField): number | null {
    const value = isRecord(draft) ? draft[field.name] : undefined;
    return typeof value === 'number' ? value : null;
  }

  function setField(field: NumberField, value: number | null): void {
    const { [field.name]: _previous, ...rest } = isRecord(draft) ? draft : {};
    form.set(name, value === null ? rest : { ...rest, [field.name]: value });
  }

  function fieldLabel(field: NumberField): string {
    const label = humanizeIdentifier(field.name);
    return isDuration(field.name) ? `${label} (${SETTINGS_COPY.milliseconds})` : label;
  }

  /** The label of the option that stands for the object: its first required field in words. */
  function fieldsOptionLabel(fields: readonly NumberField[]): string {
    const first = fields.find((field) => field.required) ?? fields[0];
    return first === undefined ? '' : humanizeIdentifier(first.name);
  }

  function chooseMode(value: string): void {
    if (value === FIELDS_OPTION) {
      if (!isRecord(draft)) form.set(name, {});
    } else {
      form.set(name, value);
    }
  }

  const modeOptions = $derived(
    control.kind === 'literal-or-fields'
      ? [
          ...control.literals.map((literal) => ({ value: literal, label: literal })),
          { value: FIELDS_OPTION, label: fieldsOptionLabel(control.fields) },
        ]
      : [],
  );
  const mode = $derived(typeof draft === 'string' ? draft : FIELDS_OPTION);
  /** Whether a number field is shown: always for an object-valued setting, and only for the object's option in a union. */
  const showFields = $derived(control.kind === 'fields' || mode === FIELDS_OPTION);
</script>

<div
  class="weft-setting"
  data-setting={name}
  data-apply={state.apply}
  data-locked={locked ? 'true' : 'false'}
  data-dirty={form.isDirty(name) ? 'true' : 'false'}
>
  <div class="weft-setting__control">
    {#if control.kind === 'toggle'}
      <Toggle
        {id}
        label={name}
        checked={draft === true}
        disabled={locked}
        onValueChange={(next) => form.set(name, next)}
      />
      <p class="weft-setting__description">{description}</p>
    {:else if control.kind === 'select'}
      <Select
        {id}
        label={name}
        {description}
        options={control.options.map((option) => ({ value: option, label: option }))}
        {...typeof draft === 'string' ? { value: draft } : {}}
        disabled={locked}
        onchange={(event) => form.set(name, event.currentTarget.value)}
      />
    {:else if control.kind === 'text'}
      <Input
        {id}
        label={name}
        {description}
        variant="code"
        value={typeof draft === 'string' ? draft : ''}
        disabled={locked}
        error={error ?? ''}
        onValueChange={(next) => form.set(name, next)}
      />
    {:else if control.kind === 'number'}
      <NumberInput
        {id}
        label={name}
        {description}
        value={typeof draft === 'number' ? draft : null}
        disabled={locked}
        error={error ?? ''}
        onValueChange={(next) => form.set(name, next ?? undefined)}
      />
    {:else if control.kind === 'fields' || control.kind === 'literal-or-fields'}
      <FormSection as="fieldset" heading={name} {description} columns={2}>
        {#if control.kind === 'literal-or-fields'}
          <Select
            id={`${id}-mode`}
            label={SETTINGS_COPY.modeLabel}
            options={modeOptions}
            value={mode}
            disabled={locked}
            onchange={(event) => chooseMode(event.currentTarget.value)}
          />
        {/if}
        {#if showFields}
          {#each control.fields as field (field.name)}
            <NumberInput
              id={`${id}-${field.name}`}
              label={fieldLabel(field)}
              value={fieldValue(field)}
              disabled={locked}
              onValueChange={(next) => setField(field, next)}
            />
          {/each}
        {/if}
      </FormSection>
      {#if error !== undefined}
        <p class="weft-setting__error" role="alert">{error}</p>
      {/if}
    {:else if control.kind === 'switch-json'}
      <Toggle
        {id}
        label={name}
        checked={draft !== false && draft !== undefined}
        disabled={locked}
        onValueChange={(next) => form.setSwitch(name, next)}
      />
      <p class="weft-setting__description">{description}</p>
      {#if draft !== false && draft !== undefined}
        <JsonEditor
          id={`${id}-json`}
          label={`${name}: ${SETTINGS_COPY.jsonLabel}`}
          rows={6}
          validFeedbackVisible={false}
          disabled={locked}
          value={form.text(name)}
          error={error ?? ''}
          onValueChange={(next) => form.setText(name, next)}
        />
      {/if}
    {:else}
      <JsonEditor
        {id}
        label={name}
        {description}
        rows={8}
        validFeedbackVisible={false}
        disabled={locked}
        value={form.text(name)}
        error={error ?? ''}
        onValueChange={(next) => form.setText(name, next)}
      />
    {/if}
    {#if !hasValue && !locked}
      <p class="weft-setting__unset">{SETTINGS_COPY.unset}</p>
    {/if}
  </div>
  <div class="weft-setting__status">
    <Badge size="sm" variant={state.apply === 'live' ? 'success' : 'neutral'}
      >{SETTINGS_COPY.apply[state.apply]}</Badge
    >
    {#if state.pendingRestart}
      <Badge size="sm" variant="warning">{SETTINGS_COPY.pendingRestart}</Badge>
    {/if}
    {#if locked}
      <Badge size="sm" variant="info">{SETTINGS_COPY.locked}</Badge>
    {/if}
  </div>
  {#if locked}
    <p class="weft-setting__locked">
      {SETTINGS_COPY.lockedNote[state.lockReason ?? 'deployment']}
    </p>
  {/if}
</div>

<style>
  .weft-setting {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--cinder-space-2) var(--cinder-space-4);
    align-items: start;
    padding-block: var(--cinder-space-3);
    border-bottom: 1px solid var(--cinder-border-muted);
  }

  .weft-setting__control {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .weft-setting__status {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-1);
    justify-content: flex-end;
  }

  .weft-setting__description,
  .weft-setting__unset,
  .weft-setting__locked {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .weft-setting__locked {
    grid-column: 1 / -1;
  }

  .weft-setting__error {
    margin: 0;
    color: var(--cinder-status-danger-text);
    font-size: var(--cinder-text-sm);
  }

  @media (max-width: 40rem) {
    .weft-setting {
      grid-template-columns: minmax(0, 1fr);
    }

    .weft-setting__status {
      justify-content: flex-start;
    }
  }
</style>
