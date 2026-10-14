<script lang="ts">
  /*
   * The color editor (COR-263), registered for every color record. The visual picker, the
   * text field, and the numeric channel controls all edit one working value: the authored DTCG
   * color, in the space it is authored in. Apply validates through the runtime and commits one
   * transaction; an invalid text stays in its field and the input buffer and never reaches the
   * preview. A value outside sRGB, or authored in another space such as Display P3, is never
   * converted or clamped by the picker: the picker previews it, and editing through the picker
   * is an explicit choice that writes OKLCH. An alias stays linked until the user detaches it.
   */
  import { Button, ColorPicker, Input, Select } from '@lostgradient/cinder';
  import { untrack } from 'svelte';

  import ThemeColorChannels from './theme-color-channels.svelte';
  import ThemeColorSummary from './theme-color-summary.svelte';
  import {
    aliasTargets,
    colorFromPicker,
    committedColor,
    pickerBinding,
  } from './theme-color-editing.ts';
  import {
    authoredSpaces,
    authoredText,
    colorToJson,
    convertTo,
    parseColorText,
    readDtcgColor,
    sameColor,
    spaceDefinition,
    type DtcgColor,
  } from './theme-color-model.ts';
  import { contextId, inputKey as bufferKey } from './theme-draft-types.ts';
  import { createEnvelope } from './theme-envelope.ts';
  import GenericTokenEditor from './theme-token-editor-generic.svelte';
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
  import type { TokenEditorProps } from './theme-token-editors.ts';

  let { controller, workbench, row }: TokenEditorProps = $props();

  let scopeChoice = $state<EditScope>(untrack(() => defaultScope(row)));
  let working = $state<DtcgColor | null>(null);
  let detaching = $state(false);
  let pickerEngaged = $state(false);
  let textError = $state<string | null>(null);
  let notice = $state<string | null>(null);

  const idBase = $derived(`theme-builder-color-${row.path.replaceAll('.', '-')}`);
  const draft = $derived(controller.draft);
  const envelope = $derived(draft?.envelope ?? null);
  const context = $derived(workbench.context);
  const scope = $derived(overrideScopeFor(scopeChoice, context));
  const mode = $derived(envelope === null ? 'literal' : editorMode(row, envelope, scope));
  const committed = $derived(
    envelope === null ? null : committedColor(row, envelope, context, scope),
  );
  const shown = $derived(working ?? committed);
  const dirty = $derived(detaching || (working !== null && !sameColor(working, committed)));
  const shipped = $derived.by(() => {
    if (envelope === null) return null;
    const base = createEnvelope('shipped', 'Cinder default', envelope.base);
    return readDtcgColor(literalValueOf(base, context, row.path));
  });
  const key = $derived(
    bufferKey(row.path, scopeChoice === 'shared' ? 'source' : contextId(context)),
  );
  const buffered = $derived(draft?.inputBuffer[key]);
  const options = $derived(scopeOptions(context));
  const subject = $derived(`${row.path} (${context.colorMode})`);
  const linked = $derived(mode === 'alias' || mode === 'recipe' ? !detaching : false);
  const aliasOf = $derived(
    envelope === null || scope === null
      ? []
      : aliasTargets(row, overrideValue(envelope, scope, row.path)),
  );
  const binding = $derived(shown === null ? null : pickerBinding(shown));
  const pickerUsable = $derived(binding !== null && (binding.direct || pickerEngaged));
  const shippedCss = $derived(controller.shippedValues.get(row.cssProperty) ?? 'Not evaluated yet');
  const draftCss = $derived(controller.draftValues.get(row.cssProperty) ?? 'Not evaluated yet');
  const overridden = $derived(controller.changedPaths.has(row.path));
  const text = $derived(buffered?.text ?? (shown === null ? '' : authoredText(shown)));
  const error = $derived(buffered?.error ?? textError ?? undefined);

  // The controls follow the committed value when the token, scope, context or revision
  // changes, unless the buffer holds text the user has not committed (a restored draft).
  $effect(() => {
    void committed;
    void key;
    working = null;
    textError = null;
    notice = null;
    pickerEngaged = false;
    detaching = false;
    const pending = untrack(() => controller.draft?.inputBuffer[key]);
    if (pending !== undefined) {
      const parsed = parseColorText(pending.text);
      if (parsed.ok) working = parsed.color;
    }
  });

  $effect(() => {
    if (!options.find((option) => option.value === scopeChoice)?.disabled) return;
    scopeChoice = defaultScope(row);
  });

  /** One working value feeds every control; a change clears any text error. */
  function setWorking(next: DtcgColor): void {
    working = next;
    textError = null;
    notice = null;
    if (committed !== null && sameColor(next, committed)) controller.clearInputBuffer(key);
    else controller.setInputBuffer(key, { text: authoredText(next), error: null });
  }

  function editText(next: string): void {
    const parsed = parseColorText(next);
    if (parsed.ok) {
      working = parsed.color;
      textError = null;
      controller.setInputBuffer(key, { text: next, error: null });
    } else {
      textError = parsed.message;
      controller.setInputBuffer(key, { text: next, error: `${row.path}: ${parsed.message}` });
    }
  }

  function picked(value: string): void {
    if (binding === null) return;
    const writeSpace = binding.direct ? binding.writeSpace : 'oklch';
    const next = colorFromPicker(value, writeSpace);
    if (next === null) return;
    if (!binding.direct) notice = 'Edited through the picker: the value is now written as OKLCH.';
    setWorking(next);
  }

  function engagePicker(): void {
    pickerEngaged = true;
    notice = 'Picker edits will be written as OKLCH. The current value stays until you edit.';
  }

  function changeSpace(space: string): void {
    if (shown === null) return;
    const converted = convertTo(shown, space);
    if (converted === null) return;
    setWorking(converted);
    notice = `Converted from ${spaceDefinition(shown.colorSpace)?.label ?? shown.colorSpace} to ${spaceDefinition(space)?.label ?? space}. The source changes only when you apply.`;
  }

  function detach(): void {
    if (envelope === null) return;
    const literal = readDtcgColor(literalValueOf(envelope, context, row.path));
    detaching = true;
    if (literal !== null) setWorking(literal);
    notice =
      mode === 'alias'
        ? `Detached from ${aliasOf.join(', ') || 'its alias'}. The alias is replaced only when you apply; undo restores the link.`
        : 'The recipe is replaced only when you apply; undo restores it.';
  }

  async function apply(): Promise<void> {
    if (envelope === null || working === null || textError !== null) return;
    const built = buildEdit(row, envelope, context, scope, JSON.stringify(colorToJson(working)));
    if (!built.ok) {
      controller.setInputBuffer(key, { text, error: `${row.path}: ${built.message}` });
      controller.announcement = `${row.path}: ${built.message}`;
      return;
    }
    const outcome = await controller.commit({
      kind: 'edit',
      label: `Edit ${row.name}`,
      edit: built.edit,
      inputKey: key,
    });
    if (!outcome.ok) {
      const message = `${outcome.path ?? row.path}: ${outcome.message}`;
      controller.setInputBuffer(key, { text, error: message });
      controller.announcement = message;
    }
  }

  async function resetField(): Promise<void> {
    const path = envelope === null ? row.path : sourcePathOf(envelope, row.path);
    await controller.reset({ kind: 'field', path }, `Reset ${row.path}`);
    controller.clearInputBuffer(key);
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      void apply();
    } else if (event.key === 'Escape' && (buffered !== undefined || dirty)) {
      event.preventDefault();
      event.stopPropagation();
      working = null;
      controller.clearInputBuffer(key);
    }
  }
