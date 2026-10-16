<script lang="ts">
  /*
   * The composite value editor (COR-488), registered for strokeStyle, border, transition,
   * shadow, gradient and typography. It keeps the typed editors' contract (Shipped and Draft
   * values, an "Apply to" scope, Apply and Reset field) and edits every member of the value:
   * the same numeric, color, font stack and cubic-bezier fields the other editors use, plus
   * ordered layers, stops and dashes with Move up and Move down.
   *
   * The staged fields hold exactly what was typed. Apply builds the `$value` from them, the
   * runtime validates the whole theme, and only then does anything commit; a rejected edit
   * stays in the fields and the input buffer while the preview keeps the last-valid value. A
   * member that is a reference stays a reference, and an unchanged composite is written back
   * byte for byte, so editing one member never rewrites the others or their metadata.
   */
  import { Button, Select } from '@lostgradient/cinder';
  import { untrack } from 'svelte';

  import ThemeDetachControl from './theme-detach-control.svelte';
  import ThemeCompositeLayer from './theme-composite-layer.svelte';
  import ThemeCompositeStroke from './theme-composite-stroke.svelte';
  import {
    blankComposite,
    compositeFromValue,
    compositeToValue,
    DASH_SPEC,
    deserializeComposite,
    isCompositeType,
    MEMBER_SPECS,
    moved,
    newLayer,
    readMember,
    serializeComposite,
    type CompositeFields,
    type CompositeType,
    type Member,
    type MemberSpec,
  } from './theme-composite-values.ts';
  import { contextId, inputKey as bufferKey } from './theme-draft-types.ts';
  import ThemeReorderControls from './theme-reorder-controls.svelte';
  import {
    buildEdit,
    defaultScope,
    editorMode,
    isAliasValue,
    literalValueOf,
    overrideScopeFor,
    overrideValue,
    resolvedValueOf,
    scopeOptions,
    sourcePathOf,
    type EditScope,
  } from './theme-token-edit.ts';
  import type { TokenEditorProps } from './theme-token-editors.ts';

  let { controller, workbench, row }: TokenEditorProps = $props();

  const type = $derived(row.type as CompositeType);

  let scopeChoice = $state<EditScope>(untrack(() => defaultScope(row)));
  let fields = $state.raw<CompositeFields>(
    untrack(() => blankComposite(row.type as CompositeType)),
  );

  const draft = $derived(controller.draft);
  const envelope = $derived(draft?.envelope ?? null);
  const scope = $derived(overrideScopeFor(scopeChoice, workbench.context));
  const mode = $derived(envelope === null ? 'literal' : editorMode(row, envelope, scope));
  const key = $derived(
    bufferKey(row.path, scopeChoice === 'shared' ? 'source' : contextId(workbench.context)),
  );
  const idBase = $derived(`theme-builder-composite-${row.path.replaceAll('.', '-')}`);
  const locked = $derived(controller.lockedPaths.has(row.path));
  const editable = $derived(mode === 'literal' && !locked);
  const buffered = $derived(draft?.inputBuffer[key]);
  const options = $derived(scopeOptions(workbench.context));
  const overridden = $derived(controller.changedPaths.has(row.path));
  const sourceOnly = $derived(row.cssProperty === '');

  const contextLabel = $derived(
    scopeChoice === 'shared'
      ? 'shared, all modes'
      : scopeChoice === 'color-mode'
        ? `${workbench.context.colorMode} mode`
        : `${workbench.context.motion} motion`,
  );
  const subject = $derived(`${row.name} (${row.path}, ${contextLabel})`);

  const committedValue = $derived.by(() => {
    if (envelope === null) return undefined;
    const own = scope === null ? undefined : overrideValue(envelope, scope, row.path);
    return own ?? literalValueOf(envelope, workbench.context, row.path);
  });
  const committedFields = $derived(
    committedValue === undefined || !isCompositeType(row.type)
      ? null
      : compositeFromValue(type, committedValue),
  );
  const committedText = $derived(
    committedFields === null ? '' : serializeComposite(committedFields),
  );
  const unreadable = $derived(committedValue !== undefined && committedFields === null);

  const shipped = $derived(
    sourceOnly
      ? 'Source only; no CSS value'
      : (controller.shippedValues.get(row.cssProperty) ?? 'Not evaluated yet'),
  );
  const current = $derived(
    sourceOnly
      ? 'Source only; no CSS value'
      : (controller.draftValues.get(row.cssProperty) ?? 'Not evaluated yet'),
  );

  // The fields follow the committed value when the token, scope, context or revision changes,
  // unless the buffer holds text the user has not committed (a restored draft).
  $effect(() => {
    void committedText;
    void key;
    const pending = untrack(() =>
      deserializeComposite(type, controller.draft?.inputBuffer[key]?.text),
    );
    fields = pending ?? committedFields ?? blankComposite(type);
  });

  $effect(() => {
    if (!options.find((option) => option.value === scopeChoice)?.disabled) return;
    scopeChoice = defaultScope(row);
  });

  const dirty = $derived(serializeComposite(fields) !== committedText);
  const built = $derived(compositeToValue(fields));
  const fieldErrors = $derived(dirty && !built.ok ? built.errors : {});
  const problem = $derived(buffered?.error ?? Object.values(fieldErrors)[0]);

  const announce = (message: string): void => {
    controller.announcement = message;
  };

  function edited(next: CompositeFields): void {
    fields = next;
    const text = serializeComposite(next);
    if (text === committedText) controller.clearInputBuffer(key);
    else controller.setInputBuffer(key, { text, error: null });
  }

  async function apply(): Promise<boolean> {
    if (envelope === null || !editable) return false;
    const value = compositeToValue(fields);
    if (!value.ok) {
      const message = `${row.path}: ${Object.values(value.errors)[0] ?? 'Invalid value.'}`;
      controller.setInputBuffer(key, { text: serializeComposite(fields), error: message });
      announce(message);
      return false;
    }
    const edit = buildEdit(row, envelope, workbench.context, scope, JSON.stringify(value.value));
    if (!edit.ok) {
      const message = `${row.path}: ${edit.message}`;
      controller.setInputBuffer(key, { text: serializeComposite(fields), error: message });
      announce(message);
      return false;
    }
    const outcome = await controller.commit({
      kind: 'edit',
      label: `Edit ${row.name}`,
      edit: edit.edit,
      inputKey: key,
    });
    if (outcome.ok) return true;
    const message = `${outcome.path ?? row.path}: ${outcome.message}`;
    controller.setInputBuffer(key, { text: serializeComposite(fields), error: message });
    announce(message);
    return false;
  }

  async function resetField(): Promise<void> {
    const path = envelope === null ? row.path : sourcePathOf(envelope, row.path);
    await controller.reset({ kind: 'field', path }, `Reset ${row.path}`);
    controller.clearInputBuffer(key);
  }

  /** What stands in for a reference member when the author replaces it: its resolved value. */
  function literalFor(member: Member, spec: MemberSpec): Member {
    if (member.kind !== 'ref' || envelope === null) return member;
    const target = isAliasValue(member.value) ? member.value.slice(1, -1) : undefined;
    const resolved =
      target === undefined ? undefined : resolvedValueOf(envelope, workbench.context, target);
    return readMember(spec, resolved);
  }

  function discard(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || (buffered === undefined && !dirty)) return;
    event.preventDefault();
    event.stopPropagation();
    fields = committedFields ?? blankComposite(type);
    controller.clearInputBuffer(key);
  }

  const enter = (): void => void apply();
  const layerLabel = (kind: 'shadow' | 'gradient'): string =>
    kind === 'shadow' ? 'Shadow layer' : 'Gradient stop';
