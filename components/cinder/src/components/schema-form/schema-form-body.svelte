<!--
  Internal component: owns all mutable form state so that the outer
  {#key schema} block in schema-form.svelte causes genuine $state recreation
  when the schema prop changes.

  This component is NOT part of the public API. Import SchemaForm instead.
-->
<script lang="ts">
  import { tick, untrack, type Snippet } from 'svelte';

  import { classNames } from '../../utilities/class-names.ts';
  import { ownEntry } from '../../_internal/own-entry.ts';
  import Button from '../button/button.svelte';
  import Checkbox from '../checkbox/checkbox.svelte';
  import Collapsible from '../collapsible/collapsible.svelte';
  import Input from '../input/input.svelte';
  import JsonEditor from '../json-editor/json-editor.svelte';
  import NumberInput from '../number-input/number-input.svelte';
  import Segment from '../segment/segment.svelte';
  import SchemaFormNamedControl from './schema-form-named-control.svelte';
  import SettingRow from '../setting-row/setting-row.svelte';
  import TagInput from '../tag-input/tag-input.svelte';
  import SegmentedControl from '../segmented-control/segmented-control.svelte';
  import Select from '../select/select.svelte';
  import Toggle from '../toggle/toggle.svelte';

  import {
    choiceBranchForValue,
    countLeafFields,
    createSchemaFormModel,
    DURATION_NAME_SUFFIX,
    emptyTextValue,
    fieldAtPathExists,
    getValueAtPath,
    initialValueForField,
    modelOptionsForVariant,
    schemaHoldsConcealedField,
    sentenceCaseLabel,
    valueWhenSet,
    isRecord,
    pathId,
    pathKey,
    rebaseFieldPath,
    secretKeyOf,
    type SchemaFormField,
  } from './schema-form-model.ts';
  import SchemaFormChips from './schema-form-chips.svelte';
  import SchemaFormReadOnly from './schema-form-read-only.svelte';
  import SchemaFormSecret from './schema-form-secret.svelte';
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
    'secret',
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
    rootChoiceVisible = true,
    rootRowHosted = false,
    onRootControl,
    disabled = false,
    hosted = false,
    secrets,
    readOnly = false,
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
    !settingRows && !readOnly && countLeafFields(model.field) > LARGE_FORM_FIELD_THRESHOLD,
  );
  /** A form that is not a `<form>`: one drawn inside another surface, and one that cannot be changed. */
  const bare = $derived(hosted || readOnly);
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

  /** Whether a control must hold something: a required field does, unless `null` is a value it may hold. */
  function mustHaveText(field: SchemaFormField): boolean {
    return field.required && !field.nullable;
  }

  function stringValue(field: SchemaFormField): string {
    const current = getValueAtPath(formState.formValue, field.path);
    return current === undefined || current === null ? '' : String(current);
  }

  /** The first string example is a hint, never a draft value or a substitute for required input. */
  function placeholderFor(field: SchemaFormField): string | undefined {
    const examples = field.schema['examples'];
    if (!Array.isArray(examples)) return undefined;
    const first = examples.find((example): example is string => typeof example === 'string');
    return first === undefined || first.trim() === '' ? undefined : first;
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

  /**
   * The one field a group holds when that field is a short single control (text, number, select,
   * duration or switch): the group then draws as one row with the field's control in the control
   * column. Any other group, or a group of several fields, is drawn under its row as before.
   */
  function loneField(group: SchemaFormField): SchemaFormField | undefined {
    if (group.kind !== 'object' || group.nullable || group.fields.length !== 1) return undefined;
    const [only] = group.fields;
    return only !== undefined && (INLINE_KINDS.has(only.kind) || isChoiceLike(only))
      ? only
      : undefined;
  }

  /** Whether a field has one control a row's control column can carry: a short control, or a choice. */
  function carriesControl(field: SchemaFormField): boolean {
    if (INLINE_KINDS.has(field.kind)) return true;
    if (!isChoiceLike(field)) return false;
    // The host draws a root union's choice itself when `rootChoiceVisible` is off.
    return field.kind !== 'choice' || rootChoiceVisible || field.path.length > 0;
  }

  /** Whether the root's row is the host's: the form draws that row's control and body, and no row. */
  const rootHosted = $derived(settingRows && rootRowHosted && !readOnly);

  /** What a hosted root row carries: a group's lone field, else the root itself. */
  const rootCarried = $derived(loneField(model.field) ?? model.field);

  /** Whether a hosted root draws nothing where the form is mounted: its one control is all it has. */
  const rootBodiless = $derived.by(() => {
    if (!rootHosted || rootError !== undefined) return false;
    const carried = rootCarried;
    if (carried !== model.field && fieldError(carried) !== undefined) return false;
    if (INLINE_KINDS.has(carried.kind)) return true;
    if (carried.kind === 'choice') return !choiceAddsFields(carried);
    return isChoiceLike(carried) && holdsNull(carried);
  });

  /** Whether the chosen alternative of a union draws anything under the choice. */
  function choiceAddsFields(field: SchemaFormField): boolean {
    const active = choiceBranchForValue(field, getValueAtPath(formState.formValue, field.path));
    return active === field.fields[1] || active.options.length !== 1;
  }

  /** The root's own control for a host that draws the root's row. The model is fixed at mount. */
  function hostedRootControl(): Snippet | undefined {
    if (variant !== 'setting-rows' || !rootRowHosted || readOnly) return undefined;
    const carried = loneField(initialModel.field) ?? initialModel.field;
    return carriesControl(carried) ? rootControl : undefined;
  }

  function announceRootControl(): void {
    if (variant === 'setting-rows' && rootRowHosted) onRootControl?.(hostedRootControl());
  }
  announceRootControl();

  /** What a setting row calls a field: the schema's title, else its key in sentence case. */
  function rowLabel(field: SchemaFormField): string {
    const title = field.schema['title'];
    if (typeof title === 'string' && title.trim().length > 0) return title;
    // A duration's unit is in its control, so its name does not carry it: "Timeout", not "Timeout ms".
    const named = field.unit ? field.key.replace(DURATION_NAME_SUFFIX, '') : field.key;
    return sentenceCaseLabel(named === '' ? field.key : named);
  }

  /** The words a field is named with: sentence case in the `setting-rows` variant, the model's label otherwise. */
  function textOf(field: SchemaFormField): string {
    return settingRows ? rowLabel(field) : field.label;
  }

  /** A row shows its key only beside a schema title that differs from the existing sentence-case key label. */
  function rowIdentifier(field: SchemaFormField): string | undefined {
    const title = field.schema['title'];
    if (typeof title !== 'string' || title.trim().length === 0) return undefined;
    return title.trim().toLowerCase() === sentenceCaseLabel(field.key).toLowerCase()
      ? undefined
      : field.key;
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

  /** Whether a field holds `null`, which is a value of its own and not a missing property. */
  function holdsNull(field: SchemaFormField): boolean {
    return getValueAtPath(formState.formValue, field.path) === null;
  }

  /**
   * Whether a field is drawn as a choice between alternatives (a union, or an object that may be
   * `null`) with the chosen one's fields below, its control at the inline end of the title.
   */
  function isChoiceLike(field: SchemaFormField): boolean {
    return field.kind === 'choice' || (field.kind === 'object' && field.nullable === true);
  }

  /** Whether a choice is on a literal that has a control of its own, which then shows the field's error. */
  function literalControlShown(field: SchemaFormField): boolean {
    if (field.kind !== 'choice') return false;
    const active = choiceBranchForValue(field, getValueAtPath(formState.formValue, field.path));
    return active !== field.fields[1] && active.options.length !== 1;
  }

  /**
   * What an empty control says when `null` is a value it holds, so a cleared field is told apart
   * from one nobody touched: always "Not set", in a number and in a list alike. It is never the
   * field's description, which a row prints beside the control and a narrow control would clip.
   */
  function nullHint(field: SchemaFormField): string | undefined {
    return field.nullable ? 'Not set' : undefined;
  }

  function triState(field: SchemaFormField): 'unset' | 'yes' | 'no' {
    const current = getValueAtPath(formState.formValue, field.path);
    return current === true ? 'yes' : current === false ? 'no' : 'unset';
  }

  function setTriState(field: SchemaFormField, next: string): void {
    formState.updateValue(field.path, next === 'yes' ? true : next === 'no' ? false : null);
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
{#snippet secretControl(
  field: SchemaFormField,
  id: string,
  label: string,
  description?: string,
  labelVisible = true,
)}
  <SchemaFormSecret
    {id}
    {label}
    {labelVisible}
    {description}
    error={fieldError(field)}
    required={mustHaveText(field)}
    disabled={frozen}
    value={secretKeyOf(getValueAtPath(formState.formValue, field.path))}
    {secrets}
    onValueChange={(key) =>
      formState.updateValue(field.path, key === undefined ? undefined : { $secret: key })}
    onblur={() => formState.validateTouchedField(field)}
  />
{/snippet}

<!-- A yes or no that may also be unset: three segments, the first being the `null`. -->
{#snippet triStateControl(
  field: SchemaFormField,
  id: string,
  label: string,
  labelVisible: boolean,
  description?: string,
  error?: string,
)}
  <SegmentedControl
    {id}
    {label}
    {labelVisible}
    {...description === undefined ? {} : { description }}
    {...error === undefined ? {} : { error }}
    value={triState(field)}
    onValueChange={(next) => setTriState(field, next)}
    disabled={frozen}
  >
    <Segment value="unset">Not set</Segment>
    <Segment value="yes">Yes</Segment>
    <Segment value="no">No</Segment>
  </SegmentedControl>
{/snippet}

<!-- The control that chooses between the alternatives of a union, or sets an object that may be
     `null`. It sits at the inline end, beside the field's title or a row's own. -->
{#snippet choiceControl(field: SchemaFormField)}
  {#if field.kind === 'choice'}
    {@const active = choiceBranchForValue(field, getValueAtPath(formState.formValue, field.path))}
    {@const [literalBranch, objectBranch] = field.fields}
    {#if rootChoiceVisible || field.path.length > 0}
      <SegmentedControl
        id="{fieldDomId(field)}-choice"
        label={textOf(field)}
        labelVisible={false}
        value={active === objectBranch ? 'object' : 'literal'}
        onValueChange={(next) =>
          formState.selectChoiceBranch(field, next === 'object' ? objectBranch! : literalBranch!)}
        disabled={frozen}
      >
        <Segment value="literal">{literalBranch?.label}</Segment>
        <Segment value="object">{objectBranch?.label}</Segment>
      </SegmentedControl>
    {/if}
  {:else}
    <SegmentedControl
      id="{fieldDomId(field)}-choice"
      label={textOf(field)}
      labelVisible={false}
      value={holdsNull(field) ? 'unset' : 'set'}
      onValueChange={(next) =>
        formState.setNullable(field, next === 'set' ? valueWhenSet(field) : null)}
      disabled={frozen}
    >
      <Segment value="unset">Not set</Segment>
      <Segment value="set">Set</Segment>
    </SegmentedControl>
  {/if}
{/snippet}

<!-- What the chosen alternative adds under the choice: its fields, or a literal's own control. -->
{#snippet choiceBody(field: SchemaFormField)}
  {#if field.kind === 'choice'}
    {@const active = choiceBranchForValue(field, getValueAtPath(formState.formValue, field.path))}
    {@const [, objectBranch] = field.fields}
    {#if active === objectBranch}
      <div class="cinder-schema-form__choice-body">{@render renderFields(active.fields)}</div>
    {:else if active.options.length !== 1}
      <div class="cinder-schema-form__choice-body">{@render renderField(active)}</div>
    {/if}
  {:else if !holdsNull(field)}
    <div class="cinder-schema-form__choice-body">{@render renderFields(field.fields)}</div>
  {/if}
{/snippet}

<!-- A list that may be `null` says so while it is, and offers one action that returns it there. -->
{#snippet nullableClear(field: SchemaFormField)}
  <!-- A tag input says "Not set" in its own empty input, as an empty number does, so it adds no
       line. Chips and item rows have no input to say it, so they do. -->
  {#if field.nullable && !(field.kind === 'tags' && holdsNull(field))}
    <div class="cinder-schema-form__unset">
      {#if holdsNull(field)}
        <span>Not set</span>
      {:else}
        <button
          type="button"
          class="cinder-schema-form__secondary-button"
          aria-label={`Clear ${textOf(field)}`}
          disabled={frozen}
          onclick={() => formState.setNullable(field, null)}
        >
          Clear
        </button>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet settingControl(field: SchemaFormField, id: string)}
  {#if field.kind === 'secret'}
    {@render secretControl(field, id, rowLabel(field), undefined, false)}
  {:else if field.kind === 'string'}
    <Input
      {id}
      label={rowLabel(field)}
      variant="code"
      type={field.schema['writeOnly'] === true ? 'password' : 'text'}
      autocomplete={field.schema['writeOnly'] === true ? 'off' : undefined}
      required={mustHaveText(field)}
      disabled={frozen}
      onblur={() => formState.validateTouchedField(field)}
      bind:value={
        () => stringValue(field),
        (next) => formState.updateValue(field.path, next === '' ? emptyTextValue(field) : next)
      }
    />
  {:else if field.kind === 'enum'}
    <Select
      {id}
      label={rowLabel(field)}
      labelVisible={false}
      required={mustHaveText(field)}
      disabled={frozen}
      options={selectOptions(field)}
      value={enumValue(field)}
      onchange={(event) => formState.updateEnum(field, event)}
      onblur={() => formState.validateTouchedField(field)}
    />
  {:else if field.kind === 'boolean' && field.nullable}
    {@render triStateControl(field, id, rowLabel(field), false)}
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
      required={mustHaveText(field)}
      disabled={frozen}
      integer={field.kind === 'integer'}
      placeholder={nullHint(field)}
      value={numberFieldValue(field)}
      onValueChange={(next) => formState.updateNumberValue(field, next)}
      onblur={() => formState.validateTouchedField(field)}
    />
  {:else if field.kind === 'number' || field.kind === 'integer'}
    <NumberInput
      {id}
      required={mustHaveText(field)}
      disabled={frozen}
      placeholder={nullHint(field)}
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
    <div class="cinder-schema-form__setting-body">
      {@render arrayBody(field)}
      {@render nullableClear(field)}
    </div>
  {:else if field.kind === 'tags'}
    <TagInput
      aria-label={rowLabel(field)}
      value={stringArrayValue(field)}
      placeholder={field.nullable && holdsNull(field) ? 'Not set' : 'Add a value'}
      duplicateValuesAllowed={field.schema['uniqueItems'] !== true}
      commitOnSubmit
      disabled={frozen}
      onValueChange={(next) => formState.updateValue(field.path, next)}
      onblur={() => formState.validateTouchedField(field)}
    />
    {@render nullableClear(field)}
  {:else if field.kind === 'enumArray'}
    <div role="group" aria-label={rowLabel(field)}>
      <SchemaFormChips
        options={field.options}
        selected={arrayOptionValues(field)}
        disabled={frozen}
        onValueChange={(next) => formState.updateValue(field.path, next)}
      />
    </div>
    {@render nullableClear(field)}
  {:else if field.kind === 'record'}
    <fieldset class="cinder-schema-form__bare-fieldset" disabled={frozen}>
      <SchemaFormRecord
        label={textOf(field)}
        entries={formState.recordEntries(field)}
        onValueChange={(next) => formState.updateRecordEntries(field, next)}
      />
    </fieldset>
  {:else if field.kind === 'json'}
    <JsonEditor
      {id}
      label={`${rowLabel(field)} as JSON`}
      rows={5}
      validFeedbackVisible={false}
      required={mustHaveText(field)}
      disabled={frozen}
      {...error === undefined ? {} : { error }}
      onblur={() => formState.validateTouchedField(field)}
      value={rawJsonValue(field)}
      onValueChange={(next) => formState.updateRawJsonValue(field, next)}
    />
  {/if}
{/snippet}

{#snippet settingRow(field: SchemaFormField)}
  {@const lone = loneField(field)}
  {@const carried = lone ?? field}
  {@const id = fieldDomId(carried)}
  {@const rowId = lone ? `${id}-group` : id}
  {@const error = fieldError(carried)}
  {@const inline = INLINE_KINDS.has(carried.kind)}
  {@const choiceLike = isChoiceLike(carried)}
  {@const identifier = rowIdentifier(field)}
  {@const description = field.description ?? lone?.description}
  <div
    class="cinder-schema-form__setting"
    data-cinder-field={field.key}
    role={lone ? 'group' : undefined}
    aria-labelledby={lone ? `${rowId}-label` : undefined}
    oninput={inline || carried.kind === 'tags'
      ? (event) => formState.handleFieldInput(carried, event)
      : undefined}
  >
    <SettingRow
      id={rowId}
      label={rowLabel(field)}
      {...identifier === undefined ? {} : { identifier }}
      required={carried.required}
      disabled={frozen}
      controlWidth={(carried.kind === 'boolean' && !carried.nullable) || choiceLike
        ? 'auto'
        : '16rem'}
      controlAlign={(carried.kind === 'boolean' && !carried.nullable) || choiceLike
        ? 'end'
        : 'stretch'}
      {...description === undefined ? {} : { description }}
      {...error === undefined ? {} : { error }}
    >
      {#snippet control()}
        {#if choiceLike}
          {@render choiceControl(carried)}
        {:else if lone}
          <SchemaFormNamedControl
            {id}
            label={rowLabel(lone)}
            named={lone.kind !== 'enum' && lone.kind !== 'secret'}
          >
            {@render settingControl(lone, id)}
          </SchemaFormNamedControl>
        {:else if inline}
          {@render settingControl(field, id)}
        {/if}
      {/snippet}
      {#snippet disclosure()}
        {#if choiceLike}
          {@render choiceBody(carried)}
        {:else if !inline}
          {@render settingDisclosure(field, id, error)}
        {/if}
      {/snippet}
    </SettingRow>
  </div>
{/snippet}

<!-- The one control of a root whose row is the host's (`rootRowHosted`). The host draws it in its
     row's control column, and its row names it, so the control is named for assistive technology
     only, as a group's lone field is in a row of the form's own. -->
{#snippet rootControl()}
  {@const carried = rootCarried}
  {@const id = fieldDomId(carried)}
  <div
    class="cinder-schema-form__root-control"
    oninput={INLINE_KINDS.has(carried.kind)
      ? (event) => formState.handleFieldInput(carried, event)
      : undefined}
  >
    {#if isChoiceLike(carried)}
      {@render choiceControl(carried)}
    {:else}
      <SchemaFormNamedControl
        {id}
        label={rowLabel(carried)}
        named={carried.kind !== 'enum' && carried.kind !== 'secret'}
      >
        {@render settingControl(carried, id)}
      </SchemaFormNamedControl>
    {/if}
  </div>
{/snippet}

<!-- What a hosted root draws where the form is mounted, under the host row's text: the fields of a
     group with several, the fields a chosen alternative adds, and a lone field's own message. -->
{#snippet rootBody()}
  {@const carried = rootCarried}
  {@const id = fieldDomId(carried)}
  {@const error =
    carried === model.field && carried.kind === 'object' ? undefined : fieldError(carried)}
  {#if error && !literalControlShown(carried)}
    <p id="{id}-error" class="cinder-schema-form__error" aria-live="polite" tabindex="-1">
      {error}
    </p>
  {/if}
  {#if isChoiceLike(carried)}
    {@render choiceBody(carried)}
  {:else if carried.kind === 'object'}
    {@render renderFields(rootFields)}
  {:else if !INLINE_KINDS.has(carried.kind)}
    {@render settingDisclosure(carried, id, error)}
  {/if}
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

  {#if isChoiceLike(field)}
    <!-- Flat, in the page's own rhythm: the title and its control share one line (the control at the
         inline end), and what the chosen alternative adds sits below with no box around it. A
         root choice has no title of its own, because a page or a row already names it. -->
    <div
      class="cinder-schema-form__choice"
      role="group"
      aria-label={textOf(field)}
      data-cinder-span={span}
      data-cinder-root-choice={field.path.length === 0 ? '' : undefined}
    >
      <!-- A root choice whose own control is not drawn has nothing in its header, and an empty
           header would still take the choice's gap above what the chosen alternative adds. -->
      {#if field.kind !== 'choice' || field.path.length > 0 || rootChoiceVisible}
        <div class="cinder-schema-form__choice-header">
          {#if field.path.length > 0}
            <span class="cinder-schema-form__legend">
              {textOf(field)}
              {#if field.required}
                <span class="cinder-_required-marker" aria-hidden="true"></span>
              {/if}
            </span>
          {/if}
          <div class="cinder-schema-form__choice-control">{@render choiceControl(field)}</div>
        </div>
      {/if}
      {#if field.description}
        <p id="{id}-description" class="cinder-schema-form__description">{field.description}</p>
      {/if}
      {#if error && !literalControlShown(field)}
        <p id="{id}-error" class="cinder-schema-form__error" aria-live="polite" tabindex="-1">
          {error}
        </p>
      {/if}
      {@render choiceBody(field)}
    </div>
  {:else if field.kind === 'object' && largeForm && !hosted}
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
  {:else if field.kind === 'enumArray'}
    <fieldset class="cinder-schema-form__fieldset" data-cinder-span={span}>
      {@render groupLegend(field)}
      <SchemaFormChips
        options={field.options}
        selected={arrayOptionValues(field)}
        disabled={frozen}
        onValueChange={(next) => formState.updateValue(field.path, next)}
      />
      {@render nullableClear(field)}
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
      {@render nullableClear(field)}
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
          placeholder={placeholderFor(field)}
          {...hosted ? { size: 'sm' } : {}}
          type={field.schema['writeOnly'] === true ? 'password' : 'text'}
          autocomplete={field.schema['writeOnly'] === true ? 'off' : undefined}
          required={mustHaveText(field)}
          disabled={frozen}
          onblur={() => formState.validateTouchedField(field)}
          bind:value={
            () => stringValue(field),
            (next) => formState.updateValue(field.path, next === '' ? emptyTextValue(field) : next)
          }
        />
      {:else if field.kind === 'secret'}
        {@render secretControl(field, id, textOf(field), field.description)}
      {:else if field.kind === 'tags'}
        <SchemaFormTags
          {id}
          label={textOf(field)}
          description={field.description}
          {error}
          required={mustHaveText(field)}
          disabled={frozen}
          value={stringArrayValue(field)}
          draft={formState.tagDraft(field)}
          placeholder={field.nullable && holdsNull(field) ? 'Not set' : undefined}
          duplicateValuesAllowed={field.schema['uniqueItems'] !== true}
          onValueChange={(next) => formState.updateValue(field.path, next)}
          onblur={() => formState.validateTouchedField(field)}
        />
        {@render nullableClear(field)}
      {:else if (field.kind === 'number' || field.kind === 'integer') && field.unit}
        <DurationField
          {id}
          {...hosted ? { size: 'sm' } : {}}
          label={textOf(field)}
          description={field.description}
          {error}
          required={mustHaveText(field)}
          disabled={frozen}
          integer={field.kind === 'integer'}
          placeholder={nullHint(field)}
          value={numberValue(field)}
          onValueChange={(next) => formState.updateNumberValue(field, next)}
          onblur={() => formState.validateTouchedField(field)}
        />
      {:else if field.kind === 'number' || field.kind === 'integer'}
        <NumberInput
          {id}
          {...labelledProps}
          {...hosted ? { size: 'sm' } : {}}
          required={mustHaveText(field)}
          disabled={frozen}
          placeholder={nullHint(field)}
          step={field.kind === 'integer' ? 1 : undefined}
          onblur={() => formState.validateTouchedField(field)}
          value={numberFieldValue(field)}
          onValueChange={(next) => formState.updateNumberValue(field, next)}
        />
      {:else if field.kind === 'enum'}
        <Select
          {id}
          {...labelledProps}
          {...hosted ? { size: 'sm' } : {}}
          required={mustHaveText(field)}
          disabled={frozen}
          options={selectOptions(field)}
          value={enumValue(field)}
          onchange={(event) => formState.updateEnum(field, event)}
          onblur={() => formState.validateTouchedField(field)}
        />
      {:else if field.kind === 'boolean' && field.nullable}
        {@render triStateControl(field, id, textOf(field), true, field.description, error)}
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
      {:else}
        <!-- Raw JSON is one editor in every variant, a Cinder JsonEditor. -->
        <JsonEditor
          {id}
          {...labelledProps}
          required={mustHaveText(field)}
          disabled={frozen}
          statusLabel={jsonStatusLabel(field)}
          onblur={() => formState.validateTouchedField(field)}
          value={rawJsonValue(field)}
          onValueChange={(next) => formState.updateRawJsonValue(field, next)}
        />
      {/if}
    </div>
  {/if}
{/snippet}

<svelte:element
  this={bare ? 'div' : 'form'}
  {...rest}
  id={formId}
  bind:this={formElement}
  class={classNames('cinder-schema-form', customClassName)}
  data-cinder-hosted={hosted ? '' : undefined}
  data-cinder-read-only={readOnly ? '' : undefined}
  data-cinder-variant={settingRows ? 'setting-rows' : undefined}
  data-cinder-root-row={rootHosted ? 'host' : undefined}
  data-cinder-root-body={rootBodiless ? 'none' : undefined}
  role={bare ? 'group' : undefined}
  novalidate={bare ? undefined : (novalidate ?? true)}
  onsubmit={bare ? undefined : handleSubmit}
>
  {#if readOnly}
    <SchemaFormReadOnly field={model.field} value={formState.formValue} {secrets} />
  {:else}
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

    {#if rootHosted}
      {@render rootBody()}
    {:else if settingRows && model.field.kind === 'object'}
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
  {/if}
</svelte:element>
