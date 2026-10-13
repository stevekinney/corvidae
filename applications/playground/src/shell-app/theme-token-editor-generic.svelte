<script lang="ts">
  /*
   * The generic value editor: the fallback editing path for any token (COR-490, COR-261).
   * It shows the Shipped and Draft values, a scope selector, and one labeled field for the
   * token's DTCG `$value` (or its CSS value, for a CSS-only token). Apply validates through
   * the runtime before anything commits; invalid input stays in the field and the input
   * buffer and never reaches the preview. An alias or a recipe is shown as such and becomes a
   * literal only through an explicit "Replace with literal".
   *
   * The typed editors (COR-489, COR-263, COR-488) replace this per DTCG type through
   * `editorForToken`; the rules they share live in `theme-token-edit.ts`.
   */
  import { Button, Input, Select } from '@lostgradient/cinder';
  import { untrack } from 'svelte';

  import { contextId, inputKey as bufferKey } from './theme-draft-types.ts';
  import {
    buildEdit,
    defaultScope,
    editorMode,
    initialValueText,
    literalValueOf,
    overrideScopeFor,
    scopeOptions,
    sourcePathOf,
    valueToText,
    type EditScope,
  } from './theme-token-edit.ts';
  import type { TokenEditorProps } from './theme-token-editors.ts';

  let { controller, workbench, row }: TokenEditorProps = $props();

  let scopeChoice = $state<EditScope>(untrack(() => defaultScope(row)));
  let replacing = $state(false);
  let text = $state('');
  let localError = $state<string | null>(null);

  const draft = $derived(controller.draft);
  const envelope = $derived(draft?.envelope ?? null);
  const scope = $derived(overrideScopeFor(scopeChoice, workbench.context));
  const mode = $derived(envelope === null ? 'literal' : editorMode(row, envelope, scope));
  const key = $derived(
    bufferKey(row.path, scopeChoice === 'shared' ? 'source' : contextId(workbench.context)),
  );
  const fieldId = $derived(`theme-builder-value-${row.path.replaceAll('.', '-')}`);
  const editable = $derived(mode === 'literal' || mode === 'css-only' || replacing);
  const buffered = $derived(draft?.inputBuffer[key]);
  const error = $derived(buffered?.error ?? localError ?? undefined);
  const committedText = $derived(
    envelope === null ? '' : initialValueText(row, envelope, workbench.context, scope),
  );
  const shipped = $derived(
    row.edit === 'css-only' && row.shippedCssValue !== undefined
      ? row.shippedCssValue
      : (controller.shippedValues.get(row.cssProperty) ?? 'Not evaluated yet'),
  );
  const current = $derived(controller.draftValues.get(row.cssProperty) ?? 'Not evaluated yet');
  const overridden = $derived(controller.changedPaths.has(row.path));
  const options = $derived(scopeOptions(workbench.context));

  // The field follows the committed value when the token, scope, context or revision
  // changes, unless the buffer holds text the user has not committed (a restored draft).
  $effect(() => {
    void committedText;
    void key;
    const pending = untrack(() => controller.draft?.inputBuffer[key]);
    text = pending?.text ?? committedText;
    localError = null;
  });

  $effect(() => {
    if (!options.find((option) => option.value === scopeChoice)?.disabled) return;
    scopeChoice = defaultScope(row);
  });

  function edited(next: string): void {
    text = next;
    localError = null;
    if (next === committedText) controller.clearInputBuffer(key);
    else controller.setInputBuffer(key, { text: next, error: null });
  }

  async function apply(): Promise<void> {
    if (envelope === null || !editable) return;
    const built = buildEdit(row, envelope, workbench.context, scope, text);
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
    if (outcome.ok) {
      replacing = false;
      localError = null;
    } else {
      const message = `${outcome.path ?? row.path}: ${outcome.message}`;
      controller.setInputBuffer(key, { text, error: message });
      controller.announcement = message;
    }
  }

  function replaceWithLiteral(): void {
    if (envelope === null) return;
    const literal = literalValueOf(envelope, workbench.context, row.path);
    replacing = true;
    text = literal === undefined ? '' : valueToText(literal);
    controller.setInputBuffer(key, { text, error: null });
  }

  async function resetField(): Promise<void> {
    const path = envelope === null ? row.path : sourcePathOf(envelope, row.path);
    await controller.reset({ kind: 'field', path }, `Reset ${row.path}`);
    controller.clearInputBuffer(key);
    replacing = false;
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      void apply();
    } else if (event.key === 'Escape' && (buffered !== undefined || text !== committedText)) {
      event.preventDefault();
      event.stopPropagation();
      text = committedText;
      controller.clearInputBuffer(key);
    }
  }
</script>

<div class="generic" data-testid="generic-token-editor">
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

  {#if mode !== 'css-only'}
    <Select
      id={`${fieldId}-scope`}
      label="Apply to"
      {options}
      value={scopeChoice}
      onchange={(event) => (scopeChoice = event.currentTarget.value as EditScope)}
    />
  {/if}

  {#if mode === 'alias' && !replacing}
    <p class="note" data-testid="alias-note">
      This token is an alias{row.aliases.length > 0 ? ` of ${row.aliases.join(', ')}` : ''}. Editing
      the literal replaces the alias; it is never severed silently.
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
    <div class="field" onkeydown={keydown} role="presentation">
      <Input
        id={fieldId}
        label={mode === 'css-only' ? 'CSS value' : 'Value ($value)'}
        description={mode === 'css-only'
          ? 'A plain CSS value for the current context. It is stored as a CSS-only edit.'
          : 'The token’s DTCG $value as authored, for example {"value": 4, "unit": "px"}.'}
        value={text}
        {...error === undefined ? {} : { error }}
        onValueChange={edited}
      />
    </div>
  {/if}

  <div class="actions">
    <Button label="Apply" variant="primary" disabled={!editable} onclick={() => void apply()} />
    <Button
      label="Reset field"
      variant="secondary"
      disabled={!overridden}
      onclick={() => void resetField()}
    />
  </div>
</div>

<style>
  .generic {
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
