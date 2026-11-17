<!--
  Internal component: owns all mutable form state so that the outer
  {#key schema} block in schema-form.svelte causes genuine $state recreation
  when the schema prop changes.

  This component is NOT part of the public API. Import SchemaForm instead.
-->
<script lang="ts">
  import { tick, untrack } from 'svelte';

  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';
  import { ownEntry } from '@lostgradient/tokens/_internal/own-entry.ts';
  import Button from '../button/button.svelte';
  import Checkbox from '@lostgradient/checkbox/components/checkbox/checkbox.svelte';
  import Collapsible from '@lostgradient/collapsible/components/collapsible/collapsible.svelte';
  import Input from '@lostgradient/input/components/input/input.svelte';
  import JsonEditor from '../json-editor/json-editor.svelte';
  import NumberInput from '../number-input/number-input.svelte';
  import Segment from '@lostgradient/segmented-control/components/segment/segment.svelte';
  import SettingRow from '../setting-row/setting-row.svelte';
  import TagInput from '@lostgradient/tag-input/components/tag-input/tag-input.svelte';
  import SegmentedControl from '@lostgradient/segmented-control/components/segmented-control/segmented-control.svelte';
  import Select from '../select/select.svelte';
  import Textarea from '@lostgradient/textarea/components/textarea/textarea.svelte';
  import Toggle from '@lostgradient/toggle/components/toggle/toggle.svelte';

  import {
    choiceBranchForValue,
    countLeafFields,
    createSchemaFormModel,
    blankMomentValue,
    fieldAtPathExists,
    getValueAtPath,
    initialValueForField,
    isTemporalStringSchema,
    modelOptionsForVariant,
    schemaHoldsConcealedField,
    sentenceCaseLabel,
    isRecord,
    pathId,
    pathKey,
    rebaseFieldPath,
    type SchemaFormField,
  } from './schema-form-model.ts';
  import SchemaFormChips from './schema-form-chips.svelte';
  import DurationField from '../duration-field/duration-field.svelte';
  import { focusFirstProblem } from '../form/focus-first-problem.ts';
  import SchemaFormJsonPanel from './schema-form-json-panel.svelte';
  import SchemaFormRecord from './schema-form-record.svelte';
  import { createSchemaFormState } from './schema-form-state.svelte.ts';
  import { summarizeGroup } from './schema-form-summary.ts';
  import SchemaFormTags from './schema-form-tags.svelte';
  import type { SchemaFormOutput, SchemaFormProps } from './schema-form.types.ts';
  import {
    parseJsonDraft,
    serializeValidatedValue,
    validateSchemaValue,
    type SchemaFormValidationIssue,
  } from './schema-form-validation.ts';

  /**
   * A form with more fields than this is "large": it gains the Find a field filter, Edit as JSON,
   * required-first ordering, two columns and collapsible groups. Smaller forms keep the plain
   * stacked layout.
   */
  const LARGE_FORM_FIELD_THRESHOLD = 8;

  /** Kinds whose control needs the full row; the rest are short enough to share one. */
  const WIDE_KINDS: ReadonlySet<SchemaFormField['kind']> = new Set([
    'object',
    'array',
    'enumArray',
    'tags',
    'record',
    'choice',
    'json',
  ]);

  /** Kinds a setting row carries at its inline end; every other kind is drawn full width under the row. */
  const INLINE_KINDS: ReadonlySet<SchemaFormField['kind']> = new Set([
    'string',
    'enum',
    'boolean',
    'number',
    'integer',
  ]);

  /** Kinds edited by one control that holds many values, so their descendants' issues show on it. */
  const AGGREGATE_KINDS: ReadonlySet<SchemaFormField['kind']> = new Set([
    'enumArray',
    'tags',
    'record',
  ]);

  /**
   * SchemaFormBody receives the same props as SchemaForm. The schema prop is
   * fixed at mount — the outer {#key schema} wrapper in schema-form.svelte
   * destroys and recreates this component when schema changes, causing all
   * $state below to genuinely reset.
   *
   * `value` is a SEED: the consumer owns the form state after mount. Changing
   * the `value` prop after mount with the same schema does NOT reset formValue
   * — only a schema change (which triggers a remount) resets the form.
   */
  let {
    schema,
    value,
    name = 'value',
    jsonEditable = true,
    issues: hostIssues,
    submitLabel = 'Submit',
    variant = 'default',
    submitVisible = true,
    disabled = false,
    hosted = false,
    class: customClassName,
    onSubmit,
    onDraftChange,
    novalidate,
    ...rest
  }: SchemaFormProps = $props();

  const generatedId = $props.id();

  // All mutable state is declared here so it resets when the component is
  // remounted via {#key schema}. The initial values are seeded once from
  // the schema+value at mount time.
  /** How the schema is read: the `input` variant draws an array of objects as one JSON field. */
  function modelOptions() {
    return modelOptionsForVariant(variant);
  }

  function createInitialState() {
    const initialModel = createSchemaFormModel(schema, modelOptions());
    return {
      initialModel,
      initialFormValue: initialValueForField(initialModel.field, value),
    };
  }

  const { initialModel, initialFormValue } = createInitialState();
  const model = $derived(createSchemaFormModel(schema, modelOptions()));
  let formElement = $state<HTMLElement>();
  let serializedInputElement = $state<HTMLInputElement>();
  let submitting = $state(false);
  /** Whether the controls are held: while a submit validates, or when the host disables the form. */
  const frozen = $derived(submitting || disabled);
  const settingRows = $derived(variant === 'setting-rows');
  let allowNativeSubmit = false;
  let activeSubmitId = 0;

  const formState = createSchemaFormState(initialModel, initialFormValue, {
    getSubmitting: () => frozen,
    onDraftChange: (draft) => onDraftChange?.(draft),
  });

  // Host-reported problems (a server-side refusal) show on their fields like built-in ones.
  $effect(() => {
    if (hostIssues === undefined || hostIssues.length === 0) return;
    const named = hostIssues.map((issue) => ({
      path: issue.path.map(String),
      message: issue.message,
    }));
    // A path that names no field would show nowhere, so its message goes on the form itself.
    const unplaced = named.filter((issue) => !fieldAtPathExists(model.field, issue.path));
    const shown = [
      ...named.filter((issue) => !unplaced.includes(issue)),
      ...(unplaced.length === 0
        ? []
        : [{ path: [], message: unplaced.map((issue) => issue.message).join(' ') }]),
    ];
    untrack(() => {
      revealIssues(shown);
      formState.applyIssues(shown);
    });
  });

  // The hidden serialized-output input is a plain DOM ref, not a Svelte
  // binding, so it needs an explicit sync whenever the state class's
  // serializedValue changes (cleared on every edit, set on a successful
  // submit).
  $effect(() => {
    if (serializedInputElement) serializedInputElement.value = formState.serializedValue;
  });

  let filterText = $state('');
  let groupOverrides = $state<Record<string, boolean>>({});
  let jsonPanelOpen = $state(false);
  let jsonText = $state('');
  let jsonError = $state<string | undefined>();

  // The panel prints the whole value as text, which a form with a secret field cannot do safely.
  const jsonPanelAllowed = $derived(jsonEditable && !hosted && !schemaHoldsConcealedField(schema));
  // The setting rows keep one shape at any size: no filter, no JSON panel, no reordering, no groups.
  const largeForm = $derived(
    !settingRows && countLeafFields(model.field) > LARGE_FORM_FIELD_THRESHOLD,
  );
  const filterQuery = $derived(filterText.trim().toLowerCase());

  const formId = $derived((rest.id as string | undefined) ?? `${generatedId}-form`);
  const rootFields = $derived(
    arrangeFields(model.field.kind === 'object' ? model.field.fields : [model.field]),
  );
  const rootError = $derived(
    model.field.kind === 'object' ? formState.errors[pathKey([])] : undefined,
  );
  const rootErrorId = $derived(`${formId}-${pathId([])}-error`);

  function fieldDomId(field: SchemaFormField): string {
    return `${formId}-${pathId(field.path)}`;
  }

  /**
   * The message shown on a field. A collection control has no per-item fields of its own, so an
   * issue at one of its items (`labels/0`) is shown on the control, which is the only place the
   * person can see and correct it.
   */
  function fieldError(field: SchemaFormField): string | undefined {
    return AGGREGATE_KINDS.has(field.kind)
      ? formState.errorWithin(field)
      : formState.errors[pathKey(field.path)];
  }

  /** Whether a field's control is in the document right now, as opposed to filtered or collapsed away. */
  function isFieldRendered(field: SchemaFormField): boolean {
    return formElement?.querySelector(`[id="${CSS.escape(fieldDomId(field))}"]`) != null;
  }

  function stringValue(field: SchemaFormField): string {
    const current = getValueAtPath(formState.formValue, field.path);
    return current === undefined || current === null ? '' : String(current);
  }

  function numberValue(field: SchemaFormField): number | undefined {
    const current = getValueAtPath(formState.formValue, field.path);
    return typeof current === 'number' ? current : undefined;
  }

  function booleanValue(field: SchemaFormField): boolean {
    return getValueAtPath(formState.formValue, field.path) === true;
  }

  function enumValue(field: SchemaFormField): string {
    const current = getValueAtPath(formState.formValue, field.path);
    const option = field.options.find((candidate) => Object.is(candidate.value, current));
    if (field.clearable) return option?.encodedValue ?? '';
    return option?.encodedValue ?? field.options[0]?.encodedValue ?? '';
  }

  /** What a setting row calls a field: the schema's title, else its key in sentence case. */
  function rowLabel(field: SchemaFormField): string {
    const title = field.schema['title'];
    return typeof title === 'string' && title.trim().length > 0
      ? title
      : sentenceCaseLabel(field.key);
  }

  /** The words a field is named with: sentence case in the `setting-rows` variant, the model's label otherwise. */
  function textOf(field: SchemaFormField): string {
    return settingRows ? rowLabel(field) : field.label;
  }

  /** A row shows its key only beside a title the schema supplies, and not when that title is the key in another case. */
  function rowIdentifier(field: SchemaFormField): string | undefined {
    const title = field.schema['title'];
    if (typeof title !== 'string' || title.trim().length === 0) return undefined;
    return title.toLowerCase() === field.key.toLowerCase() ? undefined : field.key;
  }

  /** Map a field's options to Select's `{ value, label }` shape, keyed on the
   *  encoded (string) value so the native <option> values stay round-trippable. */
  function selectOptions(field: SchemaFormField): Array<{ value: string; label: string }> {
    const choices = field.options.map((option) => ({
      value: option.encodedValue,
      label: option.label,
    }));
    return field.clearable ? [{ value: '', label: 'Not set' }, ...choices] : choices;
  }

  /** NumberInput binds a `number | null`; the model stores `undefined` for an
   *  empty numeric field, so translate between the two at the binding edge. */
  function numberFieldValue(field: SchemaFormField): number | null {
    return numberValue(field) ?? null;
  }

  function rawJsonValue(field: SchemaFormField): string {
    const key = pathKey(field.path);
    if (formState.rawDrafts[key] !== undefined) return formState.rawDrafts[key];
    return JSON.stringify(getValueAtPath(formState.formValue, field.path) ?? null, null, 2);
  }

  function arrayOptionValues(field: SchemaFormField): unknown[] {
    const current = getValueAtPath(formState.formValue, field.path);
    return Array.isArray(current) ? current : [];
  }

  function stringArrayValue(field: SchemaFormField): string[] {
    return arrayOptionValues(field).filter((entry): entry is string => typeof entry === 'string');
  }

  /** Whether short fields share a row: a large form always does, and the `input` variant does at any size. */
  const paired = $derived(largeForm || variant === 'input');

  function spanOf(field: SchemaFormField): 'full' | undefined {
    if (!paired) return undefined;
    // A switch carries a line of explanation, so the `input` variant gives it the whole row.
    if (variant === 'input' && field.kind === 'boolean') return 'full';
    return WIDE_KINDS.has(field.kind) ? 'full' : undefined;
  }

  /** What the JSON field's status line says when it parses: an array is counted ("Valid JSON, array of 1 item"). */
  function jsonStatusLabel(field: SchemaFormField): string {
    const parsed = parseJsonDraft(field.path, rawJsonValue(field));
    if (!parsed.ok || !Array.isArray(parsed.value)) return 'Valid JSON';
    const count = parsed.value.length;
    return `Valid JSON, array of ${count} ${count === 1 ? 'item' : 'items'}`;
  }

  function matchesFilter(field: SchemaFormField): boolean {
    if (filterQuery === '') return true;
    const own = `${field.label} ${field.key} ${field.description ?? ''}`.toLowerCase();
    return own.includes(filterQuery) || field.fields.some(matchesFilter);
  }

  /**
   * Orders and filters the fields of one object. In a large form the required fields come first,
   * in schema order, then the optional ones; a Find a field query keeps only what matches.
   */
  function arrangeFields(fields: SchemaFormField[]): SchemaFormField[] {
    const ordered = orderFields(fields);
    return filterQuery === '' ? ordered : ordered.filter(matchesFilter);
  }

  function orderFields(fields: SchemaFormField[]): SchemaFormField[] {
    return largeForm
      ? [...fields.filter((field) => field.required), ...fields.filter((field) => !field.required)]
      : fields;
  }

  /** A group shows everything under it unless the query matches something inside it. */
  function groupChildren(group: SchemaFormField): SchemaFormField[] {
    return group.fields.some(matchesFilter)
      ? arrangeFields(group.fields)
      : orderFields(group.fields);
  }

  /** Required groups start open, optional ones closed; a query or an error opens a group. */
  function isGroupOpen(group: SchemaFormField): boolean {
    if (filterQuery !== '') return true;
    const chosen = ownEntry(groupOverrides, pathKey(group.path));
    if (chosen !== undefined) return chosen;
    return group.required || formState.errorWithin(group) !== undefined;
  }

  function setGroupOpen(group: SchemaFormField, open: boolean): void {
    groupOverrides = { ...groupOverrides, [pathKey(group.path)]: open };
  }

  /** Makes every field with an issue reachable, so focus has somewhere to land. */
  function revealIssues(issues: SchemaFormValidationIssue[]): void {
    filterText = '';
    const opened = { ...groupOverrides };
    for (const issue of issues) {
      for (let depth = 1; depth <= issue.path.length; depth += 1) {
        opened[pathKey(issue.path.slice(0, depth))] = true;
      }
    }
    groupOverrides = opened;
  }

  function toggleJsonPanel(): void {
    if (jsonPanelOpen) {
      jsonPanelOpen = false;
      return;
    }
    jsonText = JSON.stringify(formState.currentDraft() ?? null, null, 2);
    jsonError = undefined;
    jsonPanelOpen = true;
  }

  function applyJsonPanel(): void {
    const parsed = parseJsonDraft([], jsonText);
    if (!parsed.ok) {
      jsonError = parsed.issue.message;
      return;
    }
    if (model.field.kind === 'object' && !isRecord(parsed.value)) {
      jsonError = 'The input must be a JSON object.';
      return;
    }
    formState.replaceValue(initialValueForField(model.field, parsed.value));
    jsonError = undefined;
    jsonPanelOpen = false;
  }

  function blockEnterSubmit(event: KeyboardEvent): void {
    if (event.key === 'Enter') event.preventDefault();
  }

  async function reportSubmitIssues(issues: SchemaFormValidationIssue[], submitId: number) {
    if (activeSubmitId !== submitId) return;
    revealIssues(issues);
    formState.applyIssues(issues);
    submitting = false;
    await focusFirstError(submitId);
  }

  async function focusFirstError(submitId: number) {
    await tick();
    if (activeSubmitId !== submitId) return;
    if (formElement) focusFirstProblem(formElement);
  }

  function shouldResumeNativeSubmit(): boolean {
    return onSubmit === undefined && (rest.action !== undefined || rest.method !== undefined);
  }

  function nativeSubmitter(event: SubmitEvent): HTMLButtonElement | HTMLInputElement | undefined {
    const submitter = event.submitter;
    if (
      submitter instanceof HTMLButtonElement &&
      submitter.type === 'submit' &&
      submitter.form === formElement
    ) {
      return submitter;
    }
    if (
      submitter instanceof HTMLInputElement &&
      (submitter.type === 'submit' || submitter.type === 'image') &&
      submitter.form === formElement
    ) {
      return submitter;
    }
    return undefined;
  }

  async function handleSubmit(event: SubmitEvent) {
    if (allowNativeSubmit) {
      allowNativeSubmit = false;
      return;
    }

    event.preventDefault();
    if (submitting) return;

    const submitId = activeSubmitId + 1;
    activeSubmitId = submitId;
    submitting = true;
    try {
      const draft = formState.buildSubmitCandidate(isFieldRendered);
      if (!draft.ok) {
        await reportSubmitIssues(draft.issues, submitId);
        return;
      }

      const result = await validateSchemaValue(schema, draft.value);
      if (!result.valid) {
        await reportSubmitIssues(result.issues, submitId);
        return;
      }

      const serialized = serializeValidatedValue(result.value);
      if (!serialized.ok) {
        await reportSubmitIssues([serialized.issue], submitId);
        return;
      }

      formState.commit(result.value, serialized.value);
      try {
        await onSubmit?.(result.value as SchemaFormOutput, event);
      } finally {
        // Once the host has the value, the hidden output field must not keep a secret in the
        // document, whether the host took it or refused it. A native submit still needs it.
        if (!shouldResumeNativeSubmit() && schemaHoldsConcealedField(schema)) {
          formState.clearSerializedValue();
        }
      }

      if (shouldResumeNativeSubmit()) {
        allowNativeSubmit = true;
        await tick();
        (formElement as HTMLFormElement | undefined)?.requestSubmit(nativeSubmitter(event));
      }
    } finally {
      if (activeSubmitId === submitId) submitting = false;
    }
  }
</script>

{#snippet groupLegend(field: SchemaFormField, showError = true)}
  <legend class="cinder-schema-form__legend">
    {textOf(field)}
    {#if field.required}
      <span class="cinder-_required-marker" aria-hidden="true"></span>
    {/if}
  </legend>
  {#if field.description}
    <p id="{fieldDomId(field)}-description" class="cinder-schema-form__description">
      {field.description}
    </p>
  {/if}
  {#if showError && fieldError(field)}
    <p
      id="{fieldDomId(field)}-error"
      class="cinder-schema-form__error"
      aria-live="polite"
      tabindex="-1"
    >
      {fieldError(field)}
    </p>
  {/if}
{/snippet}

{#snippet arrayBody(field: SchemaFormField)}
  <div
    class="cinder-schema-form__array"
    data-cinder-empty={formState.arrayRows(field).length === 0 || undefined}
  >
    {#each formState.arrayRows(field) as row (row.key)}
      {@const itemField = field.item
        ? rebaseFieldPath(field.item, [...field.path, String(row.index)])
        : undefined}
      <div class="cinder-schema-form__array-item">
        {#if itemField}
          {@render renderField(itemField)}
        {/if}
        <button
          type="button"
          class="cinder-schema-form__secondary-button"
          aria-label={`Remove ${textOf(field)} item ${row.index + 1}`}
          disabled={frozen}
          onclick={() => formState.removeArrayItem(field, row.index)}
        >
          Remove
        </button>
      </div>
    {/each}
  </div>
  <button
    type="button"
    class="cinder-schema-form__secondary-button"
    disabled={frozen}
    onclick={() => formState.addArrayItem(field)}
  >
    Add {textOf(field)}
  </button>
{/snippet}

<!-- The control of a setting row, which sits at the inline end. Its label, description and error
     belong to the row, so the control takes none of its own. -->
{#snippet settingControl(field: SchemaFormField, id: string)}
  {#if field.kind === 'string'}
    <Input
      {id}
      label={rowLabel(field)}
      variant="code"
      type={field.schema['writeOnly'] === true ? 'password' : 'text'}
      autocomplete={field.schema['writeOnly'] === true ? 'off' : undefined}
      required={field.required}
      disabled={frozen}
      onblur={() => formState.validateTouchedField(field)}
      bind:value={
        () => stringValue(field),
        (next) =>
          formState.updateValue(
            field.path,
            next === '' && isTemporalStringSchema(field.schema) ? blankMomentValue(field) : next,
          )
      }
    />
  {:else if field.kind === 'enum'}
    <Select
      {id}
      label={rowLabel(field)}
      labelVisible={false}
      required={field.required}
      disabled={frozen}
      options={selectOptions(field)}
      value={enumValue(field)}
      onchange={(event) => formState.updateEnum(field, event)}
      onblur={() => formState.validateTouchedField(field)}
    />
  {:else if field.kind === 'boolean'}
    <Toggle
      {id}
      label={rowLabel(field)}
      disabled={frozen}
      bind:checked={() => booleanValue(field), (next) => formState.updateValue(field.path, next)}
    />
  {:else if (field.kind === 'number' || field.kind === 'integer') && field.unit}
    <DurationField
      {id}
      required={field.required}
      disabled={frozen}
      integer={field.kind === 'integer'}
      value={numberFieldValue(field)}
      onValueChange={(next) => formState.updateNumberValue(field, next)}
      onblur={() => formState.validateTouchedField(field)}
    />
  {:else if field.kind === 'number' || field.kind === 'integer'}
    <NumberInput
      {id}
      required={field.required}
      disabled={frozen}
      step={field.kind === 'integer' ? 1 : undefined}
      onblur={() => formState.validateTouchedField(field)}
      value={numberFieldValue(field)}
      onValueChange={(next) => formState.updateNumberValue(field, next)}
    />
  {/if}
{/snippet}

<!-- What a setting row cannot carry at the inline end, drawn full width under the row's label and
     description with no box of its own. -->
{#snippet settingDisclosure(field: SchemaFormField, id: string, error: string | undefined)}
  {#if field.kind === 'object'}
    {@render renderFields(field.fields)}
  {:else if field.kind === 'array'}
    <div class="cinder-schema-form__setting-body">{@render arrayBody(field)}</div>
  {:else if field.kind === 'tags'}
    <TagInput
      aria-label={rowLabel(field)}
      value={stringArrayValue(field)}
      placeholder="Add a value"
      duplicateValuesAllowed={field.schema['uniqueItems'] !== true}
      commitOnSubmit
      disabled={frozen}
      onValueChange={(next) => formState.updateValue(field.path, next)}
      onblur={() => formState.validateTouchedField(field)}
    />
  {:else if field.kind === 'enumArray'}
    <div role="group" aria-label={rowLabel(field)}>
      <SchemaFormChips
        options={field.options}
        selected={arrayOptionValues(field)}
        disabled={frozen}
        onValueChange={(next) => formState.updateValue(field.path, next)}
      />
    </div>
  {:else if field.kind === 'record'}
    <fieldset class="cinder-schema-form__bare-fieldset" disabled={frozen}>
      <SchemaFormRecord
        label={textOf(field)}
        entries={formState.recordEntries(field)}
        onValueChange={(next) => formState.updateRecordEntries(field, next)}
      />
    </fieldset>
  {:else if field.kind === 'choice'}
    {@render renderField(field)}
  {:else if field.kind === 'json'}
    <JsonEditor
      {id}
      label={`${rowLabel(field)} as JSON`}
      rows={5}
      validFeedbackVisible={false}
      required={field.required}
      disabled={frozen}
      {...error === undefined ? {} : { error }}
      onblur={() => formState.validateTouchedField(field)}
      value={rawJsonValue(field)}
      onValueChange={(next) => formState.updateRawJsonValue(field, next)}
    />
  {/if}
{/snippet}

{#snippet settingRow(field: SchemaFormField)}
  {@const id = fieldDomId(field)}
  {@const error = fieldError(field)}
  {@const inline = INLINE_KINDS.has(field.kind)}
  {@const identifier = rowIdentifier(field)}
  <div
    class="cinder-schema-form__setting"
    data-cinder-field={field.key}
    oninput={inline || field.kind === 'tags'
      ? (event) => formState.handleFieldInput(field, event)
      : undefined}
  >
    <SettingRow
      {id}
      label={rowLabel(field)}
      {...identifier === undefined ? {} : { identifier }}
      required={field.required}
      disabled={frozen}
      controlWidth={field.kind === 'boolean' ? 'auto' : '16rem'}
      controlAlign={field.kind === 'boolean' ? 'end' : 'stretch'}
      {...field.description === undefined ? {} : { description: field.description }}
      {...error === undefined ? {} : { error }}
    >
      {#snippet control()}
        {#if inline}{@render settingControl(field, id)}{/if}
      {/snippet}
      {#snippet disclosure()}
        {#if !inline}{@render settingDisclosure(field, id, error)}{/if}
      {/snippet}
    </SettingRow>
  </div>
{/snippet}

{#snippet renderFields(fields: SchemaFormField[])}
  <div class="cinder-schema-form__fields" data-cinder-columns={paired ? 'two' : undefined}>
    {#each fields as child (pathKey(child.path))}
      {@render renderField(child)}
    {/each}
  </div>
{/snippet}

{#snippet renderField(field: SchemaFormField)}
  {@const id = fieldDomId(field)}
  {@const error = fieldError(field)}
  {@const span = spanOf(field)}
  {@const labelledProps = {
    label: textOf(field),
    // `description`/`error` are optional `string` props (no `| undefined`), and
    // exactOptionalPropertyTypes rejects passing an explicit `undefined`. Spread
    // them only when present so the control sees the prop omitted, not undefined.
    ...(field.description !== undefined ? { description: field.description } : {}),
    ...(error !== undefined ? { error } : {}),
  }}

  {#if field.kind === 'object' && largeForm && !hosted}
    <Collapsible
      idBase={id}
      class="cinder-schema-form__group"
      data-cinder-span={span}
      animated={false}
      bind:open={() => isGroupOpen(field), (next) => setGroupOpen(field, next)}
    >
      {#snippet trigger({ open })}
        <span class="cinder-schema-form__group-label">
          {field.label}
          {#if field.required}
            <span class="cinder-_required-marker" aria-hidden="true"></span>
          {/if}
        </span>
        {#if !open}
          <span class="cinder-schema-form__summary">
            {summarizeGroup(field, formState.formValue)}
          </span>
        {/if}
      {/snippet}
      {#if field.description}
        <p id="{id}-description" class="cinder-schema-form__description">{field.description}</p>
      {/if}
      {#if error}
        <p id="{id}-error" class="cinder-schema-form__error" aria-live="polite" tabindex="-1">
          {error}
        </p>
      {/if}
      {@render renderFields(groupChildren(field))}
    </Collapsible>
  {:else if field.kind === 'object'}
    <fieldset class="cinder-schema-form__fieldset">
      {@render groupLegend(field)}
      {@render renderFields(field.fields)}
    </fieldset>
  {:else if field.kind === 'choice'}
    {@const active = choiceBranchForValue(field, getValueAtPath(formState.formValue, field.path))}
    {@const [literalBranch, objectBranch] = field.fields}
    {@const activeIsObject = active === objectBranch}
    {@const literalHasControl = !activeIsObject && active.options.length !== 1}
    <fieldset class="cinder-schema-form__fieldset" data-cinder-span={span}>
      {@render groupLegend(field, !literalHasControl)}
      <SegmentedControl
        id="{id}-choice"
        label={textOf(field)}
        labelVisible={false}
        value={activeIsObject ? 'object' : 'literal'}
        onValueChange={(next) =>
          formState.selectChoiceBranch(field, next === 'object' ? objectBranch! : literalBranch!)}
        disabled={frozen}
      >
        <Segment value="literal">{literalBranch?.label}</Segment>
        <Segment value="object">{objectBranch?.label}</Segment>
      </SegmentedControl>
      {#if activeIsObject}
        {@render renderFields(active.fields)}
      {:else if literalHasControl}
        {@render renderField(active)}
      {/if}
    </fieldset>
  {:else if field.kind === 'enumArray'}
    <fieldset class="cinder-schema-form__fieldset" data-cinder-span={span}>
      {@render groupLegend(field)}
      <SchemaFormChips
        options={field.options}
        selected={arrayOptionValues(field)}
        disabled={frozen}
        onValueChange={(next) => formState.updateValue(field.path, next)}
      />
    </fieldset>
  {:else if field.kind === 'record'}
    <fieldset class="cinder-schema-form__fieldset" data-cinder-span={span} disabled={frozen}>
      {@render groupLegend(field)}
      <SchemaFormRecord
        label={textOf(field)}
        entries={formState.recordEntries(field)}
        onValueChange={(next) => formState.updateRecordEntries(field, next)}
      />
    </fieldset>
  {:else if field.kind === 'array'}
    <fieldset class="cinder-schema-form__fieldset" data-cinder-span={span}>
      {@render groupLegend(field)}
      {@render arrayBody(field)}
    </fieldset>
  {:else}
    <div
      class="cinder-schema-form__field"
      data-cinder-span={span}
      oninput={(event) => formState.handleFieldInput(field, event)}
    >
      {#if field.kind === 'string'}
        <Input
          {id}
          {...labelledProps}
          type={field.schema['writeOnly'] === true ? 'password' : 'text'}
          autocomplete={field.schema['writeOnly'] === true ? 'off' : undefined}
          required={field.required}
          disabled={frozen}
          onblur={() => formState.validateTouchedField(field)}
          bind:value={
            () => stringValue(field),
            (next) =>
              formState.updateValue(
                field.path,
                next === '' && isTemporalStringSchema(field.schema)
                  ? blankMomentValue(field)
                  : next,
              )
          }
        />
      {:else if field.kind === 'tags'}
        <SchemaFormTags
          {id}
          label={textOf(field)}
          description={field.description}
          {error}
          required={field.required}
          disabled={frozen}
          value={stringArrayValue(field)}
          draft={formState.tagDraft(field)}
          duplicateValuesAllowed={field.schema['uniqueItems'] !== true}
          onValueChange={(next) => formState.updateValue(field.path, next)}
          onblur={() => formState.validateTouchedField(field)}
        />
      {:else if (field.kind === 'number' || field.kind === 'integer') && field.unit}
        <DurationField
          {id}
          label={textOf(field)}
          description={field.description}
          {error}
          required={field.required}
          disabled={frozen}
          integer={field.kind === 'integer'}
          value={numberValue(field)}
          onValueChange={(next) => formState.updateNumberValue(field, next)}
          onblur={() => formState.validateTouchedField(field)}
        />
      {:else if field.kind === 'number' || field.kind === 'integer'}
        <NumberInput
          {id}
          {...labelledProps}
          required={field.required}
          disabled={frozen}
          step={field.kind === 'integer' ? 1 : undefined}
          onblur={() => formState.validateTouchedField(field)}
          value={numberFieldValue(field)}
          onValueChange={(next) => formState.updateNumberValue(field, next)}
        />
      {:else if field.kind === 'enum'}
        <Select
          {id}
          {...labelledProps}
          required={field.required}
          disabled={frozen}
          options={selectOptions(field)}
          value={enumValue(field)}
          onchange={(event) => formState.updateEnum(field, event)}
          onblur={() => formState.validateTouchedField(field)}
        />
      {:else if field.kind === 'boolean'}
        <!-- A required boolean schema property means "the value must be present",
             not "the box must be checked". Native checkbox `required` would block
             a valid `false` submission, so it is intentionally NOT forwarded here;
             presence is enforced by the schema validator on submit. -->
        {#if variant === 'input'}
          <Toggle
            {id}
            label={textOf(field)}
            {...field.description !== undefined ? { description: field.description } : {}}
            descriptionPlacement="below"
            disabled={frozen}
            bind:checked={
              () => booleanValue(field), (next) => formState.updateValue(field.path, next)
            }
          />
        {:else}
          <Checkbox
            {id}
            {...labelledProps}
            disabled={frozen}
            bind:checked={
              () => booleanValue(field), (next) => formState.updateValue(field.path, next)
            }
          />
        {/if}
      {:else if variant === 'input'}
        <JsonEditor
          {id}
          {...labelledProps}
          required={field.required}
          disabled={frozen}
          statusLabel={jsonStatusLabel(field)}
          onblur={() => formState.validateTouchedField(field)}
          value={rawJsonValue(field)}
          onValueChange={(next) => formState.updateRawJsonValue(field, next)}
        />
      {:else}
        <Textarea
          {id}
          {...labelledProps}
          required={field.required}
          disabled={frozen}
          rows={6}
          spellcheck={false}
          variant="code"
          class="cinder-schema-form__json-control"
          onblur={() => formState.validateTouchedField(field)}
          bind:value={
            () => rawJsonValue(field), (next) => formState.updateRawJsonValue(field, next)
          }
        />
      {/if}
    </div>
  {/if}
{/snippet}

<svelte:element
  this={hosted ? 'div' : 'form'}
  {...rest}
  id={formId}
  bind:this={formElement}
  class={classNames('cinder-schema-form', customClassName)}
  data-cinder-hosted={hosted ? '' : undefined}
  data-cinder-variant={settingRows ? 'setting-rows' : undefined}
  role={hosted ? 'group' : undefined}
  novalidate={hosted ? undefined : (novalidate ?? true)}
  onsubmit={hosted ? undefined : handleSubmit}
>
  {#if rootError}
    <p
      id={rootErrorId}
      class="cinder-schema-form__error"
      role="alert"
      aria-live="polite"
      tabindex="-1"
    >
      {rootError}
    </p>
  {/if}

  {#if largeForm}
    <div class="cinder-schema-form__toolbar">
      <Input
        id="{formId}-find"
        type="search"
        label="Find a field"
        autocomplete="off"
        bind:value={filterText}
        onkeydown={blockEnterSubmit}
      />
      {#if jsonPanelAllowed}
        <button
          type="button"
          class="cinder-schema-form__secondary-button"
          aria-expanded={jsonPanelOpen}
          disabled={frozen}
          onclick={toggleJsonPanel}
        >
          Edit as JSON
        </button>
      {/if}
    </div>
    {#if jsonPanelAllowed && jsonPanelOpen}
      <SchemaFormJsonPanel
        id="{formId}-json"
        text={jsonText}
        error={jsonError}
        disabled={frozen}
        onTextChange={(next) => (jsonText = next)}
        onApply={applyJsonPanel}
        onCancel={() => (jsonPanelOpen = false)}
      />
    {/if}
  {/if}

  {#if filterQuery !== '' && rootFields.length === 0}
    <p class="cinder-schema-form__description" role="status">No fields match your search.</p>
  {/if}

  {#if settingRows && model.field.kind === 'object'}
    <div class="cinder-schema-form__setting-rows">
      {#each rootFields as field (pathKey(field.path))}
        {@render settingRow(field)}
      {/each}
    </div>
  {:else}
    {@render renderFields(rootFields)}
  {/if}

  {#if !hosted}
    <input
      bind:this={serializedInputElement}
      type="hidden"
      {name}
      value={formState.serializedValue}
    />
  {/if}

  {#if submitVisible && !hosted}
    <Button
      type="submit"
      variant="primary"
      class="cinder-schema-form__submit"
      disabled={frozen}
      label={submitting ? 'Validating...' : submitLabel}
    />
  {/if}
</svelte:element>