</script>

<div
  class="composite"
  data-testid="composite-token-editor"
  data-kind={type}
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

  <Select
    id={`${idBase}-scope`}
    label="Apply to"
    {options}
    value={scopeChoice}
    onchange={(event) => (scopeChoice = event.currentTarget.value as EditScope)}
  />

  {#if mode === 'alias'}
    <p class="note" data-testid="alias-note">
      This token is an alias{row.aliases.length > 0 ? ` of ${row.aliases.join(', ')}` : ''}. Rebind
      it under References, or replace it with a literal after seeing every change; it is never
      severed silently.
    </p>
    <ThemeDetachControl {controller} {workbench} {row} {scope} disabled={locked} />
  {:else if mode === 'recipe'}
    <p class="note" data-testid="recipe-note">
      This token's CSS comes from a trusted recipe. Change its inputs or give it a CSS value under
      References, or replace it with a literal after seeing every change.
    </p>
    <ThemeDetachControl {controller} {workbench} {row} {scope} disabled={locked} />
  {:else if unreadable}
    <p class="note" data-testid="unreadable-note">
      This token's value is not shaped like a {type}, so it is preserved as written and cannot be
      edited here.
    </p>
  {:else}
    {#if fields.type === 'strokeStyle'}
      <ThemeCompositeStroke
        stroke={fields.stroke}
        at="stroke"
        errors={fieldErrors}
        {idBase}
        subject={`${subject} stroke`}
        disabled={locked}
        onchange={(stroke) => edited({ type: 'strokeStyle', stroke })}
        literalFor={(member) => literalFor(member, DASH_SPEC)}
        {announce}
        onenter={enter}
      />
    {:else if fields.type === 'shadow' || fields.type === 'gradient'}
      {@const kind = fields.type}
      {@const list = fields}
      <ol class="layers">
        {#each list.layers as layer, index (index)}
          {@const name = `${layerLabel(kind)} ${index + 1}`}
          <li class="layer" data-testid="composite-layer">
            <h4 class="layer__title">{name} of {list.layers.length}</h4>
            <ThemeReorderControls
              subject={name}
              {index}
              count={list.layers.length}
              idBase={`${idBase}-layer`}
              disabled={locked}
              canRemove={list.layers.length > (kind === 'gradient' ? 2 : 1)}
              onmove={(delta) => edited({ ...list, layers: moved(list.layers, index, delta) })}
              onremove={() =>
                edited({ ...list, layers: list.layers.filter((_, at) => at !== index) })}
              {announce}
            />
            <ThemeCompositeLayer
              specs={MEMBER_SPECS[kind]}
              {layer}
              at={`layers.${index}.`}
              errors={fieldErrors}
              idBase={`${idBase}-layer-${index}`}
              subject={`${subject} ${name.toLowerCase()}`}
              disabled={locked}
              onchange={(next) =>
                edited({
                  ...list,
                  layers: list.layers.map((entry, at) => (at === index ? next : entry)),
                })}
              {literalFor}
              {announce}
              onenter={enter}
            />
          </li>
        {/each}
      </ol>
      {#if fieldErrors['layers'] !== undefined}
        <p class="error" role="alert">{fieldErrors['layers']}</p>
      {/if}
      <Button
        id={`${idBase}-add-layer`}
        label={kind === 'shadow' ? 'Add layer' : 'Add stop'}
        aria-label={`Add a ${layerLabel(kind).toLowerCase()} to ${subject}`}
        variant="secondary"
        disabled={locked}
        onclick={() => {
          edited({ ...list, layers: [...list.layers, newLayer(kind)] });
          announce(`Added ${layerLabel(kind).toLowerCase()} ${list.layers.length + 1}`);
        }}
      />
    {:else}
      {@const single = fields.type}
      <ThemeCompositeLayer
        specs={MEMBER_SPECS[single]}
        layer={fields.layer}
        at=""
        errors={fieldErrors}
        {idBase}
        {subject}
        disabled={locked}
        onchange={(layer) => edited({ type: single, layer })}
        {literalFor}
        {announce}
        onenter={enter}
      />
    {/if}

    {#if problem !== undefined}
      <p class="error" role="alert" data-testid="composite-error">{problem}</p>
    {/if}
  {/if}

  <div class="actions">
    <Button
      label="Apply"
      variant="primary"
      disabled={!editable || unreadable || !dirty}
      onclick={() => void apply()}
    />
    <Button
      label="Reset field"
      variant="secondary"
      disabled={!overridden || locked}
      onclick={() => void resetField()}
    />
  </div>
</div>

<style>
  .composite,
  .layers {
    display: grid;
    gap: 12px;
    min-width: 0;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .layer {
    display: grid;
    gap: 12px;
    padding: 12px;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
  }
  .layer__title {
    margin: 0;
    font-size: var(--cinder-text-sm);
    font-weight: var(--cinder-font-semibold);
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
    color: var(--cinder-status-danger-text, var(--cinder-text-default));
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
