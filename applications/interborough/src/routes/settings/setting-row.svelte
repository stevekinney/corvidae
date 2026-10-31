<script lang="ts">
  /**
   * One setting: the control its schema shape calls for (`settings-controls.ts`), the description the
   * Bureau gives it as inline Markdown, what the Bureau says about the key (whether it needs a
   * restart, whether the deployment locked it and why, whether a stored value waits for a restart),
   * and what is wrong with the draft. A value that is an object is edited through a Cinder
   * `SchemaForm`; a locked key's control is disabled and the row says why.
   */
  import {
    Badge,
    Button,
    Input,
    JsonEditor,
    NumberInput,
    SchemaForm,
    Select,
    Toggle,
  } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { SETTINGS_COPY } from '../../app/copy.ts';
  import { getAgentCatalog } from '../../lib/agent-definitions.ts';
  import type { SchemaNode, SettingKeyState } from '../../lib/bureau-settings.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { inlineSegments } from './inline-markdown.ts';
  import { HOST_DECISION_MODELS, holdsForm, type Control } from './settings-controls.ts';
  import { formSchemaOf } from './settings-form-schema.ts';
  import type { SettingsForm } from './settings-form.svelte.ts';

  interface Props {
    name: string;
    node: SchemaNode;
    control: Control;
    form: SettingsForm;
    keyState: SettingKeyState;
    /** Saves the changes, which a `SchemaForm` asks for when Enter is pressed in one of its fields. Offline, the request itself is refused (`lib/write-guard.ts`). */
    requestSave: () => void;
  }

  let { name, node, control, form, keyState, requestSave }: Props = $props();

  const id = $derived(`weft-setting-${name.replaceAll('.', '-')}`);
  const segments = $derived(inlineSegments(node.description ?? ''));
  const draft = $derived(form.draft(name));
  const error = $derived(form.error(name));
  const locked = $derived(keyState.locked);
  const hasValue = $derived(draft !== undefined);
  const formSchema = $derived(holdsForm(control) ? formSchemaOf(name, node) : undefined);
  const switchedOn = $derived(draft !== false && draft !== undefined);
  /** An unset object stays "Not set" until the person asks to set it, so its empty fields carry no error. */
  let revealed = $state(false);
  const formShown = $derived(
    (control.kind === 'form' && (hasValue || revealed)) ||
      (control.kind === 'switch-form' && switchedOn),
  );

  // The catalog is read only for a key that names one of its rows.
  const catalog = createQuery(
    () => ({
      queryKey: queryKeys.agents.catalog(),
      queryFn: ({ signal }) => getAgentCatalog({ signal }),
      enabled: control.kind === 'choice' && control.source === 'catalog-rows',
      retry: false,
    }),
    undefined,
  );

  /** The options of a select of rows: what the source offers, and the value the key holds now so it is never lost. */
  const choices = $derived.by(() => {
    if (control.kind !== 'choice') return [];
    const options =
      control.source === 'catalog-rows'
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
</script>

<div
  class="weft-setting"
  data-setting={name}
  data-apply={keyState.apply}
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
    {:else if control.kind === 'select'}
      <Select
        {id}
        label={name}
        options={control.options.map((option) => ({ value: option, label: option }))}
        {...typeof draft === 'string' ? { value: draft } : {}}
        disabled={locked}
        onchange={(event) => form.set(name, event.currentTarget.value)}
      />
    {:else if control.kind === 'choice'}
      <Select
        {id}
        label={name}
        options={hasValue ? choices : [{ value: '', label: SETTINGS_COPY.notSet }, ...choices]}
        value={typeof draft === 'string' ? draft : ''}
        disabled={locked}
        error={error ?? ''}
        onchange={(event) => form.set(name, event.currentTarget.value || undefined)}
      />
    {:else if control.kind === 'text'}
      <Input
        {id}
        label={name}
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
        value={typeof draft === 'number' ? draft : null}
        disabled={locked}
        error={error ?? ''}
        onValueChange={(next) => form.set(name, next ?? undefined)}
      />
    {:else if control.kind === 'switch-form'}
      <Toggle
        {id}
        label={name}
        checked={switchedOn}
        disabled={locked}
        onValueChange={(next) => form.setSwitch(name, next)}
      />
    {:else if control.kind === 'form'}
      <p class="weft-setting__name">{name}</p>
    {:else}
      <JsonEditor
        {id}
        label={name}
        rows={8}
        validFeedbackVisible={false}
        disabled={locked}
        value={form.text(name)}
        error={error ?? ''}
        onValueChange={(next) => form.setText(name, next)}
      />
    {/if}
    <p class="weft-setting__description">
      {#each segments as segment, index (index)}
        {#if segment.kind === 'code'}<code>{segment.text}</code>{:else}{segment.text}{/if}
      {/each}
    </p>
    {#if formSchema !== undefined && formShown}
      <!-- A `SchemaForm` takes its value once, so it is made again whenever the draft starts over. -->
      {#key form.generation}
        <fieldset class="weft-setting__form" disabled={locked}>
          <SchemaForm
            schema={formSchema}
            name={`setting-${id}`}
            value={control.kind === 'switch-form' && draft === false ? undefined : draft}
            jsonEditable={false}
            onDraftChange={(next) => form.set(name, next)}
            onSubmit={() => requestSave()}
          />
        </fieldset>
      {/key}
    {/if}
    {#if control.kind === 'form' && !hasValue && !revealed && !locked}
      <div class="weft-setting__unset-row">
        <span class="weft-setting__unset">{SETTINGS_COPY.notSet}</span>
        <Button variant="secondary" size="sm" onclick={() => (revealed = true)}>
          {SETTINGS_COPY.setAction}
        </Button>
      </div>
    {:else if !hasValue && !locked && control.kind !== 'choice'}
      <p class="weft-setting__unset">{SETTINGS_COPY.unset}</p>
    {/if}
    {#if formSchema !== undefined && error !== undefined}
      <p class="weft-setting__error" role="alert">{error}</p>
    {/if}
  </div>
  <div class="weft-setting__status">
    {#if keyState.apply === 'restart'}
      <Badge size="sm" variant="neutral">{SETTINGS_COPY.apply.restart}</Badge>
    {/if}
    {#if keyState.pendingRestart}
      <Badge size="sm" variant="warning">{SETTINGS_COPY.pendingRestart}</Badge>
    {/if}
    {#if locked}
      <Badge size="sm" variant="info">{SETTINGS_COPY.locked}</Badge>
    {/if}
  </div>
  {#if locked}
    <p class="weft-setting__locked">
      {SETTINGS_COPY.lockedNote[keyState.lockReason ?? 'deployment']}
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

  .weft-setting__name {
    margin: 0;
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-sm);
  }

  .weft-setting__form {
    min-inline-size: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }

  /* The page saves every change at once, so the form's own submit button is not drawn. */
  .weft-setting__form :global(button[type='submit']) {
    display: none;
  }

  .weft-setting__unset-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    align-items: center;
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

  .weft-setting__description {
    overflow-wrap: anywhere;
  }

  .weft-setting__description code {
    font-family: var(--cinder-font-mono);
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
