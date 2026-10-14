<script lang="ts">
  /*
   * The foundation value editor (COR-489): dimension, fontFamily, fontWeight, number, duration
   * and cubicBezier tokens. It keeps the generic editor's contract (Shipped and Draft values, an
   * "Apply to" scope, alias and recipe notes with an explicit "Replace with literal", Apply and
   * Reset field) and swaps the raw `$value` text for fields that fit the type.
   *
   * The staged fields hold exactly what was typed. Apply builds the `$value` from them, the
   * runtime validates the whole theme, and only then does anything commit; a rejected edit
   * stays in the fields and in the input buffer while the preview keeps the last-valid value.
   * A slider commits as it moves, and the whole gesture is one history transaction.
   */
  import { Button, Checkbox, Select } from '@lostgradient/cinder';
  import { onDestroy, untrack } from 'svelte';

  import { contextId, inputKey as bufferKey } from './theme-draft-types.ts';
  import ThemeFoundationBezierField from './theme-foundation-bezier-field.svelte';
  import ThemeFoundationFontStack from './theme-foundation-font-stack.svelte';
  import ThemeFoundationScalarField from './theme-foundation-scalar-field.svelte';
  import ThemeFoundationTokenPreview from './theme-foundation-token-preview.svelte';
  import {
    blankFields,
    deserializeFields,
    fieldsFromValue,
    foundationKindOf,
    serializeFields,
    valueFromFields,
    type FoundationFields,
    type FoundationKind,
  } from './theme-foundation-values.ts';
  import {
    buildEdit,
    defaultScope,
    editorMode,
    literalValueOf,
    overrideScopeFor,
    overrideValue,
    scopeOptions,
    sourcePathOf,
    type EditScope,
  } from './theme-token-edit.ts';
  import GenericTokenEditor from './theme-token-editor-generic.svelte';
  import type { TokenEditorProps } from './theme-token-editors.ts';

  let { controller, workbench, row }: TokenEditorProps = $props();

  const kind = $derived(foundationKindOf(row.type) as FoundationKind);

  let scopeChoice = $state<EditScope>(untrack(() => defaultScope(row)));
  let replacing = $state(false);
  let fields = $state.raw<FoundationFields>(untrack(() => blankFields(kind)));
  let gesture = false;

  const draft = $derived(controller.draft);
  const envelope = $derived(draft?.envelope ?? null);
  const scope = $derived(overrideScopeFor(scopeChoice, workbench.context));
  const mode = $derived(envelope === null ? 'literal' : editorMode(row, envelope, scope));
  const key = $derived(
    bufferKey(row.path, scopeChoice === 'shared' ? 'source' : contextId(workbench.context)),
  );
  const idBase = $derived(`theme-builder-foundation-${row.path.replaceAll('.', '-')}`);
  const locked = $derived(controller.lockedPaths.has(row.path));
  const editable = $derived((mode === 'literal' || replacing) && !locked);
  const buffered = $derived(draft?.inputBuffer[key]);
  const options = $derived(scopeOptions(workbench.context));
  const overridden = $derived(controller.changedPaths.has(row.path));

  const contextLabel = $derived(
    scopeChoice === 'shared'
      ? 'shared, all modes'
      : scopeChoice === 'color-mode'
        ? `${workbench.context.colorMode} mode`
        : `${workbench.context.motion} motion`,
  );
  const label = (part: string): string => `${row.name} ${part} (${row.path}, ${contextLabel})`;

  const committedValue = $derived.by(() => {
    if (envelope === null) return undefined;
    const own = scope === null ? undefined : overrideValue(envelope, scope, row.path);
    return own ?? literalValueOf(envelope, workbench.context, row.path);
  });
  const committedFields = $derived(
    committedValue === undefined ? null : fieldsFromValue(kind, committedValue),
  );
  const committedText = $derived(committedFields === null ? '' : serializeFields(committedFields));
  const committedBezier = $derived(
    committedFields?.kind === 'cubicBezier' ? committedFields.points.map(Number) : null,
  );

  const shipped = $derived(controller.shippedValues.get(row.cssProperty) ?? 'Not evaluated yet');
  const current = $derived(controller.draftValues.get(row.cssProperty) ?? 'Not evaluated yet');

  // The fields follow the committed value when the token, scope, context or revision changes,
  // unless the buffer holds text the user has not committed (a restored draft).
  $effect(() => {
    void committedText;
    void key;
    const pending = untrack(() =>
      deserializeFields(kind, controller.draft?.inputBuffer[key]?.text),
    );
    fields = pending ?? committedFields ?? blankFields(kind);
  });

  $effect(() => {
    if (!options.find((option) => option.value === scopeChoice)?.disabled) return;
    scopeChoice = defaultScope(row);
  });

  const dirty = $derived(serializeFields(fields) !== committedText);
  const built = $derived(valueFromFields(row, fields));
  const fieldErrors = $derived(dirty && !built.ok ? built.errors : {});
  const runtimeError = $derived(buffered?.error ?? undefined);

  function edited(next: FoundationFields): void {
    fields = next;
    const text = serializeFields(next);
    if (text === committedText) controller.clearInputBuffer(key);
    else controller.setInputBuffer(key, { text, error: null });
  }

  async function commitFields(next: FoundationFields, label: string): Promise<boolean> {
    if (envelope === null || !editable) return false;
    const value = valueFromFields(row, next);
    if (!value.ok) {
      const message = `${row.path}: ${Object.values(value.errors)[0] ?? 'Invalid value.'}`;
      controller.setInputBuffer(key, { text: serializeFields(next), error: message });
      controller.announcement = message;
      return false;
    }
    const edit = buildEdit(row, envelope, workbench.context, scope, JSON.stringify(value.value));
    if (!edit.ok) {
      const message = `${row.path}: ${edit.message}`;
      controller.setInputBuffer(key, { text: serializeFields(next), error: message });
      controller.announcement = message;
      return false;
    }
    const outcome = await controller.commit({
      kind: 'edit',
      label,
      edit: edit.edit,
      inputKey: key,
    });
    if (outcome.ok) {
      replacing = false;
      return true;
    }
    const message = `${outcome.path ?? row.path}: ${outcome.message}`;
    controller.setInputBuffer(key, { text: serializeFields(next), error: message });
    controller.announcement = message;
    return false;
  }

  function apply(): Promise<boolean> {
    return commitFields(fields, `Edit ${row.name}`);
  }

  function slide(amount: string): void {
    if (fields.kind !== 'number' && fields.kind !== 'fontWeight') return;
    const next = { ...fields, amount };
    fields = next;
    void commitFields(next, `Adjust ${row.name}`);
  }

  const ongesture = {
    begin(): void {
      if (gesture || !editable) return;
      gesture = true;
      controller.beginGesture('edit', `Adjust ${row.name}`);
    },
    end(): void {
      if (!gesture) return;
      gesture = false;
      controller.endGesture();
    },
  };
  onDestroy(() => ongesture.end());

  function replaceWithLiteral(): void {
    if (envelope === null) return;
    const literal = literalValueOf(envelope, workbench.context, row.path);
    const next = literal === undefined ? null : fieldsFromValue(kind, literal);
    replacing = true;
    fields = next ?? blankFields(kind);
    controller.setInputBuffer(key, { text: serializeFields(fields), error: null });
  }

  async function resetField(): Promise<void> {
    const path = envelope === null ? row.path : sourcePathOf(envelope, row.path);
    await controller.reset({ kind: 'field', path }, `Reset ${row.path}`);
    controller.clearInputBuffer(key);
    replacing = false;
  }

  function discard(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || (buffered === undefined && !dirty)) return;
    event.preventDefault();
    event.stopPropagation();
    fields = committedFields ?? blankFields(kind);
    controller.clearInputBuffer(key);
  }
