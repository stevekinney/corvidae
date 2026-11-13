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
    type SelectOption,
  } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';
  import type { Snippet } from 'svelte';

  import { SETTINGS_COPY } from '../../app/copy/settings.ts';
  import { getAgentCatalog, isAvailableModel } from '../../lib/agent-definitions.ts';
  import type { SchemaNode, SettingKeyState } from '../../lib/bureau-settings.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { inlineSegments } from './inline-markdown.ts';
  import { modelDisplayName } from './models/format-model.ts';
  import {
    DURATION_SETTINGS,
    SETTING_UNITS,
    holdsForm,
    optionLabel,
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
    /** Whether the banner's Revert put this setting back to its running value ("Reverted, in effect now"). */
    reverted?: boolean;
    /** The row's own words in place of the Bureau's description, such as in the Remote deployment card. */
    descriptionOverride?: string | undefined;
    /** The row's own label in place of the one made from the key, such as "Decision model" for `decisions.model`. */
    labelOverride?: string | undefined;
    /**
     * The value the setting applies by while it holds none (the snapshot's `effective` entry), shown
     * as the placeholder of an empty text or number field, so an empty field says what is in force.
     */
    inForce?: unknown;
    /**
     * The options of a select of decision rows (`source: 'decision-rows'`), which the page that
     * owns the list builds from `bureau.decisions.models`: a label, the provider as its group, and
     * the words "Needs setup" as a row's note. The field draws them and decides nothing about them.
     */
    rowChoices?: readonly SelectOption[] | undefined;
    /** What the empty option of a select of decision rows says, such as the row that answers while it is empty. */
    emptyLabel?: string | undefined;
    /**
     * An advisory condition the row shows without refusing anything, in place of the Bureau's own
     * `problem` for the key (which names the value in the Bureau's own syntax).
     */
    warning?: string | undefined;
    /** Called when the person changes the value, which ends what Revert said about it. */
    onEdit?: (() => void) | undefined;
    /**
     * Draws the row's control in place of the one the schema shape calls for, such as a switch per
     * agent for a record of agents. The row still words the save, the error and the lock; the
     * control is told the row's id and whether it is disabled, and saves through `form` and
     * `autosave` itself.
     */
    custom?: Snippet<[{ id: string; disabled: boolean }]> | undefined;
    /** The width of the column the control sits in, when it needs more room than a switch (`"16rem"`). */
    controlWidth?: string | undefined;
    /** Disables the control without saying a deployment locked it, such as while another setting is off. */
    disabled?: boolean;
    /**
     * What the status line says for a restart-applied setting that waits for nothing: in place of
     * "Applies after restart", such as the words for a switch that is off.
     */
    statusNote?: string | undefined;
    /** A quiet link after the description, such as "Connect TypeSafe"; it joins the row's `aria-describedby`. */
    descriptionAction?: Snippet | undefined;
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
    inForce,
    rowChoices,
    emptyLabel,
    warning,
    onEdit,
    custom,
    controlWidth,
    disabled = false,
    statusNote,
    descriptionAction,
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
  /** Whether the control cannot be changed: the deployment locked the setting, or the page holds it. */
  const inert = $derived(locked || disabled);
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
    status === 'saved' && saveState?.phase !== 'saved'
      ? appliedNote
      : status === 'restart'
        ? statusNote
        : undefined,
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

  /** The options of a select of catalog rows: the rows an agent could run on, and the value the key holds now so it is never lost. */
  const choices = $derived.by(() => {
    if (spec.kind !== 'choice' || spec.source !== 'catalog-rows') return [];
    const options = (catalog.data?.models ?? []).filter(isAvailableModel).map((row) => {
      const value = `${row.provider}/${row.model}`;
      return { value, label: value };
    });
    const current = typeof draft === 'string' && draft !== '' ? draft : undefined;
    return current === undefined || options.some((option) => option.value === current)
      ? options
      : [{ value: current, label: current }, ...options];
  });

  /**
   * What the empty option of a select says: the words the page gives it (the row that answers while
   * the setting is empty), else the row the setting applies by while it holds none, named as a
   * person says it ("Claude Haiku 5.5 (default)"), else "Not set".
   */
  const emptyOption = $derived.by(() => {
    if (emptyLabel !== undefined) return emptyLabel;
    const slash = typeof inForce === 'string' ? inForce.indexOf('/') : -1;
    return typeof inForce === 'string' && slash > 0 && slash < inForce.length - 1
      ? SETTINGS_COPY.defaultOption(modelDisplayName(inForce.slice(slash + 1)))
      : SETTINGS_COPY.notSet;
  });
  const advisory = $derived(warning ?? keyState.problem);

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
    {...descriptionAction === undefined ? {} : { descriptionAction }}
    {...status === undefined ? {} : { status }}
    {...statusLabel === undefined ? {} : { statusLabel }}
    {...error === undefined ? {} : { error }}
    {...advisory === undefined ? {} : { warning: advisory }}
    {...retriable ? { onRetry: () => void autosave.retry(name) } : {}}
    {...locked ? { managed: { message: SETTINGS_COPY.lockedMessage } } : {}}
    {...controlWidth === undefined ? {} : { controlWidth }}
    disabled={inert}
  >
    {#snippet control()}
      {#if custom !== undefined}
        {@render custom({ id, disabled: inert })}
      {:else if spec.kind === 'toggle'}
        <Toggle
          {id}
          {label}
          checked={draft === true}
          disabled={inert}
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
          disabled={inert}
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
          options={spec.options.map((option) => ({ value: option, label: optionLabel(option) }))}
          {...typeof draft === 'string' ? { value: draft } : {}}
          disabled={inert}
          onchange={(event) => {
            change(event.currentTarget.value);
            leave();
          }}
        />
      {:else if spec.kind === 'choice' && spec.source === 'decision-rows'}
        <!-- The empty option stays, so a chosen row can be put back to the default. -->
        <Select
          {id}
          {label}
          labelVisible={false}
          presentation="listbox"
          placeholder={emptyOption}
          options={[{ value: '', label: emptyOption }, ...(rowChoices ?? [])]}
          value={typeof draft === 'string' ? draft : ''}
          disabled={inert}
          onValueChange={(next: string) => {
            change(next || undefined);
            leave();
          }}
        />
      {:else if spec.kind === 'choice'}
        <Select
          {id}
          {label}
          labelVisible={false}
          options={hasValue ? choices : [{ value: '', label: emptyOption }, ...choices]}
          value={typeof draft === 'string' ? draft : ''}
          disabled={inert}
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
            {...typeof inForce === 'string' && inForce !== '' ? { placeholder: inForce } : {}}
            disabled={inert}
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
            disabled={inert}
            onValueChange={(next) => change(next ?? undefined)}
          />
        </div>
      {:else if spec.kind === 'number'}
        <div onfocusout={leaveControl}>
          <NumberInput
            {id}
            value={typeof draft === 'number' ? draft : null}
            disabled={inert}
            {...typeof inForce === 'number' ? { placeholder: String(inForce) } : {}}
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
      {#if custom !== undefined}
        <!-- A custom control draws the whole value itself, so there is nothing to disclose. -->
      {:else if formSchema !== undefined && formShown}
        <!-- A `SchemaForm` takes its value once, so it is made again whenever the draft starts over. -->
        {#key form.generation}
          <fieldset class="weft-setting__form" disabled={inert} onfocusout={leaveControl}>
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
            disabled={inert}
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