</script>

{#if mode === 'css-only' || shown === null}
  <GenericTokenEditor {controller} {workbench} {row} />
{:else}
  <div class="color-editor" data-testid="color-token-editor">
    <dl class="values">
      <div>
        <dt>Shipped</dt>
        <dd><code data-testid="shipped-value">{shippedCss}</code></dd>
      </div>
      <div>
        <dt>Draft</dt>
        <dd><code data-testid="draft-value">{draftCss}</code></dd>
      </div>
    </dl>

    <Select
      id={`${idBase}-scope`}
      label="Apply to"
      {options}
      value={scopeChoice}
      onchange={(event) => (scopeChoice = event.currentTarget.value as EditScope)}
    />

    {#if envelope !== null}
      <ThemeColorSummary
        {row}
        {envelope}
        {context}
        color={shown}
        onFollow={(path) => workbench.followToken(path, row.path)}
      />
    {/if}

    {#if linked}
      <p class="note" data-testid={mode === 'alias' ? 'alias-note' : 'recipe-note'}>
        {#if mode === 'alias'}
          This token is linked to {aliasOf.length > 0 ? aliasOf.join(', ') : 'another token'} and shows
          its resolved color. It stays linked until you detach it.
        {:else}
          A trusted CSS recipe derives this color{row.recipeInputs.length > 0
            ? ` from ${row.recipeInputs.join(', ')}`
            : ''}. It stays derived until you replace it with a literal color.
        {/if}
      </p>
      <Button
        label={mode === 'alias' ? 'Detach alias' : 'Replace recipe with literal color'}
        variant="secondary"
        onclick={detach}
      />
    {:else}
      <div class="editing" onkeydown={keydown} role="presentation">
        <Input
          id={`${idBase}-text`}
          label="Color value"
          description="A literal color in the space you type it in, for example oklch(0.5 0.22 270) or color(display-p3 1 0 0)."
          value={text}
          {...error === undefined ? {} : { error }}
          onValueChange={editText}
        />

        <Select
          id={`${idBase}-space`}
          label="Authored color space"
          options={authoredSpaces().map((space) => ({ value: space.space, label: space.label }))}
          value={shown.colorSpace}
          onchange={(event) => changeSpace(event.currentTarget.value)}
        />

        <ThemeColorChannels
          color={shown}
          {shipped}
          {subject}
          idPrefix={idBase}
          onChange={setWorking}
        />

        {#if binding !== null}
          <div class="picker" data-testid="color-picker-region">
            <ColorPicker
              label={`Color picker for ${subject}`}
              alpha
              format="oklch"
              value={binding.value}
              disabled={!pickerUsable}
              onValueCommit={picked}
            />
            {#if !binding.direct}
              <p class="note" data-testid="picker-preview-note">{binding.reason}</p>
              {#if !pickerEngaged}
                <Button
                  label="Edit with the picker (writes OKLCH)"
                  variant="secondary"
                  onclick={engagePicker}
                />
              {/if}
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    {#if notice !== null}
      <p class="note" role="status" data-testid="color-editor-notice">{notice}</p>
    {/if}

    <div class="actions">
      <Button
        label="Apply"
        variant="primary"
        disabled={!dirty || textError !== null}
        onclick={() => void apply()}
      />
      <Button
        label="Reset field"
        variant="secondary"
        disabled={!overridden}
        onclick={() => void resetField()}
      />
    </div>
  </div>
{/if}

<style>
  .color-editor,
  .editing,
  .picker {
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
  .note {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
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