</script>

{#if mode === 'css-only'}
  <GenericTokenEditor {controller} {workbench} {row} />
{:else}
  <div
    class="foundation"
    data-testid="foundation-token-editor"
    data-kind={kind}
    onkeydown={discard}
    role="presentation"
  >
    <dl class="values">
      <div>
        <dt>Shipped</dt>
        <dd><code data-testid="shipped-value">{shipped}</code></dd>
      </div>
      <div>
        <dt>Draft</dt>
        <dd><code data-testid="draft-value">{current}</code></dd>
      </div>
    </dl>

    <ThemeFoundationTokenPreview {row} values={controller.draftValues} />

    <Select
      id={`${idBase}-scope`}
      label="Apply to"
      {options}
      value={scopeChoice}
      onchange={(event) => (scopeChoice = event.currentTarget.value as EditScope)}
    />

    {#if mode === 'alias' && !replacing}
      <p class="note" data-testid="alias-note">
        This token is an alias{row.aliases.length > 0 ? ` of ${row.aliases.join(', ')}` : ''}.
        Editing the literal replaces the alias; it is never severed silently.
      </p>
      <Button label="Replace with literal" variant="secondary" onclick={replaceWithLiteral} />
    {:else if mode === 'recipe' && !replacing}
      <p class="note" data-testid="recipe-note">
        This token's CSS comes from a trusted recipe{row.recipeInputs.length > 0
          ? ` that reads ${row.recipeInputs.join(', ')}`
          : ''}. Replacing it with a literal drops the recipe for this theme.
      </p>
      <Button label="Replace with literal" variant="secondary" onclick={replaceWithLiteral} />
    {:else}
      {#if fields.kind === 'dimension' || fields.kind === 'duration' || fields.kind === 'number' || fields.kind === 'fontWeight'}
        <ThemeFoundationScalarField
          {row}
          {fields}
          errors={{
            ...fieldErrors,
            ...(runtimeError !== undefined && fieldErrors['amount'] === undefined
              ? { amount: runtimeError }
              : {}),
          }}
          {idBase}
          {label}
          disabled={locked}
          onchange={edited}
          onslide={slide}
          {ongesture}
          onenter={() => void apply()}
        />
      {:else if fields.kind === 'fontFamily'}
        <ThemeFoundationFontStack
          {fields}
          errors={fieldErrors}
          {idBase}
          {label}
          disabled={locked}
          onchange={edited}
          announce={(message) => (controller.announcement = message)}
          onenter={() => void apply()}
        />
      {:else if fields.kind === 'cubicBezier'}
        <ThemeFoundationBezierField
          {fields}
          errors={fieldErrors}
          {idBase}
          {label}
          disabled={locked}
          committed={committedBezier}
          onchange={edited}
          onenter={() => void apply()}
        />
      {/if}
      {#if runtimeError !== undefined && (fields.kind === 'fontFamily' || fields.kind === 'cubicBezier')}
        <p class="error" role="alert" data-testid="foundation-error">{runtimeError}</p>
      {/if}
    {/if}

    <Checkbox
      id={`${idBase}-locked`}
      label={`Lock ${row.name} (${row.path})`}
      description="A locked token is skipped by scale presets and cannot be edited here."
      checked={locked}
      onValueChange={(next) => void controller.setLocked(row.path, next)}
    />

    <div class="actions">
      <Button label="Apply" variant="primary" disabled={!editable} onclick={() => void apply()} />
      <Button
        label="Reset field"
        variant="secondary"
        disabled={!overridden || locked}
        onclick={() => void resetField()}
      />
    </div>
  </div>
{/if}

<style>
  .foundation {
    display: grid;
    gap: 12px;
    min-width: 0;
  }
  .values {
    display: grid;
    gap: 4px;
    margin: 0;
    font-size: var(--cinder-text-sm);
  }
  .values > div {
    display: grid;
    grid-template-columns: minmax(5rem, 6rem) minmax(0, 1fr);
    gap: 8px;
  }
  dt {
    color: var(--cinder-text-muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  code {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
  }
  .note,
  .error {
    margin: 0;
    font-size: var(--cinder-text-sm);
  }
  .note {
    color: var(--cinder-text-muted);
  }
  .error {
    color: var(--cinder-text-danger, var(--cinder-text-default));
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  @media (max-width: 479.98px) {
    .actions {
      flex-direction: column;
    }
  }
</style>
